import { PDFDocument } from "pdf-lib";
import { open, lstat, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { PacketEngine, PacketPageAnalysis as StoredPageAnalysis, PacketPageType as StoredPageType, RedactionRect } from "./types";
import { runPacketEngineInWorker, runPacketSanitizationSession, type PacketSessionOptions } from "./workerClient";
import {
  SANITIZED_BATCH_MERGE_LIMITS,
  type ExpectedBatchPageGeometry,
} from "./workerProtocol";

import {
  classifyPacketPage,
  detectPacketProfile,
  drawingTitleBlockRegion,
  findAdministrativeRegions,
  isNormalizedRect,
  type NormalizedRect,
  type PacketPageType,
  type PacketProfile,
  type PageRegion,
  type TextLine,
} from "./profiles";

export type { NormalizedRect, PacketPageType, PacketProfile, PageRegion } from "./profiles";

const POINTS_PER_INCH = 72;
const DEFAULT_RENDER_DPI = 160;

export const DEFAULT_PACKET_ENGINE_LIMITS = {
  maxSourceBytes: 40 * 1024 * 1024,
  maxPages: 100,
  maxPagePoints: 14_400,
  maxPixelsPerPage: 24_000_000,
  maxTotalPixels: 120_000_000,
  maxOutputBytes: 120 * 1024 * 1024,
  maxElapsedMs: 90_000,
  maxRectsPerPage: 32,
  maxRenderDpi: 180,
  minRenderDpi: 72,
} as const;

export type PacketEngineLimits = typeof DEFAULT_PACKET_ENGINE_LIMITS;

export interface PdfPageAnalysis {
  pageNumber: number;
  /** PDF points, before applying any page rotation. */
  width: number;
  /** PDF points, before applying any page rotation. */
  height: number;
  rotation: number;
  pageType: PacketPageType;
  regions: PageRegion[];
  /** A subset of regions that may be offered to an admin as selections. */
  suggestedBrandingRects: NormalizedRect[];
}

export interface PdfAnalysis {
  pageCount: number;
  profile: PacketProfile;
  pages: PdfPageAnalysis[];
  warnings: string[];
}

type PdfPageBounds = {
  left: number;
  bottom: number;
  right: number;
  top: number;
  width: number;
  height: number;
};

export interface RenderPreviewOptions {
  dpi?: number;
  limits?: Partial<PacketEngineLimits>;
}

export interface SanitizationSelection {
  /**
   * Bounds must be selected and validated by the server/UI; analysis suggestions
   * are never silently applied.
   */
  pages: ReadonlyArray<{
    pageNumber: number;
    bounds: readonly NormalizedRect[];
    /** Source-bound geometry used to reject stale analysis/redaction data. */
    expectedWidth?: number;
    expectedHeight?: number;
  }>;
  /**
   * Optional source-page order. Omitting a page excludes it from the flattened
   * packet; output page numbers are always sequential after this operation.
   */
  pageOrder?: readonly number[];
}

export interface SanitizedPacket {
  pdf: Buffer;
  pagePngs: Buffer[];
  pages: Array<{ pageNumber: number; width: number; height: number; pngBytes: Buffer }>;
  pageCount: number;
  renderDpi: number;
  diagnostics: {
    renderAndPngMs: number;
    pdfEncodeMs: number;
    totalMs: number;
  };
}

export type PacketEngineAdapter = Omit<
  PacketEngine,
  "analyzePdf" | "generateSanitizedPacket"
> & {
  /**
   * Includes the persisted page shape plus the full worker-derived profile so
   * service code does not need to parse the same upload twice.
   */
  analyzePdf(
    bytes: Uint8Array,
    manufacturer?: string | null,
  ): Promise<Awaited<ReturnType<PacketEngine["analyzePdf"]>> & Pick<PdfAnalysis, "profile" | "warnings">>;
  generateSanitizedPacket(input: {
    bytes: Uint8Array;
    manufacturer?: string | null;
    redactionsByPage: Record<number, RedactionRect[]>;
    /**
     * Reuse the immediately preceding `analyzePdf(...).pages` geometry. This
     * avoids a second analysis pass before the worker's required render pass.
     */
    pageDimensions?: readonly Pick<StoredPageAnalysis, "pageNumber" | "width" | "height">[];
    /**
     * Optional original page numbers in the desired packet order. Omitted
     * pages are excluded; generated PNG/PDF page numbers stay sequential.
     */
    pageOrder?: readonly number[];
  }): ReturnType<PacketEngine["generateSanitizedPacket"]>;
  /** Hard-deadline worker preview for storage/download routes. */
  renderPdfPreview(
    bytes: Uint8Array,
    pageNumber: number,
    options?: RenderPreviewOptions,
  ): Promise<Buffer>;
  /** Render one redacted PNG directly, without constructing a throwaway PDF. */
  renderRedactedPdfPreview(input: {
    bytes: Uint8Array;
    pageNumber: number;
    pageDimensions: Pick<StoredPageAnalysis, "width" | "height">;
    redactions: RedactionRect[];
    options?: RenderPreviewOptions;
  }): Promise<Buffer>;
};

export class PacketEngineError extends Error {
  constructor(
    readonly code:
      | "INVALID_PDF"
      | "LIMIT_EXCEEDED"
      | "INVALID_SELECTION"
      | "RENDER_FAILED"
      | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "PacketEngineError";
  }
}

type PdfJsPage = {
  rotate: number;
  view: readonly number[];
  getViewport(options: { scale: number; rotation: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  render(options: { canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
};

type PdfJsDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  cleanup(): Promise<unknown> | unknown;
  loadingTask?: { destroy(): Promise<void> };
};

type PdfJsModule = {
  OPS: Record<string, number>;
  getDocument(options: {
    data: Uint8Array;
    disableWorker: boolean;
    isEvalSupported: boolean;
    stopAtErrors: boolean;
    useSystemFonts: boolean;
  }): { promise: Promise<PdfJsDocument> };
};

type CanvasLike = {
  getContext(type: "2d"): {
    fillStyle: string;
    fillRect(x: number, y: number, width: number, height: number): void;
  };
  toBuffer(type: "image/png"): Buffer;
};

type CanvasModule = {
  createCanvas(width: number, height: number): CanvasLike;
};

let libraryPromise: Promise<{ pdfjs: PdfJsModule; canvas: CanvasModule }> | undefined;

interface ImagePlacement {
  key: string;
  bounds: NormalizedRect;
}

function resolveLimits(overrides?: Partial<PacketEngineLimits>): PacketEngineLimits {
  return { ...DEFAULT_PACKET_ENGINE_LIMITS, ...overrides };
}

function assertPdfBytes(bytes: Buffer, limits: PacketEngineLimits): void {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new PacketEngineError("INVALID_PDF", "A non-empty PDF buffer is required.");
  }
  if (bytes.length > limits.maxSourceBytes) {
    throw new PacketEngineError("LIMIT_EXCEEDED", `PDF exceeds the ${limits.maxSourceBytes}-byte input limit.`);
  }
}

function assertWithinDeadline(startedAt: number, limits: PacketEngineLimits): void {
  if (Date.now() - startedAt > limits.maxElapsedMs) {
    throw new PacketEngineError("TIMEOUT", "PDF processing exceeded the configured time limit.");
  }
}

function assertRenderDpi(dpi: number, limits: PacketEngineLimits): number {
  if (!Number.isInteger(dpi) || dpi < limits.minRenderDpi || dpi > limits.maxRenderDpi) {
    throw new PacketEngineError(
      "LIMIT_EXCEEDED",
      `Render DPI must be an integer from ${limits.minRenderDpi} to ${limits.maxRenderDpi}.`,
    );
  }
  return dpi;
}

async function loadLibraries(): Promise<{ pdfjs: PdfJsModule; canvas: CanvasModule }> {
  libraryPromise ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("@napi-rs/canvas"),
  ])
    .then(([pdfjs, canvas]) => ({
      pdfjs: pdfjs as unknown as PdfJsModule,
      canvas: canvas as unknown as CanvasModule,
    }))
    .catch((error: unknown) => {
      libraryPromise = undefined;
      throw new PacketEngineError(
        "RENDER_FAILED",
        `Packet rendering dependencies are unavailable: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    });
  return libraryPromise;
}

async function openDocument(bytes: Buffer, limits: PacketEngineLimits): Promise<PdfJsDocument> {
  const { pdfjs } = await loadLibraries();
  try {
    const document = await pdfjs.getDocument({
      // pdfjs may detach its input array; never hand it the caller's Buffer view.
      data: new Uint8Array(bytes),
      disableWorker: true,
      isEvalSupported: false,
      stopAtErrors: true,
      useSystemFonts: true,
    }).promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1) {
      throw new PacketEngineError("INVALID_PDF", "The PDF has no readable pages.");
    }
    if (document.numPages > limits.maxPages) {
      throw new PacketEngineError("LIMIT_EXCEEDED", `PDF has more than ${limits.maxPages} pages.`);
    }
    return document;
  } catch (error) {
    if (error instanceof PacketEngineError) throw error;
    throw new PacketEngineError("INVALID_PDF", "PDF could not be parsed safely.");
  }
}

async function closeDocument(document: PdfJsDocument): Promise<void> {
  // pdfjs-dist 6 exposes cleanup on the proxy and destroy on its loading task.
  // Calling both releases fonts/images and terminates the no-worker task.
  await document.cleanup();
  await document.loadingTask?.destroy();
}

function dimensionsFor(page: PdfJsPage, limits: PacketEngineLimits): PdfPageBounds & { rotation: number } {
  const [left, bottom, right, top] = page.view;
  const pageLeft = Math.min(left ?? 0, right ?? 0);
  const pageRight = Math.max(left ?? 0, right ?? 0);
  const pageBottom = Math.min(bottom ?? 0, top ?? 0);
  const pageTop = Math.max(bottom ?? 0, top ?? 0);
  const width = pageRight - pageLeft;
  const height = pageTop - pageBottom;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > limits.maxPagePoints ||
    height > limits.maxPagePoints
  ) {
    throw new PacketEngineError("LIMIT_EXCEEDED", "PDF page dimensions are outside configured bounds.");
  }
  return {
    left: pageLeft,
    bottom: pageBottom,
    right: pageRight,
    top: pageTop,
    width,
    height,
    rotation: ((page.rotate % 360) + 360) % 360,
  };
}

type TextFragment = {
  text: string;
  bounds: { left: number; bottom: number; right: number; top: number };
  angle: number;
  normal: number;
  alongStart: number;
  alongEnd: number;
  baselineTolerance: number;
};

function normalizedPdfBounds(
  bounds: { left: number; bottom: number; right: number; top: number },
  page: PdfPageBounds,
): NormalizedRect | undefined {
  const left = Math.max(page.left, Math.min(page.right, bounds.left));
  const right = Math.max(page.left, Math.min(page.right, bounds.right));
  const bottom = Math.max(page.bottom, Math.min(page.top, bounds.bottom));
  const top = Math.max(page.bottom, Math.min(page.top, bounds.top));
  if (right <= left || top <= bottom) return undefined;
  const normalized = {
    x: (left - page.left) / page.width,
    y: (page.top - top) / page.height,
    width: (right - left) / page.width,
    height: (top - bottom) / page.height,
  };
  return isNormalizedRect(normalized) ? normalized : undefined;
}

function canonicalTextAngle(angle: number): number {
  let canonical = angle % Math.PI;
  if (canonical < -Math.PI / 2) canonical += Math.PI;
  if (canonical >= Math.PI / 2) canonical -= Math.PI;
  return canonical;
}

function fragmentFromTextItem(value: unknown): TextFragment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as {
    str?: unknown;
    width?: unknown;
    height?: unknown;
    transform?: unknown;
  };
  if (typeof item.str !== "string" || item.str.trim().length === 0) return undefined;
  if (!Array.isArray(item.transform) || item.transform.length < 6) return undefined;

  const transform = item.transform as number[];
  const [a, b, c, d, e, f] = transform;
  const itemWidth = typeof item.width === "number" ? Math.abs(item.width) : 0;
  const itemHeight = typeof item.height === "number" && item.height > 0
    ? item.height
    : Math.hypot(c ?? 0, d ?? 0) || Math.hypot(a ?? 0, b ?? 0) || 8;
  const xScale = Math.hypot(a ?? 0, b ?? 0);
  const yScale = Math.hypot(c ?? 0, d ?? 0);
  if (
    ![a, b, c, d, e, f, itemWidth, itemHeight, xScale, yScale].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    ) ||
    xScale <= 0 ||
    yScale <= 0
  ) {
    return undefined;
  }

  // Text item transforms are in PDF user space. item.width/item.height are
  // already user-space lengths, while the transform's first two columns carry
  // their direction. Using both columns handles vertical/rotated text instead
  // of assuming every item is horizontal and anchored at its baseline.
  const xDirection = [(a ?? 0) / xScale, (b ?? 0) / xScale] as const;
  const yDirection = [(c ?? 0) / yScale, (d ?? 0) / yScale] as const;
  const advance = itemWidth > 0 ? itemWidth : xScale * Math.max(1, item.str.length * 0.25);
  const corners = [
    [e ?? 0, f ?? 0],
    [(e ?? 0) + xDirection[0] * advance, (f ?? 0) + xDirection[1] * advance],
    [(e ?? 0) + yDirection[0] * itemHeight, (f ?? 0) + yDirection[1] * itemHeight],
    [
      (e ?? 0) + xDirection[0] * advance + yDirection[0] * itemHeight,
      (f ?? 0) + xDirection[1] * advance + yDirection[1] * itemHeight,
    ],
  ];
  const angle = canonicalTextAngle(Math.atan2(xDirection[1], xDirection[0]));
  const alongDirection = [Math.cos(angle), Math.sin(angle)] as const;
  const normalDirection = [-Math.sin(angle), Math.cos(angle)] as const;
  const along = corners.map(([x, y]) => x * alongDirection[0] + y * alongDirection[1]);
  const normal = (e ?? 0) * normalDirection[0] + (f ?? 0) * normalDirection[1];
  return {
    text: item.str,
    bounds: {
      left: Math.min(...corners.map(([x]) => x)),
      right: Math.max(...corners.map(([x]) => x)),
      bottom: Math.min(...corners.map(([, y]) => y)),
      top: Math.max(...corners.map(([, y]) => y)),
    },
    angle,
    normal,
    alongStart: Math.min(...along),
    alongEnd: Math.max(...along),
    baselineTolerance: Math.max(1.5, Math.min(4, yScale * 0.22)),
  };
}

/**
 * Converts PDF.js text items into tight top-left-origin rectangles. The page
 * view box is required because CropBox coordinates need not start at (0, 0).
 * Rows are split at large horizontal/along-text gaps so two columns sharing a
 * baseline never become one giant administrative rectangle.
 */
export function textLinesFromContent(
  items: readonly unknown[],
  page: Pick<PdfPageBounds, "left" | "bottom" | "right" | "top" | "width" | "height">,
): TextLine[] {
  const fragments = items
    .map(fragmentFromTextItem)
    .filter((fragment): fragment is TextFragment => Boolean(fragment));
  const rows: Array<{ angle: number; normal: number; fragments: TextFragment[] }> = [];
  const angleTolerance = Math.PI / 36;
  for (const fragment of fragments) {
    const row = rows.find(
      (candidate) =>
        Math.abs(candidate.angle - fragment.angle) <= angleTolerance &&
        Math.abs(candidate.normal - fragment.normal) <= fragment.baselineTolerance,
    );
    if (row) {
      row.fragments.push(fragment);
    } else {
      rows.push({ angle: fragment.angle, normal: fragment.normal, fragments: [fragment] });
    }
  }

  const result: TextLine[] = [];
  for (const row of rows) {
    const sorted = [...row.fragments].sort((left, right) => left.alongStart - right.alongStart);
    let segment: TextFragment[] = [];
    const flush = () => {
      if (segment.length === 0) return;
      const bounds = segment.reduce(
        (combined, fragment) => ({
          left: Math.min(combined.left, fragment.bounds.left),
          right: Math.max(combined.right, fragment.bounds.right),
          bottom: Math.min(combined.bottom, fragment.bounds.bottom),
          top: Math.max(combined.top, fragment.bounds.top),
        }),
        { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity },
      );
      const textPadding = 1.5;
      const normalizedBounds = normalizedPdfBounds(
        {
          left: bounds.left - textPadding,
          right: bounds.right + textPadding,
          bottom: bounds.bottom - textPadding,
          top: bounds.top + textPadding,
        },
        page,
      );
      const text = segment.map((fragment) => fragment.text).join(" ").replace(/\s+/g, " ").trim();
      if (text && normalizedBounds) result.push({ text, bounds: normalizedBounds });
      segment = [];
    };
    for (const fragment of sorted) {
      const previous = segment[segment.length - 1];
      const gap = previous ? fragment.alongStart - previous.alongEnd : 0;
      // A gap of several font heights is a column/table-cell boundary, not a
      // word gap. This is intentionally conservative for administrative
      // matching: separate fields must not be merged into one redaction.
      const splitThreshold = Math.max(12, fragment.baselineTolerance * 8);
      if (previous && gap > splitThreshold) flush();
      segment.push(fragment);
    }
    flush();
  }
  return result;
}

function pageText(lines: readonly TextLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

function multiplyMatrices(left: number[], right: number[]): number[] {
  return [
    left[0]! * right[0]! + left[2]! * right[1]!,
    left[1]! * right[0]! + left[3]! * right[1]!,
    left[0]! * right[2]! + left[2]! * right[3]!,
    left[1]! * right[2]! + left[3]! * right[3]!,
    left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
    left[1]! * right[4]! + left[3]! * right[5]! + left[5]!,
  ];
}

function rectForImageTransform(matrix: number[], page: PdfPageBounds): NormalizedRect | undefined {
  const points = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => [matrix[0]! * x + matrix[2]! * y + matrix[4]!, matrix[1]! * x + matrix[3]! * y + matrix[5]!]);
  return normalizedPdfBounds(
    {
      left: Math.min(...points.map(([x]) => x!)),
      right: Math.max(...points.map(([x]) => x!)),
      bottom: Math.min(...points.map(([, y]) => y!)),
      top: Math.max(...points.map(([, y]) => y!)),
    },
    page,
  );
}

/**
 * PDF image resource IDs are deterministic within a document. A repeated ID is
 * a useful review signal for a recurring visual mark, but never becomes an
 * automatic redaction (product drawings and manufacturer logos are preserved).
 */
function imagePlacementsFromOperators(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  ops: Record<string, number>,
  page: PdfPageBounds,
): ImagePlacement[] {
  const paintOps = new Set([ops.paintImageXObject, ops.paintJpegXObject, ops.paintImageMaskXObject]);
  const stack: number[][] = [];
  let transform = [1, 0, 0, 1, 0, 0];
  const placements: ImagePlacement[] = [];
  const maxImages = 500;

  for (let index = 0; index < operatorList.fnArray.length && placements.length < maxImages; index++) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (operation === ops.save) {
      stack.push(transform);
    } else if (operation === ops.restore) {
      transform = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    } else if (operation === ops.transform) {
      const next = args.slice(0, 6);
      if (next.length === 6 && next.every((value) => typeof value === "number" && Number.isFinite(value))) {
        transform = multiplyMatrices(transform, next as number[]);
      }
    } else if (paintOps.has(operation) && args.length > 0) {
      const bounds = rectForImageTransform(transform, page);
      if (bounds) placements.push({ key: String(args[0]), bounds });
    }
  }
  return placements;
}

function selectionMap(
  selection: SanitizationSelection,
  pageCount: number,
  limits: PacketEngineLimits,
): Map<number, SanitizationSelection["pages"][number]> {
  if (!selection || !Array.isArray(selection.pages)) {
    throw new PacketEngineError("INVALID_SELECTION", "A page-by-page sanitization selection is required.");
  }
  const selected = new Map<number, SanitizationSelection["pages"][number]>();
  for (const entry of selection.pages) {
    if (!Number.isInteger(entry.pageNumber) || entry.pageNumber < 1 || entry.pageNumber > pageCount) {
      throw new PacketEngineError("INVALID_SELECTION", "Selection contains an invalid page number.");
    }
    if (selected.has(entry.pageNumber) || !Array.isArray(entry.bounds) || entry.bounds.length > limits.maxRectsPerPage) {
      throw new PacketEngineError("INVALID_SELECTION", "Selection has duplicate pages or too many bounds.");
    }
    if (!entry.bounds.every(isNormalizedRect)) {
      throw new PacketEngineError("INVALID_SELECTION", "Each selected bound must be a normalized in-page rectangle.");
    }
    if (
      (entry.expectedWidth !== undefined &&
        (!Number.isFinite(entry.expectedWidth) || entry.expectedWidth <= 0)) ||
      (entry.expectedHeight !== undefined &&
        (!Number.isFinite(entry.expectedHeight) || entry.expectedHeight <= 0))
    ) {
      throw new PacketEngineError("INVALID_SELECTION", "Selection contains invalid expected page geometry.");
    }
    selected.set(entry.pageNumber, entry);
  }
  return selected;
}

function assertExpectedDimensions(
  expected: Pick<SanitizationSelection["pages"][number], "expectedWidth" | "expectedHeight"> | undefined,
  actual: Pick<PdfPageBounds, "width" | "height">,
): void {
  const tolerance = 0.01;
  if (
    (expected?.expectedWidth !== undefined &&
      Math.abs(expected.expectedWidth - actual.width) > tolerance) ||
    (expected?.expectedHeight !== undefined &&
      Math.abs(expected.expectedHeight - actual.height) > tolerance)
  ) {
    throw new PacketEngineError(
      "INVALID_SELECTION",
      "Selected redactions were analyzed against different source page dimensions.",
    );
  }
}

export function rasterBoundsForNormalizedRect(
  rect: NormalizedRect,
  pixelWidth: number,
  pixelHeight: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.floor(rect.x * pixelWidth);
  const top = Math.floor(rect.y * pixelHeight);
  const right = Math.ceil((rect.x + rect.width) * pixelWidth);
  const bottom = Math.ceil((rect.y + rect.height) * pixelHeight);
  return { left, top, width: right - left, height: bottom - top };
}

function selectedPageOrder(
  pageOrder: readonly number[] | undefined,
  pageCount: number,
): readonly number[] {
  const order = pageOrder ?? Array.from({ length: pageCount }, (_, index) => index + 1);
  if (order.length === 0 || order.length > pageCount || new Set(order).size !== order.length) {
    throw new PacketEngineError("INVALID_SELECTION", "Page order must contain unique source pages.");
  }
  if (!order.every((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount)) {
    throw new PacketEngineError("INVALID_SELECTION", "Page order contains an invalid source page number.");
  }
  return order;
}

async function renderPage(
  page: PdfJsPage,
  dpi: number,
  limits: PacketEngineLimits,
  redactions: readonly NormalizedRect[] = [],
  progress?: (phase: "draw" | "png", elapsedMs: number) => void,
): Promise<{ png: Buffer; width: number; height: number }> {
  const { canvas } = await loadLibraries();
  const scale = dpi / POINTS_PER_INCH;
  // Explicit zero rotation means normalized coordinates are stable across files.
  const viewport = page.getViewport({ scale, rotation: 0 });
  const pixelWidth = Math.ceil(viewport.width);
  const pixelHeight = Math.ceil(viewport.height);
  if (
    pixelWidth < 1 ||
    pixelHeight < 1 ||
    pixelWidth * pixelHeight > limits.maxPixelsPerPage
  ) {
    throw new PacketEngineError("LIMIT_EXCEEDED", "Rendered page would exceed the pixel limit.");
  }

  const output = canvas.createCanvas(pixelWidth, pixelHeight);
  const context = output.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pixelWidth, pixelHeight);
  try {
    const drawStarted = Date.now();
    progress?.("draw", 0);
    await page.render({ canvasContext: context, viewport }).promise;
    progress?.("draw", Date.now() - drawStarted);
  } catch (error) {
    throw new PacketEngineError(
      "RENDER_FAILED",
      `Unable to rasterize page: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }

  context.fillStyle = "#ffffff";
  for (const rect of redactions) {
    // Cover the complete continuous rectangle in raster space. Flooring the
    // origin and independently ceiling the size can leave the right/bottom
    // fractional edge visible (for example x=.1, width=.1 on a 101px page).
    const bounds = rasterBoundsForNormalizedRect(rect, pixelWidth, pixelHeight);
    context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
  }
  const pngStarted = Date.now();
  progress?.("png", 0);
  const png = output.toBuffer("image/png");
  progress?.("png", Date.now() - pngStarted);
  return { png, width: pixelWidth, height: pixelHeight };
}

/**
 * Inspects PDF layout with deterministic, non-AI rules. It makes no document
 * edits and suggestions remain opt-in for an administrator.
 */
export async function analyzePdf(bytes: Buffer, manufacturer?: string): Promise<PdfAnalysis> {
  const limits = resolveLimits();
  const startedAt = Date.now();
  assertPdfBytes(bytes, limits);
  const document = await openDocument(bytes, limits);
  try {
    const drafts: Array<{
      pageNumber: number;
      width: number;
      height: number;
      rotation: number;
      lines: TextLine[];
      images: ImagePlacement[];
    }> = [];
    let documentText = "";
    const { pdfjs } = await loadLibraries();
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      assertWithinDeadline(startedAt, limits);
      const page = await document.getPage(pageNumber);
      try {
        const dimensions = dimensionsFor(page, limits);
        // PDF.js can prepare text and operators from the same parsed page in
        // parallel. This removes avoidable per-page serialization without
        // changing either deterministic analysis result.
        const [textContent, operatorList] = await Promise.all([
          page.getTextContent(),
          page.getOperatorList(),
        ]);
        const lines = textLinesFromContent(textContent.items, dimensions);
        const images = imagePlacementsFromOperators(operatorList, pdfjs.OPS, dimensions);
        const text = pageText(lines);
        documentText += `\n${text}`;
        drafts.push({
          pageNumber,
          width: dimensions.width,
          height: dimensions.height,
          rotation: dimensions.rotation,
          lines,
          images,
        });
      } finally {
        page.cleanup();
      }
    }

    const profile = detectPacketProfile(manufacturer, documentText);
    const imagePageCounts = new Map<string, Set<number>>();
    for (const draft of drafts) {
      for (const image of draft.images) {
        const pages = imagePageCounts.get(image.key) ?? new Set<number>();
        pages.add(draft.pageNumber);
        imagePageCounts.set(image.key, pages);
      }
    }
    const pages = drafts.map((draft) => {
      const text = pageText(draft.lines);
      const pageType = classifyPacketPage(draft.pageNumber, document.numPages, text, profile);
      const regions = findAdministrativeRegions(draft.lines, { profile, pageType }).map((region) =>
        profile === "unknown" ? { ...region, suggested: false } : region,
      );
      for (const image of draft.images) {
        const isSmallVisualMark = image.bounds.width <= 0.15 && image.bounds.height <= 0.06;
        const isMarvinLogoCandidate =
          profile === "marvin" && isSmallVisualMark && (imagePageCounts.get(image.key)?.size ?? 0) >= 2;
        if ((imagePageCounts.get(image.key)?.size ?? 0) >= 2) {
          regions.push({
            kind: "logo",
            label: isMarvinLogoCandidate
              ? "repeated Marvin vendor logo (manual review required)"
              : "repeated visual mark (manual review required)",
            bounds: image.bounds,
            confidence: isMarvinLogoCandidate ? 0.85 : 0.65,
            // Image identity is not enough to distinguish a dealer logo from a
            // product mark, drawing, QR code, or technical illustration. Keep
            // every visual candidate manual-review-only.
            suggested: false,
          });
        }
      }
      const titleBlock = drawingTitleBlockRegion(pageType);
      if (titleBlock) regions.push(titleBlock);
      return {
        pageNumber: draft.pageNumber,
        width: draft.width,
        height: draft.height,
        rotation: draft.rotation,
        pageType,
        regions,
        suggestedBrandingRects: regions.filter((region) => region.suggested).map((region) => region.bounds),
      };
    });
    const unknownPages = pages
      .filter((page) => page.pageType === "unknown")
      .map((page) => page.pageNumber);
    const warnings =
      profile === "unknown"
        ? ["Unknown manufacturer/layout: no automatic branding bounds were proposed; manual review is required."]
        : [
            "Suggested bounds are limited to narrow dealer/admin identity text. Review each selection before sanitizing.",
            "Product specifications, technical manufacturer names, prices, terms, warranties, and dates are not automatically selected.",
            ...(unknownPages.length > 0
              ? [`Unknown page layout on page${unknownPages.length === 1 ? "" : "s"} ${unknownPages.join(", ")}; manual review is required.`]
              : []),
          ];
    return { pageCount: document.numPages, profile, pages, warnings };
  } finally {
    await closeDocument(document);
  }
}

/** Renders one bounded PNG preview without changing the source PDF. */
export async function renderPdfPreview(
  bytes: Buffer,
  pageNumber: number,
  options: RenderPreviewOptions = {},
): Promise<Buffer> {
  const limits = resolveLimits(options.limits);
  const startedAt = Date.now();
  assertPdfBytes(bytes, limits);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new PacketEngineError("INVALID_SELECTION", "Preview page number must be a positive integer.");
  }
  const dpi = assertRenderDpi(options.dpi ?? DEFAULT_RENDER_DPI, limits);
  const document = await openDocument(bytes, limits);
  try {
    if (pageNumber > document.numPages) {
      throw new PacketEngineError("INVALID_SELECTION", "Preview page number is outside the document.");
    }
    const page = await document.getPage(pageNumber);
    try {
      dimensionsFor(page, limits);
      const rendered = await renderPage(page, dpi, limits);
      assertWithinDeadline(startedAt, limits);
      return rendered.png;
    } finally {
      page.cleanup();
    }
  } finally {
    await closeDocument(document);
  }
}

/** Alias kept concise for route consumers. */
export const renderPreview = renderPdfPreview;

/** Renders one redacted PNG directly, avoiding PDF assembly/encoding. */
export async function renderRedactedPdfPreview(
  bytes: Buffer,
  pageNumber: number,
  bounds: readonly NormalizedRect[],
  expectedDimensions: { width: number; height: number },
  options: RenderPreviewOptions = {},
): Promise<Buffer> {
  const limits = resolveLimits(options.limits);
  const startedAt = Date.now();
  assertPdfBytes(bytes, limits);
  if (
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    bounds.length > limits.maxRectsPerPage ||
    !bounds.every(isNormalizedRect)
  ) {
    throw new PacketEngineError("INVALID_SELECTION", "Redacted preview selection is invalid.");
  }
  const dpi = assertRenderDpi(options.dpi ?? DEFAULT_RENDER_DPI, limits);
  const document = await openDocument(bytes, limits);
  try {
    if (pageNumber > document.numPages) {
      throw new PacketEngineError("INVALID_SELECTION", "Preview page number is outside the document.");
    }
    const page = await document.getPage(pageNumber);
    try {
      const dimensions = dimensionsFor(page, limits);
      assertExpectedDimensions(
        { expectedWidth: expectedDimensions.width, expectedHeight: expectedDimensions.height },
        dimensions,
      );
      const rendered = await renderPage(page, dpi, limits, bounds);
      assertWithinDeadline(startedAt, limits);
      return rendered.png;
    } finally {
      page.cleanup();
    }
  } finally {
    await closeDocument(document);
  }
}

/** Worker-isolated full analysis for callers that need profile/regions. */
export async function analyzePdfInWorker(bytes: Uint8Array, manufacturer?: string | null): Promise<PdfAnalysis> {
  return (await runPacketEngineInWorker({
    operation: "analyze",
    bytes,
    manufacturer: manufacturer ?? undefined,
  })) as PdfAnalysis;
}

/** Worker-isolated preview; use this in routes rather than renderPdfPreview. */
export async function renderPdfPreviewInWorker(
  bytes: Uint8Array,
  pageNumber: number,
  options?: RenderPreviewOptions,
): Promise<Buffer> {
  const png = await runPacketEngineInWorker({
    operation: "preview",
    bytes,
    pageNumber,
    options,
  });
  // Node structured-clones Buffer as Uint8Array across worker boundaries.
  return Buffer.from(png as Uint8Array);
}

/**
 * Makes a fresh PNG-only PDF. The original PDF is never copied, so its text,
 * links, annotations, forms, outlines, scripts, and source metadata cannot
 * survive in the resulting packet.
 */
export async function sanitizePdf(
  bytes: Buffer,
  selection: SanitizationSelection,
  options: RenderPreviewOptions = {},
): Promise<SanitizedPacket> {
  const limits = resolveLimits(options.limits);
  const startedAt = Date.now();
  assertPdfBytes(bytes, limits);
  const dpi = assertRenderDpi(options.dpi ?? DEFAULT_RENDER_DPI, limits);
  const document = await openDocument(bytes, limits);
  try {
    return await sanitizeDocument(document, selection, dpi, limits, startedAt);
  } finally {
    await closeDocument(document);
  }
}

async function sanitizeDocument(
  document: PdfJsDocument,
  selection: SanitizationSelection,
  dpi: number,
  limits: PacketEngineLimits,
  startedAt: number,
  budget = { pixels: 0, bytes: 0 },
  progress?: (phase: import("./workerProtocol").PacketSessionProgress["phase"], pageNumber?: number, elapsedMs?: number) => void,
): Promise<SanitizedPacket> {
  try {
    const selected = selectionMap(selection, document.numPages, limits);
    const sourcePageOrder = selectedPageOrder(selection.pageOrder, document.numPages);
    const output = await PDFDocument.create();
    // Do not transfer source metadata; normalize generated metadata as well.
    output.setTitle("");
    output.setAuthor("");
    output.setSubject("");
    output.setKeywords([]);
    output.setProducer("");
    output.setCreator("");
    output.setCreationDate(new Date(0));
    output.setModificationDate(new Date(0));

    const pagePngs: Buffer[] = [];
    const pages: SanitizedPacket["pages"] = [];
    const renderStartedAt = Date.now();
    for (const [outputPageIndex, sourcePageNumber] of sourcePageOrder.entries()) {
      progress?.("page", sourcePageNumber);
      assertWithinDeadline(startedAt, limits);
      const page = await document.getPage(sourcePageNumber);
      try {
        const dimensions = dimensionsFor(page, limits);
        const pageSelection = selected.get(sourcePageNumber);
        assertExpectedDimensions(pageSelection, dimensions);
        const rendered = await renderPage(page, dpi, limits, pageSelection?.bounds ?? [],
          (phase, elapsed) => progress?.(phase, sourcePageNumber, elapsed));
        budget.pixels += rendered.width * rendered.height;
        if (budget.pixels > limits.maxTotalPixels) {
          throw new PacketEngineError("LIMIT_EXCEEDED", "Packet raster pixels exceed the document limit.");
        }
        const embedStarted = Date.now();
        progress?.("embed", sourcePageNumber);
        const embedded = await output.embedPng(rendered.png);
        progress?.("embed", sourcePageNumber, Date.now() - embedStarted);
        const outputPage = output.addPage([dimensions.width, dimensions.height]);
        outputPage.drawImage(embedded, {
          x: 0,
          y: 0,
          width: dimensions.width,
          height: dimensions.height,
        });
        pagePngs.push(rendered.png);
        pages.push({
          pageNumber: outputPageIndex + 1,
          width: dimensions.width,
          height: dimensions.height,
          pngBytes: rendered.png,
        });
      } finally {
        page.cleanup();
      }
    }
    const renderAndPngMs = Date.now() - renderStartedAt;
    const pdfEncodeStartedAt = Date.now();
    progress?.("save");
    const pdf = Buffer.from(await output.save({ addDefaultPage: false, useObjectStreams: true }));
    const pdfEncodeMs = Date.now() - pdfEncodeStartedAt;
    progress?.("save", undefined, pdfEncodeMs);
    budget.bytes += pdf.length;
    if (budget.bytes > limits.maxOutputBytes) {
      throw new PacketEngineError("LIMIT_EXCEEDED", "Sanitized PDF exceeds the output byte limit.");
    }
    assertWithinDeadline(startedAt, limits);
    return {
      pdf,
      pagePngs,
      pages,
      pageCount: sourcePageOrder.length,
      renderDpi: dpi,
      diagnostics: {
        renderAndPngMs,
        pdfEncodeMs,
        totalMs: Date.now() - startedAt,
      },
    };
  } finally { /* Document ownership belongs to the caller. */ }
}

/** Worker-only document owner. Geometry is checked before any batch is emitted. */
export async function openSanitizationDocumentSession(
  bytes: Buffer,
  selection: SanitizationSelection,
  progress?: (phase: import("./workerProtocol").PacketSessionProgress["phase"], pageNumber?: number, elapsedMs?: number) => void,
) {
  const limits = resolveLimits();
  assertPdfBytes(bytes, limits);
  const started = Date.now();
  progress?.("open");
  const document = await openDocument(bytes, limits);
  const used = new Set<number>();
  const budget = { pixels: 0, bytes: 0 };
  let closed = false;
  let busy = false;
  try {
    progress?.("open", undefined, Date.now() - started);
    const selected = selectionMap(selection, document.numPages, limits);
    if (!selected.size) throw new PacketEngineError("INVALID_SELECTION", "Session requires page geometry.");
    let pixels = 0;
    for (const [pageNumber, expected] of selected) {
      progress?.("preflight", pageNumber);
      const page = await document.getPage(pageNumber);
      try {
        if (expected.expectedWidth === undefined || expected.expectedHeight === undefined)
          throw new PacketEngineError("INVALID_SELECTION", "Session requires source-bound geometry.");
        assertExpectedDimensions(expected, dimensionsFor(page, limits));
        const viewport = page.getViewport({ scale: DEFAULT_RENDER_DPI / POINTS_PER_INCH, rotation: 0 });
        const pagePixels = Math.ceil(viewport.width) * Math.ceil(viewport.height);
        pixels += pagePixels;
        if (pagePixels > limits.maxPixelsPerPage || pixels > limits.maxTotalPixels)
          throw new PacketEngineError("LIMIT_EXCEEDED", "Session raster pixels exceed the document limit.");
        assertWithinDeadline(started, limits);
      } finally { page.cleanup(); }
    }
    return {
      async generateBatch(pageOrder: number[]) {
        if (closed || busy) throw new PacketEngineError("INVALID_SELECTION", "Session is closed or busy.");
        selectedPageOrder(pageOrder, document.numPages);
        if (pageOrder.some((page) => !selected.has(page) || used.has(page)))
          throw new PacketEngineError("INVALID_SELECTION", "Session source page is unavailable or already consumed.");
        busy = true;
        pageOrder.forEach((page) => used.add(page));
        try {
          return await sanitizeDocument(document, { ...selection, pageOrder }, DEFAULT_RENDER_DPI, limits, Date.now(), budget, progress);
        } finally { busy = false; }
      },
      async close() { if (!closed) { closed = true; await closeDocument(document); } },
    };
  } catch (error) {
    await closeDocument(document);
    throw error;
  }
}

export type PacketSanitizationSessionInput = {
  bytes: Uint8Array;
  pageDimensions: readonly Pick<StoredPageAnalysis, "pageNumber" | "width" | "height">[];
  redactionsByPage: Record<number, RedactionRect[]>;
};
export type PacketSanitizationSession = {
  generateBatch(pageOrder: number[]): ReturnType<PacketEngine["generateSanitizedPacket"]>;
};

/**
 * One fixed source, one worker slot, sequential disjoint batches. Numbers in
 * results are batch-local. Await persistence inside callback before next batch.
 * Bounds: 90s command/idle and 15m total, including callback checkpoint waits.
 */
export function withPacketSanitizationSession<T>(
  input: PacketSanitizationSessionInput,
  callback: (session: PacketSanitizationSession) => Promise<T>,
  options: PacketSessionOptions = {},
): Promise<T> {
  const allowed = new Set(input.pageDimensions.map((page) => page.pageNumber));
  if (Object.keys(input.redactionsByPage).some((page) => !allowed.has(Number(page))))
    return Promise.reject(new PacketEngineError("INVALID_SELECTION", "Redactions reference unavailable session geometry."));
  const pages = input.pageDimensions.map((page) => ({
    pageNumber: page.pageNumber,
    expectedWidth: page.width,
    expectedHeight: page.height,
    bounds: (input.redactionsByPage[page.pageNumber] ?? []).map((rect) => toNormalizedRect(rect, page.width, page.height)),
  }));
  return runPacketSanitizationSession({ operation: "sessionOpen", bytes: input.bytes, selection: { pages } },
    (generate) => callback({
      async generateBatch(order) {
        const result = await generate(order) as SanitizedPacket;
        return { pdfBytes: result.pdf, pages: result.pages };
      },
    }), options);
}

/** Server-generated private temp paths ONLY; caller verifies batch hashes. */
export async function mergePacketPdfFilesInWorker(
  inputPaths: string[],
  outputPath: string,
  expectedBatchPageGeometry?: ExpectedBatchPageGeometry,
): Promise<void> {
  await runPacketEngineInWorker({
    operation: "mergeSanitizedBatchFiles",
    inputPaths,
    outputPath,
    expectedBatchPageGeometry,
  });
}

/** Worker implementation. Each batch is read and released sequentially. */
export async function mergePacketPdfFiles(
  inputPaths: string[],
  outputPath: string,
  expectedBatchPageGeometry?: ExpectedBatchPageGeometry,
): Promise<void> {
  if (!Array.isArray(inputPaths) || inputPaths.length < 1 ||
      inputPaths.length > SANITIZED_BATCH_MERGE_LIMITS.maxPages ||
      !isAbsolute(outputPath) || !inputPaths.every((path) => typeof path === "string" && isAbsolute(path))) {
    throw new PacketEngineError("INVALID_SELECTION", "Invalid private batch file paths.");
  }
  if (expectedBatchPageGeometry !== undefined &&
      (expectedBatchPageGeometry.length !== inputPaths.length ||
       expectedBatchPageGeometry.some((batch) =>
         !Array.isArray(batch) || batch.length < 1 ||
         batch.some((page) =>
           !page || typeof page !== "object" ||
           !Number.isFinite(page.width) || page.width <= 0 ||
           !Number.isFinite(page.height) || page.height <= 0)))) {
    throw new PacketEngineError("INVALID_SELECTION", "Invalid expected batch page geometry.");
  }
  const directory = await realpath(dirname(outputPath));
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new PacketEngineError("INVALID_SELECTION", "Batch files require a private temporary directory.");
  }
  let totalBytes = 0;
  for (const path of inputPaths) {
    const stat = await lstat(path);
    if (await realpath(dirname(path)) !== directory || !stat.isFile() || stat.isSymbolicLink()) {
      throw new PacketEngineError("INVALID_SELECTION", "Batch files must be regular files in the private output directory.");
    }
    totalBytes += stat.size;
    if (stat.size < 5 || totalBytes > SANITIZED_BATCH_MERGE_LIMITS.maxInputBytes) {
      throw new PacketEngineError("LIMIT_EXCEEDED", "Batch files exceed the aggregate input byte limit.");
    }
  }
  async function* readBatches() {
    let readBytes = 0;
    for (const path of inputPaths) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        readBytes += stat.size;
        if (!stat.isFile() || stat.size < 5 || readBytes > SANITIZED_BATCH_MERGE_LIMITS.maxInputBytes) {
          throw new PacketEngineError("LIMIT_EXCEEDED", "Batch files exceed the aggregate input byte limit.");
        }
        const bytes = await handle.readFile();
        if (bytes.length !== stat.size || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
          throw new PacketEngineError("INVALID_PDF", "Sanitized batch is invalid or changed during finalization.");
        }
        yield bytes;
      } finally {
        await handle.close();
      }
    }
  }
  const { pdfBytes } = await mergeBatchDocuments(readBatches(), expectedBatchPageGeometry);
  await writeFile(outputPath, pdfBytes, { flag: "wx", mode: 0o600 });
}

