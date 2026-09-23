import type { NormalizedRect } from "./profiles";
import type { RenderPreviewOptions, SanitizationSelection } from "./engine";

export const SANITIZED_BATCH_MERGE_LIMITS = {
  maxInputBytes: 100 * 1024 * 1024,
  maxOutputBytes: 100 * 1024 * 1024,
  maxPages: 100,
} as const;

export type ExpectedBatchPageGeometry = { width: number; height: number }[][];

export type PacketSessionProgress = {
  phase: "startup" | "open" | "preflight" | "page" | "draw" | "png" | "embed" | "save" | "idle";
  pageNumber?: number;
  elapsedMs?: number;
  rss: number;
};
export type PacketSessionRequest =
  | { operation: "sessionOpen"; bytes: Uint8Array; selection: SanitizationSelection }
  | { operation: "sessionBatch"; pageOrder: number[] };
export type PacketSessionResponse =
  | { progress: PacketSessionProgress }
  | PacketWorkerResponse;

export type PacketWorkerRequest =
  | {
      operation: "analyze";
      bytes: Uint8Array;
      manufacturer?: string;
    }
  | {
      operation: "sanitize";
      bytes: Uint8Array;
      selection: SanitizationSelection;
    }
  | {
      operation: "mergeSanitizedBatchFiles";
      inputPaths: string[];
      outputPath: string;
      expectedBatchPageGeometry?: ExpectedBatchPageGeometry;
    }
  | {
      operation: "preview";
      bytes: Uint8Array;
      pageNumber: number;
      options?: RenderPreviewOptions;
    }
  | {
      operation: "redactedPreview";
      bytes: Uint8Array;
      pageNumber: number;
      bounds: readonly NormalizedRect[];
      expectedDimensions: { width: number; height: number };
      options?: RenderPreviewOptions;
    };

export type PacketWorkerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string; code?: string } };