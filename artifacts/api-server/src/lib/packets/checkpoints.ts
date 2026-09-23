import { createHash } from "node:crypto";
import type { PacketPageAnalysis, RedactionRect } from "./types";

// Bump when analysis/profile semantics or the sanitized rendering contract changes.
export const ANALYZER_VERSION = "packet-analysis-v1";
export const RENDER_VERSION = "packet-raster-160dpi-v1";
export const CHECKPOINT_BATCH_SIZE = 2;
export const MAX_CHECKPOINT_BYTES = 100 * 1024 * 1024;
export type ProcessingProgress = {
  stage: string;
  completedPages: number;
  totalPages: number;
  errorStage?: string | null;
  reusedPages?: number;
  renderedPages?: number;
};
export type RenderCheckpoint = {
  pageNumbers: number[];
  pdfPath: string;
  pdfSha256: string;
  pdfBytes: number;
  pagePaths: string[];
  pngBytes: number;
};
export type PacketProcessingState = {
  version: 1;
  analysisKey: string;
  analysis: { pages: PacketPageAnalysis[]; profile: string };
  renderKey: string | null;
  batches: RenderCheckpoint[];
  reusablePages?: ReusablePage[];
  progress: ProcessingProgress;
};
export type ReusablePage = RenderCheckpoint & {
  reuseVersion: 1;
  pageKey: string;
  pngSha256: string;
};
export function pageFingerprint(sourceSha256: string, page: PacketPageAnalysis, rects: RedactionRect[]): string {
  const canonical = rects.map(({ x, y, width, height }) => [x, y, width, height])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return hash(["packet-page-v1", RENDER_VERSION, sourceSha256, page.pageNumber, page.width, page.height, canonical]);
}
/** Only single-page, packet-bound, integrity-bearing output is reusable. */
export function reusablePageValid(page: ReusablePage, quoteId: number, packetId: number): boolean {
  const prefix = `/objects/manufacturer-packets/${quoteId}/${packetId}/renders/`;
  const path = (value: string, extension: string) => typeof value === "string" &&
    value.startsWith(prefix) && new RegExp(`^[^/]+\\.${extension}$`).test(value.slice(prefix.length));
  return page?.reuseVersion === 1 && /^[a-f0-9]{64}$/.test(page.pageKey) &&
    /^[a-f0-9]{64}$/.test(page.pdfSha256) && /^[a-f0-9]{64}$/.test(page.pngSha256) &&
    Array.isArray(page.pageNumbers) && page.pageNumbers.length === 1 &&
    Number.isSafeInteger(page.pageNumbers[0]) && page.pageNumbers[0]! > 0 && page.pageNumbers[0]! <= 100 &&
    Array.isArray(page.pagePaths) && page.pagePaths.length === 1 &&
    path(page.pdfPath, "pdf") && path(page.pagePaths[0]!, "png") &&
    page.pagePaths[0]!.endsWith(`-page-${page.pageNumbers[0]}.png`) &&
    Number.isSafeInteger(page.pdfBytes) && page.pdfBytes > 0 &&
    Number.isSafeInteger(page.pngBytes) && page.pngBytes > 0 &&
    page.pdfBytes + page.pngBytes <= MAX_CHECKPOINT_BYTES;
}
export function boundedReusablePages(pages: ReusablePage[]): ReusablePage[] {
  const latest = new Map<number, ReusablePage>();
  for (const page of pages) latest.set(page.pageNumbers[0]!, page);
  let bytes = 0;
  return [...latest.values()].reverse().filter((page, index) => {
    bytes += page.pdfBytes + page.pngBytes;
    return index < 100 && bytes <= MAX_CHECKPOINT_BYTES;
  }).reverse();
}
export function verifyReusableBytes(page: ReusablePage, pdf: Uint8Array, png: Uint8Array): boolean {
  return pdf.length === page.pdfBytes && png.length === page.pngBytes &&
    createHash("sha256").update(pdf).digest("hex") === page.pdfSha256 &&
    createHash("sha256").update(png).digest("hex") === page.pngSha256;
}
export function selectReusablePages(
  state: PacketProcessingState, quoteId: number, packetId: number, pageKeys: string[],
): ReusablePage[] {
  return boundedReusablePages([
    ...(Array.isArray(state.reusablePages) ? state.reusablePages : []),
    ...state.batches as ReusablePage[],
  ].filter((page) => reusablePageValid(page, quoteId, packetId) &&
    page.pageKey === pageKeys[page.pageNumbers[0]! - 1]));
}
/** At most one page's compressed bytes are resident during verification. */
export async function loadReusablePage(
  page: ReusablePage, download: (path: string, limit: number) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const pdf = await download(page.pdfPath, page.pdfBytes);
  const png = await download(page.pagePaths[0]!, page.pngBytes);
  if (!verifyReusableBytes(page, pdf, png)) throw new Error("Cached page failed PDF/PNG integrity verification.");
  return pdf;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function analysisFingerprint(source: Uint8Array, manufacturer: string | null): string {
  return hash([ANALYZER_VERSION, createHash("sha256").update(source).digest("hex"), manufacturer]);
}
export function renderFingerprint(analysisKey: string, redactions: Record<string, RedactionRect[]>): string {
  return hash([RENDER_VERSION, analysisKey, Object.entries(redactions)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([page, rects]) => [page, rects.map(({ x, y, width, height }) => [x, y, width, height])])]);
}
export function readProcessingState(value: unknown): PacketProcessingState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as PacketProcessingState;
  if (state.version !== 1 || typeof state.analysisKey !== "string" ||
      !Array.isArray(state.analysis?.pages) || typeof state.analysis.profile !== "string" ||
      !Array.isArray(state.batches) || !state.progress) return null;
  return { ...state, reusablePages: Array.isArray(state.reusablePages) ? state.reusablePages : [] };
}
export function resetRenderCheckpoints(value: unknown, preserveReusable = false): PacketProcessingState | null {
  const state = readProcessingState(value);
  return state ? { ...state, renderKey: null, batches: [], reusablePages: preserveReusable ? state.reusablePages ?? [] : [], progress: {
    stage: "queued", completedPages: 0, totalPages: state.analysis.pages.length,
  } } : null;
}
export function resumeRender(state: PacketProcessingState, renderKey: string): PacketProcessingState {
  return state.renderKey === renderKey ? state : { ...state, renderKey, batches: [],
    progress: { stage: "rendering", completedPages: 0, totalPages: state.analysis.pages.length } };
}
export function checkpointObjectPaths(value: unknown): string[] {
  const state = readProcessingState(value);
  return state ? [...new Set([...state.batches, ...(state.reusablePages ?? [])].flatMap((batch) => [
    batch?.pdfPath, ...(Array.isArray(batch?.pagePaths) ? batch.pagePaths : []),
  ]).filter((path): path is string => typeof path === "string" && !!path))] : [];
}
export function assertDocumentBudget(pages: PacketPageAnalysis[]): void {
  if (!pages.length || pages.length > 100) throw new Error("Packet page count exceeds the document limit.");
  let pixels = 0;
  for (const page of pages) {
    const width = Math.ceil(page.width * 160 / 72);
    const height = Math.ceil(page.height * 160 / 72);
    if (!Number.isFinite(width * height) || width <= 0 || height <= 0 ||
        width * height > 24_000_000 || page.width > 14_400 || page.height > 14_400) {
      throw new Error("Packet page geometry exceeds the raster limit.");
    }
    pixels += width * height;
  }
  if (pixels > 120_000_000) throw new Error("Packet raster pixels exceed the document limit.");
}
/** Only the acknowledged prefix counts as completed. Candidates cannot publish gaps. */
export function completedCheckpointPages(state: PacketProcessingState): number {
  let completed = 0;
  const sizes = new Map<string, number>();
  const account = (path: string, bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 ||
        (sizes.has(path) && sizes.get(path) !== bytes)) throw new Error("Invalid packet checkpoint size.");
    sizes.set(path, bytes);
  };
  for (const batch of state.batches) {
    if (!batch.pageNumbers.length || batch.pageNumbers.length > CHECKPOINT_BATCH_SIZE ||
        batch.pagePaths.length !== batch.pageNumbers.length || !batch.pdfPath ||
        !/^[a-f0-9]{64}$/.test(batch.pdfSha256) ||
        !Number.isSafeInteger(batch.pdfBytes) || batch.pdfBytes <= 0 ||
        !Number.isSafeInteger(batch.pngBytes) || batch.pngBytes <= 0 ||
        batch.pagePaths.some((path) => !path)) throw new Error("Invalid packet checkpoint.");
    for (const page of batch.pageNumbers) {
      if (page !== ++completed) throw new Error("Packet checkpoint page order is incomplete.");
    }
    account(batch.pdfPath, batch.pdfBytes);
    // Legacy batches do not carry individual PNG sizes. They are only used
    // for legacy prefix validation; new reusable output is always one page.
    account(batch.pagePaths.join("\n"), batch.pngBytes);
  }
  for (const page of state.reusablePages ?? []) {
    account(page.pdfPath, page.pdfBytes);
    account(page.pagePaths.join("\n"), page.pngBytes);
  }
  const bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (completed > state.analysis.pages.length || bytes > MAX_CHECKPOINT_BYTES ||
      (state.reusablePages?.length ?? 0) > 100) {
    throw new Error("Packet checkpoint output exceeds the document limit.");
  }
  return completed;
}
export function assertCompleteCheckpoints(state: PacketProcessingState): void {
  if (!state.renderKey || !state.analysis.pages.length ||
      completedCheckpointPages(state) !== state.analysis.pages.length) {
    throw new Error("Cannot finalize an incomplete packet.");
  }
}
/** The durable reference is published only after every object write settles.
 * Callers retain their prior state until this operation acknowledges the fenced
 * commit. Ambiguous database outcomes must be reconciled from the durable row.
 */
export async function commitCheckpointBatch(
  nextState: PacketProcessingState,
  writeObjects: () => Promise<void>,
  commit: (state: PacketProcessingState) => Promise<boolean>,
): Promise<PacketProcessingState> {
  completedCheckpointPages(nextState);
  await writeObjects();
  if (!(await commit(nextState))) throw new Error("Packet processing lease was superseded.");
  return nextState;
}