async function mergeBatchDocuments(
  batches: AsyncIterable<Uint8Array>,
  expectedBatchPageGeometry?: ExpectedBatchPageGeometry,
): Promise<{ pdfBytes: Uint8Array }> {
  const startedAt = Date.now();
  const output = await PDFDocument.create();
  output.setTitle("");
  output.setAuthor("");
  output.setSubject("");
  output.setKeywords([]);
  output.setProducer("");
  output.setCreator("");
  output.setCreationDate(new Date(0));
  output.setModificationDate(new Date(0));
  let count = 0;
  let batchIndex = 0;
  const expectedTotal = expectedBatchPageGeometry?.reduce(
    (total, batch) => total + batch.length,
    0,
  );
  for await (const bytes of batches) {
    assertWithinDeadline(startedAt, DEFAULT_PACKET_ENGINE_LIMITS);
    let batch: PDFDocument;
    try {
      batch = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    } catch {
      throw new PacketEngineError("INVALID_PDF", "Sanitized batch could not be parsed safely.");
    }
    const pageCount = batch.getPageCount();
    if (pageCount < 1 || count + pageCount > SANITIZED_BATCH_MERGE_LIMITS.maxPages) {
      throw new PacketEngineError("LIMIT_EXCEEDED", "Sanitized batch page count exceeds the packet limit.");
    }
    const expectedPages = expectedBatchPageGeometry?.[batchIndex];
    if (expectedPages && (pageCount !== expectedPages.length ||
        batch.getPages().some((page, index) =>
          page.getWidth() !== expectedPages[index]!.width ||
          page.getHeight() !== expectedPages[index]!.height))) {
      throw new PacketEngineError(
        "INVALID_PDF",
        "Sanitized batch page count or geometry does not match the analyzed packet.",
      );
    }
    for (const page of await output.copyPages(batch, batch.getPageIndices())) {
      output.addPage(page);
    }
    count += pageCount;
    batchIndex += 1;
  }
  if (expectedTotal !== undefined &&
      (batchIndex !== expectedBatchPageGeometry!.length ||
       count !== expectedTotal || output.getPageCount() !== expectedTotal)) {
    throw new PacketEngineError(
      "INVALID_PDF",
      "Sanitized batch total page count does not match the analyzed packet.",
    );
  }
  assertWithinDeadline(startedAt, DEFAULT_PACKET_ENGINE_LIMITS);
  const pdfBytes = await output.save({ addDefaultPage: false, useObjectStreams: true });
  if (pdfBytes.byteLength > SANITIZED_BATCH_MERGE_LIMITS.maxOutputBytes) {
    throw new PacketEngineError("LIMIT_EXCEEDED", "Merged PDF exceeds the output byte limit.");
  }
  assertWithinDeadline(startedAt, DEFAULT_PACKET_ENGINE_LIMITS);
  return { pdfBytes };
}

