import type { NormalizedRect } from "./profiles";
import type { RenderPreviewOptions } from "./engine";

export type PacketWorkerRequest =
  | {
      operation: "analyze";
      bytes: Uint8Array;
      manufacturer?: string;
    }
  | {
      operation: "sanitize";
      bytes: Uint8Array;
      selection: {
        pages: ReadonlyArray<{ pageNumber: number; bounds: readonly NormalizedRect[] }>;
        pageOrder?: readonly number[];
      };
    }
  | {
      operation: "preview";
      bytes: Uint8Array;
      pageNumber: number;
      options?: RenderPreviewOptions;
    };

export type PacketWorkerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string; code?: string } };