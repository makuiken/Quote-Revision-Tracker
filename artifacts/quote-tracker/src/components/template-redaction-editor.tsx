import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Copy,
  FileImage,
  Loader2,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type TemplateEditorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
};

/**
 * A page passed to the editor. sourceUrl and cleanedUrl are intentionally
 * client-only fields: the API stores page geometry, while the admin draft
 * endpoints provide private preview bytes separately.
 */
export type TemplateEditorPage = {
  pageNumber: number;
  width: number;
  height: number;
  rects: TemplateEditorRect[];
  sourceUrl?: string | null;
  cleanedUrl?: string | null;
  sourceLoading?: boolean;
  sourceError?: string | null;
  cleanedLoading?: boolean;
};

type EditorMode = "source" | "cleaned";

export type TemplateRedactionEditorProps = {
  pages: TemplateEditorPage[];
  mode?: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
  onChange: (pages: TemplateEditorPage[]) => void;
  disabled?: boolean;
  sourceUnavailableMessage?: string;
  cleanedUnavailableMessage?: string;
  onRetrySource?: () => void;
  className?: string;
};

type PointerOperation =
  | {
      type: "draw";
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    }
  | {
      type: "move" | "resize";
      index: number;
      startX: number;
      startY: number;
      startRect: TemplateEditorRect;
    };

const MIN_BOX_SIZE = 10;
const SAME_DIMENSION_TOLERANCE = 10;

function sameDimensions(first: TemplateEditorPage, second: TemplateEditorPage) {
  return (
    Math.abs(first.width - second.width) < SAME_DIMENSION_TOLERANCE &&
    Math.abs(first.height - second.height) < SAME_DIMENSION_TOLERANCE
  );
}

function pageWithRects(
  pages: TemplateEditorPage[],
  pageNumber: number,
  rects: TemplateEditorRect[],
) {
  return pages.map((page) =>
    page.pageNumber === pageNumber ? { ...page, rects } : page,
  );
}

/**
 * Shared source/cleaned page editor for template authoring. It deliberately
 * owns only draft geometry; callers decide when and how to persist it.
 */
