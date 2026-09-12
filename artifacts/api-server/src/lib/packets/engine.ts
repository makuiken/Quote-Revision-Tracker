import { PDFDocument } from "pdf-lib";
import type { PacketEngine, PacketPageAnalysis as StoredPageAnalysis, PacketPageType as StoredPageType, RedactionRect } from "./types";
import { runPacketEngineInWorker } from "./workerClient";

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
  try {
    const [pdfjs, canvas] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("@napi-rs/canvas"),
    ]);
    return { pdfjs: pdfjs as unknown as PdfJsModule, canvas: canvas as unknown as CanvasModule };
  } catch (error) {
    throw new PacketEngineError(
      "RENDER_FAILED",
      `Packet rendering dependencies are unavailable: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
  }
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

function dimensionsFor(page: PdfJsPage, limits: PacketEngineLimits): { width: number; height: number; rotation: number } {
  const [left, bottom, right, top] = page.view;
  const width = Math.abs(right - left);
  const height = Math.abs(top - bottom);
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
  return { width, height, rotation: ((page.rotate % 360) + 360) % 360 };
}

function textLinesFromContent(items: readonly unknown[], width: number, height: number): TextLine[] {
  const lines = new Map<string, { text: string[]; x: number; y: number; right: number; bottom: number }>();
  for (const value of items) {
    if (typeof value !== "object" || value === null) continue;
    const item = value as {
      str?: unknown;
      width?: unknown;
      height?: unknown;
      transform?: unknown;
    };
    if (typeof item.str !== "string" || !Array.isArray(item.transform) || item.transform.length < 6) continue;
    const transform = item.transform as number[];
    const x = transform[4];
    const baseline = transform[5];
    const itemWidth = typeof item.width === "number" ? Math.abs(item.width) : 0;
    const itemHeight = typeof item.height === "number" && item.height > 0 ? item.height : Math.abs(transform[3]) || 8;
    if (![x, baseline, itemWidth, itemHeight].every(Number.isFinite)) continue;
    const key = `${Math.round(baseline * 2)}`;
    const current = lines.get(key) ?? {
      text: [],
      x,
      y: baseline,
      right: x,
      bottom: baseline - itemHeight,
    };
    current.text.push(item.str);
    current.x = Math.min(current.x, x);
    current.right = Math.max(current.right, x + itemWidth);
    current.y = Math.max(current.y, baseline);
    current.bottom = Math.min(current.bottom, baseline - itemHeight);
    lines.set(key, current);
  }

  return [...lines.values()]
    .map((line) => {
      const padding = 2;
      const left = Math.max(0, line.x - padding);
      const right = Math.min(width, line.right + padding);
      const bottom = Math.max(0, line.bottom - padding);
      const top = Math.min(height, line.y + padding);
      return {
        text: line.text.join(" ").replace(/\s+/g, " ").trim(),
        bounds: {
          x: left / width,
          y: 1 - top / height,
          width: Math.max(0, right - left) / width,
          height: Math.max(0, top - bottom) / height,
        },
      };
    })
    .filter((line) => line.text.length > 0 && isNormalizedRect(line.bounds));
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

function rectForImageTransform(matrix: number[], width: number, height: number): NormalizedRect | undefined {
  const points = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => [matrix[0]! * x + matrix[2]! * y + matrix[4]!, matrix[1]! * x + matrix[3]! * y + matrix[5]!]);
  const left = Math.max(0, Math.min(...points.map(([x]) => x!)));
  const right = Math.min(width, Math.max(...points.map(([x]) => x!)));
  const bottom = Math.max(0, Math.min(...points.map(([, y]) => y!)));
  const top = Math.min(height, Math.max(...points.map(([, y]) => y!)));
  const bounds = {
    x: left / width,
    y: 1 - top / height,
    width: (right - left) / width,
    height: (top - bottom) / height,
  };
  return isNormalizedRect(bounds) ? bounds : undefined;
}

/**
 * PDF image resource IDs are deterministic within a document. A repeated ID is
 * a useful review signal for a recurring visual mark, but never becomes an
 * automatic redaction (product drawings and manufacturer logos are preserved).
 */
function imagePlacementsFromOperators(
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  ops: Record<string, number>,
  width: number,
  height: number,
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
      const bounds = rectForImageTransform(transform, width, height);
      if (bounds) placements.push({ key: String(args[0]), bounds });
    }
  }
  return placements;
}

function selectionMap(
  selection: SanitizationSelection,
  pageCount: number,
  limits: PacketEngineLimits,
): Map<number, readonly NormalizedRect[]> {
  if (!selection || !Array.isArray(selection.pages)) {
    throw new PacketEngineError("INVALID_SELECTION", "A page-by-page sanitization selection is required.");
  }
  const selected = new Map<number, readonly NormalizedRect[]>();
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
    selected.set(entry.pageNumber, entry.bounds);
  }
  return selected;
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
    await page.render({ canvasContext: context, viewport }).promise;
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
  return { png: output.toBuffer("image/png"), width: pixelWidth, height: pixelHeight };
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
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      assertWithinDeadline(startedAt, limits);
      const page = await document.getPage(pageNumber);
      try {
        const { width, height, rotation } = dimensionsFor(page, limits);
        const lines = textLinesFromContent((await page.getTextContent()).items, width, height);
        const { pdfjs } = await loadLibraries();
        const images = imagePlacementsFromOperators(await page.getOperatorList(), pdfjs.OPS, width, height);
        const text = pageText(lines);
        documentText += `\n${text}`;
        drafts.push({ pageNumber, width, height, rotation, lines, images });
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
      const regions = findAdministrativeRegions(draft.lines).map((region) =>
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
            // A narrow, repeated Marvin mark is a vendor-logo candidate. It
            // remains explicitly reviewable, but is surfaced through the
            // service adapter so an admin can retain or remove it manually.
            suggested: isMarvinLogoCandidate,
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
    const warnings =
      profile === "unknown"
        ? ["Unknown manufacturer/layout: no automatic branding bounds were proposed; manual review is required."]
        : [
            "Suggested bounds are limited to narrow dealer/admin identity text. Review each selection before sanitizing.",
            "Product specifications, technical manufacturer names, prices, terms, warranties, and dates are not automatically selected.",
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
    let totalPixels = 0;
    for (const [outputPageIndex, sourcePageNumber] of sourcePageOrder.entries()) {
      assertWithinDeadline(startedAt, limits);
      const page = await document.getPage(sourcePageNumber);
      try {
        const dimensions = dimensionsFor(page, limits);
        const rendered = await renderPage(page, dpi, limits, selected.get(sourcePageNumber) ?? []);
        totalPixels += rendered.width * rendered.height;
        if (totalPixels > limits.maxTotalPixels) {
          throw new PacketEngineError("LIMIT_EXCEEDED", "Packet raster pixels exceed the document limit.");
        }
        const embedded = await output.embedPng(rendered.png);
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
    const pdf = Buffer.from(await output.save({ addDefaultPage: false, useObjectStreams: true }));
    if (pdf.length > limits.maxOutputBytes) {
      throw new PacketEngineError("LIMIT_EXCEEDED", "Sanitized PDF exceeds the output byte limit.");
    }
    assertWithinDeadline(startedAt, limits);
    return { pdf, pagePngs, pages, pageCount: sourcePageOrder.length, renderDpi: dpi };
  } finally {
    await closeDocument(document);
  }
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