function toStoredPageType(pageType: PacketPageType): StoredPageType {
  switch (pageType) {
    case "first":
      return "cover";
    case "summary":
      return "terms";
    case "drawing":
      return "quote";
    case "continuation":
      return "specification";
    case "unknown":
      return "other";
  }
}

function toPointRect(bounds: NormalizedRect, width: number, height: number): RedactionRect {
  return {
    x: bounds.x * width,
    y: bounds.y * height,
    width: bounds.width * width,
    height: bounds.height * height,
    reason: "Suggested administrative field",
  };
}

function toNormalizedRect(rect: RedactionRect, width: number, height: number): NormalizedRect {
  return {
    x: rect.x / width,
    y: rect.y / height,
    width: rect.width / width,
    height: rect.height / height,
  };
}

/**
 * Compatibility adapter for the packet service's persisted point-coordinate
 * contract. New callers should use the named exports above, which expose the
 * richer normalized analysis and explicit warning/profile information.
 */
export const packetEngine: PacketEngineAdapter = {
  async analyzePdf(bytes, manufacturer) {
    const analysis = await analyzePdfInWorker(bytes, manufacturer);
    const pages: StoredPageAnalysis[] = analysis.pages.map((page) => ({
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      pageType: toStoredPageType(page.pageType),
      suggestedRects: page.suggestedBrandingRects.map((bounds) => toPointRect(bounds, page.width, page.height)),
    }));
    return { pages, profile: analysis.profile, warnings: analysis.warnings };
  },

  renderPdfPreview(bytes, pageNumber, options) {
    return renderPdfPreviewInWorker(bytes, pageNumber, options);
  },

  async renderRedactedPdfPreview({ bytes, pageNumber, pageDimensions, redactions, options }) {
    const bounds = redactions.map((rectangle) =>
      toNormalizedRect(rectangle, pageDimensions.width, pageDimensions.height),
    );
    const png = await runPacketEngineInWorker({
      operation: "redactedPreview",
      bytes,
      pageNumber,
      bounds,
      expectedDimensions: pageDimensions,
      options,
    });
    return Buffer.from(png as Uint8Array);
  },

  async generateSanitizedPacket({ bytes, manufacturer, redactionsByPage, pageDimensions, pageOrder }) {
    // The service's stored selection is in PDF points (top-left origin); the
    // raster engine's public contract deliberately uses normalized bounds.
    const dimensionsSource =
      pageDimensions ??
      (await analyzePdfInWorker(bytes, manufacturer)).pages.map((page) => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
      }));
    const dimensions = new Map(dimensionsSource.map((page) => [page.pageNumber, page] as const));
    const pages = Object.entries(redactionsByPage).map(([pageNumber, rectangles]) => {
      const page = dimensions.get(Number(pageNumber));
      if (!page) {
        throw new PacketEngineError("INVALID_SELECTION", "Selection contains a page not present in the PDF.");
      }
      return {
        pageNumber: Number(pageNumber),
        bounds: rectangles.map((rectangle) => toNormalizedRect(rectangle, page.width, page.height)),
        expectedWidth: page.width,
        expectedHeight: page.height,
      };
    });
    const sanitized = (await runPacketEngineInWorker({
      operation: "sanitize",
      bytes,
      selection: { pages, pageOrder },
    })) as SanitizedPacket;
    return {
      pdfBytes: sanitized.pdf,
      pages: sanitized.pages,
    };
  },
};