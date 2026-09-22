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
  progress: ProcessingProgress;
};
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
  return state;
}
export function resetRenderCheckpoints(value: unknown): PacketProcessingState | null {
  const state = readProcessingState(value);
  return state ? { ...state, renderKey: null, batches: [], progress: {
    stage: "queued", completedPages: 0, totalPages: state.analysis.pages.length,
  } } : null;
}
export function resumeRender(state: PacketProcessingState, renderKey: string): PacketProcessingState {
  return state.renderKey === renderKey ? state : { ...state, renderKey, batches: [],
    progress: { stage: "rendering", completedPages: 0, totalPages: state.analysis.pages.length } };
}
export function checkpointObjectPaths(value: unknown): string[] {
  const state = readProcessingState(value);
  return state?.batches.flatMap((batch) => [batch.pdfPath, ...batch.pagePaths]) ?? [];
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
/** A prefix is the only reusable shape. Gaps/duplicates can never be published. */
export function completedCheckpointPages(state: PacketProcessingState): number {
  let completed = 0;
  let bytes = 0;
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
    bytes += batch.pdfBytes + batch.pngBytes;
  }
  if (completed > state.analysis.pages.length || bytes > MAX_CHECKPOINT_BYTES) {
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