export function TemplateRedactionEditor({
  pages,
  mode: controlledMode,
  onModeChange,
  onChange,
  disabled = false,
  sourceUnavailableMessage = "The original sample is unavailable. Replace the sample to edit its page preview.",
  cleanedUnavailableMessage = "Generate a cleaned preview to inspect the final result.",
  onRetrySource,
  className = "",
}: TemplateRedactionEditorProps) {
  const [uncontrolledMode, setUncontrolledMode] =
    useState<EditorMode>("source");
  const mode = controlledMode ?? uncontrolledMode;
  const [currentPageNumber, setCurrentPageNumber] = useState<number | null>(
    pages[0]?.pageNumber ?? null,
  );
  const [zoom, setZoom] = useState(1);
  const [baseScale, setBaseScale] = useState(1);
  const [operation, setOperation] = useState<PointerOperation | null>(null);
  const operationRef = useRef<PointerOperation | null>(null);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyIndex, setCopyIndex] = useState<number | null>(null);
  const [copyTargets, setCopyTargets] = useState<number[]>([]);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const currentPage = useMemo(
    () =>
      pages.find((page) => page.pageNumber === currentPageNumber) ??
      pages[0] ??
      null,
    [currentPageNumber, pages],
  );

  useEffect(() => {
    if (pages.length === 0) {
      setCurrentPageNumber(null);
      return;
    }
    if (!pages.some((page) => page.pageNumber === currentPageNumber)) {
      setCurrentPageNumber(pages[0].pageNumber);
    }
  }, [currentPageNumber, pages]);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (currentPage && width > 0) {
        setBaseScale(
          Math.max(0.2, Math.min((width - 48) / currentPage.width, 1.5)),
        );
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [currentPage]);

  useEffect(() => {
    operationRef.current = null;
    setOperation(null);
  }, [currentPageNumber, mode]);

  const updateOperation = (
    next:
      | PointerOperation
      | null
      | ((previous: PointerOperation | null) => PointerOperation | null),
  ) => {
    const resolved =
      typeof next === "function" ? next(operationRef.current) : next;
    operationRef.current = resolved;
    setOperation(resolved);
  };

  const setEditorMode = (nextMode: EditorMode) => {
    if (nextMode === mode) return;
    if (controlledMode === undefined) setUncontrolledMode(nextMode);
    onModeChange?.(nextMode);
  };

  const scale = baseScale * zoom;
  const currentRects = currentPage?.rects ?? [];
  const currentSourceUrl = currentPage?.sourceUrl ?? null;
  const currentCleanedUrl = currentPage?.cleanedUrl ?? null;

  const coordinatesForEvent = (
    event: ReactPointerEvent<HTMLDivElement>,
    page: TemplateEditorPage,
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(page.width, (event.clientX - bounds.left) / scale),
      ),
      y: Math.max(
        0,
        Math.min(page.height, (event.clientY - bounds.top) / scale),
      ),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || mode !== "source" || !currentPage || event.button !== 0)
      return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    if (target.closest("button, [data-editor-control]")) return;

    const point = coordinatesForEvent(event, currentPage);
    const resizeHandle = target.closest(
      "[data-resize-handle]",
    ) as HTMLElement | null;
    if (resizeHandle) {
      const index = Number(resizeHandle.dataset.index);
      const startRect = currentRects[index];
      if (!startRect) return;
      updateOperation({
        type: "resize",
        index,
        startX: point.x,
        startY: point.y,
        startRect,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
      return;
    }

    const existingRect = target.closest(
      "[data-rect-index]",
    ) as HTMLElement | null;
    if (existingRect) {
      const index = Number(existingRect.dataset.rectIndex);
      const startRect = currentRects[index];
      if (!startRect) return;
      updateOperation({
        type: "move",
        index,
        startX: point.x,
        startY: point.y,
        startRect,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
      return;
    }

    updateOperation({
      type: "draw",
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const activeOperation = operationRef.current;
    if (disabled || !currentPage || !activeOperation) return;
    event.preventDefault();
    const point = coordinatesForEvent(event, currentPage);

    if (activeOperation.type === "draw") {
      updateOperation((previous) =>
        previous?.type === "draw"
          ? { ...previous, currentX: point.x, currentY: point.y }
          : previous,
      );
      return;
    }

    const dx = point.x - activeOperation.startX;
    const dy = point.y - activeOperation.startY;
    const nextRects = [...currentRects];
    if (activeOperation.type === "move") {
      nextRects[activeOperation.index] = {
        ...activeOperation.startRect,
        x: Math.max(
          0,
          Math.min(
            currentPage.width - activeOperation.startRect.width,
            activeOperation.startRect.x + dx,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            currentPage.height - activeOperation.startRect.height,
            activeOperation.startRect.y + dy,
          ),
        ),
      };
    } else {
      nextRects[activeOperation.index] = {
        ...activeOperation.startRect,
        width: Math.max(
          MIN_BOX_SIZE,
          Math.min(
            currentPage.width - activeOperation.startRect.x,
            activeOperation.startRect.width + dx,
          ),
        ),
        height: Math.max(
          MIN_BOX_SIZE,
          Math.min(
            currentPage.height - activeOperation.startRect.y,
            activeOperation.startRect.height + dy,
          ),
        ),
      };
    }
    onChange(pageWithRects(pages, currentPage.pageNumber, nextRects));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const hadPointerCapture = event.currentTarget.hasPointerCapture(
      event.pointerId,
    );
    if (hadPointerCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const activeOperation = operationRef.current;
    if (!currentPage || !activeOperation) {
      updateOperation(null);
      return;
    }

    // Read the final pointer coordinates directly. React may batch the last
    // pointermove behind pointerup, which previously made a valid fresh draw
    // appear to have zero size after a move/resize/delete sequence.
    const endPoint = coordinatesForEvent(event, currentPage);
    if (activeOperation.type === "draw") {
      const width = Math.abs(endPoint.x - activeOperation.startX);
      const height = Math.abs(endPoint.y - activeOperation.startY);
      if (width >= MIN_BOX_SIZE && height >= MIN_BOX_SIZE) {
        onChange(
          pageWithRects(pages, currentPage.pageNumber, [
            ...currentRects,
            {
              x: Math.min(activeOperation.startX, endPoint.x),
              y: Math.min(activeOperation.startY, endPoint.y),
              width,
              height,
              reason: "Manual redaction",
            },
          ]),
        );
      }
    } else {
      const dx = endPoint.x - activeOperation.startX;
      const dy = endPoint.y - activeOperation.startY;
      const nextRects = [...currentRects];
      if (activeOperation.type === "move") {
        nextRects[activeOperation.index] = {
          ...activeOperation.startRect,
          x: Math.max(
            0,
            Math.min(
              currentPage.width - activeOperation.startRect.width,
              activeOperation.startRect.x + dx,
            ),
          ),
          y: Math.max(
            0,
            Math.min(
              currentPage.height - activeOperation.startRect.height,
              activeOperation.startRect.y + dy,
            ),
          ),
        };
      } else {
        nextRects[activeOperation.index] = {
          ...activeOperation.startRect,
          width: Math.max(
            MIN_BOX_SIZE,
            Math.min(
              currentPage.width - activeOperation.startRect.x,
              activeOperation.startRect.width + dx,
            ),
          ),
          height: Math.max(
            MIN_BOX_SIZE,
            Math.min(
              currentPage.height - activeOperation.startRect.y,
              activeOperation.startRect.height + dy,
            ),
          ),
        };
      }
      onChange(pageWithRects(pages, currentPage.pageNumber, nextRects));
    }
    updateOperation(null);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateOperation(null);
  };

  const removeRect = (index: number) => {
    if (!currentPage || disabled) return;
    // A delete can happen while a captured move/resize pointer is finishing.
    // Clear that operation before removing its indexed rectangle so the next
    // pointer-down starts a fresh draw rather than targeting a stale index.
    updateOperation(null);
    onChange(
      pageWithRects(
        pages,
        currentPage.pageNumber,
        currentRects.filter((_, rectIndex) => rectIndex !== index),
      ),
    );
  };

  const openCopyDialog = (index: number) => {
    if (!currentPage || disabled) return;
    setCopyIndex(index);
    setCopyTargets(
      pages
        .filter(
          (page) =>
            page.pageNumber !== currentPage.pageNumber &&
            sameDimensions(page, currentPage),
        )
        .map((page) => page.pageNumber),
    );
    setCopyDialogOpen(true);
  };

  const applyCopy = () => {
    if (!currentPage || copyIndex === null || copyTargets.length === 0) return;
    const rect = currentRects[copyIndex];
    if (!rect) return;
    const targetSet = new Set(copyTargets);
    const nextPages = pages.map((page) => {
      if (!targetSet.has(page.pageNumber)) return page;
      const alreadyCopied = page.rects.some(
        (existing) =>
          Math.abs(existing.x - rect.x) < 0.5 &&
          Math.abs(existing.y - rect.y) < 0.5 &&
          Math.abs(existing.width - rect.width) < 0.5 &&
          Math.abs(existing.height - rect.height) < 0.5,
      );
      return alreadyCopied
        ? page
        : { ...page, rects: [...page.rects, { ...rect }] };
    });
    onChange(nextPages);
    setCopyDialogOpen(false);
    setCopyIndex(null);
    setCopyTargets([]);
  };

  if (!currentPage) {
    return (
      <div
        className={`flex min-h-[420px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center ${className}`}
        data-testid="empty-template-editor"
      >
        <div>
          <FileImage className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="font-semibold text-foreground">
            No pages in this sample
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a PDF sample to inspect and redact its pages.
          </p>
        </div>
      </div>
    );
  }

  const matchingCopyPages = pages.filter(
    (page) =>
      page.pageNumber !== currentPage.pageNumber &&
      sameDimensions(page, currentPage),
  );

  return (
    <div
      className={`flex h-[75dvh] min-h-[420px] max-h-[900px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm ${className}`}
      data-testid="template-redaction-editor"
    >
      <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-muted/20 p-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-bold text-foreground">
            Sample page editor
          </p>
          <p className="text-xs text-muted-foreground">
            {mode === "source"
              ? "Draw a box, then drag to move or resize it. Boxes cover private details in future uploads."
              : "Review the cleaned output before saving this template."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex rounded-md border border-border bg-background p-0.5"
            role="tablist"
            aria-label="Template preview mode"
          >
            <Button
              type="button"
              size="sm"
              variant={mode === "source" ? "secondary" : "ghost"}
              className="h-8 text-xs font-bold"
              data-testid="button-template-source-mode"
              onClick={() => setEditorMode("source")}
            >
              Source editor
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "cleaned" ? "secondary" : "ghost"}
              className="h-8 text-xs font-bold"
              data-testid="button-template-cleaned-mode"
              onClick={() => setEditorMode("cleaned")}
            >
              Cleaned preview
            </Button>
          </div>
          <div className="flex items-center rounded-md border border-border bg-background">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Zoom out"
                  data-testid="button-template-zoom-out"
                  onClick={() =>
                    setZoom((value) => Math.max(0.5, value - 0.25))
                  }
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom out</TooltipContent>
            </Tooltip>
            <span
              className="w-11 text-center text-xs font-bold"
              aria-live="polite"
            >
              {Math.round(zoom * 100)}%
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Zoom in"
                  data-testid="button-template-zoom-in"
                  onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom in</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className="w-24 shrink-0 overflow-y-auto border-r border-border bg-muted/20 p-2 md:w-32"
          aria-label="Sample pages"
        >
          <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Pages ({pages.length})
          </p>
          <div className="space-y-2">
            {pages.map((page) => (
              <button
                type="button"
                key={page.pageNumber}
                className={`w-full rounded-lg border-2 p-1 text-left transition-colors ${
                  page.pageNumber === currentPage.pageNumber
                    ? "border-foreground bg-background shadow-sm"
                    : "border-transparent hover:border-border hover:bg-background/70"
                }`}
                data-testid={`button-template-page-${page.pageNumber}`}
                onClick={() => setCurrentPageNumber(page.pageNumber)}
              >
                <div className="relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded border border-border bg-background">
                  {page.cleanedUrl && mode === "cleaned" ? (
                    <img
                      src={page.cleanedUrl}
                      alt={`Cleaned sample page ${page.pageNumber}`}
                      className="h-full w-full object-contain"
                    />
                  ) : page.sourceUrl ? (
                    <img
                      src={page.sourceUrl}
                      alt={`Source sample page ${page.pageNumber}`}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <FileImage className="h-4 w-4 text-muted-foreground/40" />
                  )}
                  {mode === "source" && page.rects.length > 0 && (
                    <span className="absolute right-0 top-0 rounded-bl bg-foreground px-1 py-0.5 text-[8px] font-bold text-background">
                      {page.rects.length}
                    </span>
                  )}
                </div>
                <span className="mt-1 block text-center text-[10px] font-bold text-muted-foreground">
                  Page {page.pageNumber}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div
          ref={canvasContainerRef}
          className="min-w-0 flex-1 overflow-auto bg-muted/10 p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-semibold">
              Page {currentPage.pageNumber} · {Math.round(currentPage.width)} ×{" "}
              {Math.round(currentPage.height)} pt
            </span>
            {mode === "source" && (
              <span className="font-semibold">
                {currentRects.length} redaction{" "}
                {currentRects.length === 1 ? "box" : "boxes"}
              </span>
            )}
          </div>

          <div className="flex min-h-[500px] items-start justify-center pb-8">
            <div
              className="relative shrink-0 border border-border bg-white shadow-lg"
              style={{
                width: currentPage.width * scale,
                height: currentPage.height * scale,
                cursor:
                  mode === "source" && !disabled ? "crosshair" : "default",
                touchAction: "none",
                userSelect: "none",
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              data-testid={`canvas-template-page-${currentPage.pageNumber}`}
            >
              {mode === "source" ? (
                currentSourceUrl ? (
                  <img
                    src={currentSourceUrl}
                    alt={`Original sample page ${currentPage.pageNumber}`}
                    draggable={false}
                    className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                  />
                ) : currentPage.sourceLoading ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-muted/30 text-muted-foreground">
                    <Loader2 className="h-7 w-7 animate-spin" />
                  </div>
                ) : currentPage.sourceError ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-destructive/5 p-6 text-center text-sm font-semibold text-destructive">
                    <span>{currentPage.sourceError}</span>
                    {onRetrySource && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="font-bold"
                        data-testid="button-retry-template-source"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onRetrySource();
                        }}
                      >
                        Retry source preview
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-muted/40 p-6 text-center text-sm font-semibold text-muted-foreground">
                    {sourceUnavailableMessage}
                  </div>
                )
              ) : currentCleanedUrl ? (
                <img
                  src={currentCleanedUrl}
                  alt={`Cleaned sample page ${currentPage.pageNumber}`}
                  draggable={false}
                  className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                />
              ) : currentPage.cleanedLoading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/30 text-muted-foreground">
                  <Loader2 className="h-7 w-7 animate-spin" />
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/40 p-6 text-center text-sm font-semibold text-muted-foreground">
                  {cleanedUnavailableMessage}
                </div>
              )}

              {mode === "source" &&
                currentRects.map((rect, index) => (
                  <div
                    key={`${currentPage.pageNumber}-${index}`}
                    data-rect-index={index}
                    className={`group absolute z-10 border border-slate-900 bg-slate-900/95 ${
                      operation?.type !== "draw" && operation?.index === index
                        ? "cursor-grabbing"
                        : "cursor-grab hover:bg-slate-800"
                    }`}
                    style={{
                      left: rect.x * scale,
                      top: rect.y * scale,
                      width: rect.width * scale,
                      height: rect.height * scale,
                    }}
                  >
                    <div
                      className="pointer-events-auto absolute bottom-full left-0 z-30 mb-1 flex gap-1 rounded-md border border-border bg-card p-1 shadow-md"
                      data-editor-control
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onPointerMove={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onPointerUp={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={`Copy redaction box ${index + 1}`}
                        data-testid={`button-copy-redaction-${currentPage.pageNumber}-${index}`}
                        onClick={() => openCopyDialog(index)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        className="h-7 w-7"
                        aria-label={`Delete redaction box ${index + 1}`}
                        data-testid={`button-delete-redaction-${currentPage.pageNumber}-${index}`}
                        onClick={() => removeRect(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden text-[9px] font-bold text-slate-300">
                      REDACTED
                    </span>
                    <span
                      className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize border border-slate-900 bg-card opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                      data-resize-handle
                      data-index={index}
                      aria-label={`Resize redaction box ${index + 1}`}
                    />
                  </div>
                ))}

              {operation?.type === "draw" && (
                <div
                  className="pointer-events-none absolute z-20 border-2 border-foreground bg-foreground/10"
                  style={{
                    left:
                      Math.min(operation.startX, operation.currentX) * scale,
                    top: Math.min(operation.startY, operation.currentY) * scale,
                    width:
                      Math.abs(operation.currentX - operation.startX) * scale,
                    height:
                      Math.abs(operation.currentY - operation.startY) * scale,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={copyDialogOpen}
        onOpenChange={(open) => {
          setCopyDialogOpen(open);
          if (!open) {
            setCopyIndex(null);
            setCopyTargets([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy redaction box to pages</DialogTitle>
            <DialogDescription>
              Only pages with matching dimensions can safely receive this box.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {matchingCopyPages.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                No other pages have a compatible layout.
              </p>
            ) : (
              matchingCopyPages.map((page) => (
                <label
                  key={page.pageNumber}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 hover:bg-muted/40"
                  data-testid={`label-copy-redaction-page-${page.pageNumber}`}
                >
                  <Checkbox
                    checked={copyTargets.includes(page.pageNumber)}
                    onCheckedChange={(checked) =>
                      setCopyTargets((current) =>
                        checked
                          ? [...current, page.pageNumber]
                          : current.filter(
                              (number) => number !== page.pageNumber,
                            ),
                      )
                    }
                    data-testid={`checkbox-copy-redaction-page-${page.pageNumber}`}
                  />
                  <span className="text-sm font-semibold">
                    Page {page.pageNumber}
                  </span>
                </label>
              ))
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              data-testid="button-cancel-copy-redaction"
              onClick={() => setCopyDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={copyTargets.length === 0}
              data-testid="button-confirm-copy-redaction"
              onClick={applyCopy}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy to selected pages
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
