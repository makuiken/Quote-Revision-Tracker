import { parentPort } from "node:worker_threads";

import { analyzePdf, renderPdfPreview, sanitizePdf } from "./engine";
import type { PacketWorkerRequest, PacketWorkerResponse } from "./workerProtocol";

const port = parentPort;
if (!port) {
  throw new Error("Packet engine worker must be started by a parent thread.");
}

function serializeError(error: unknown): PacketWorkerResponse {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string };
    return {
      ok: false,
      error: { name: error.name, message: error.message, code: withCode.code },
    };
  }
  return { ok: false, error: { name: "Error", message: "Packet worker failed." } };
}

port.on("message", async (request: PacketWorkerRequest) => {
  try {
    const result = await (request.operation === "analyze"
      ? analyzePdf(Buffer.from(request.bytes), request.manufacturer)
      : request.operation === "preview"
        ? renderPdfPreview(Buffer.from(request.bytes), request.pageNumber, request.options)
        : sanitizePdf(Buffer.from(request.bytes), request.selection));
    port.postMessage({ ok: true, result } satisfies PacketWorkerResponse);
  } catch (error) {
    port.postMessage(serializeError(error));
  }
});