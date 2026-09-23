import { parentPort } from "node:worker_threads";

import {
  analyzePdf,
  renderPdfPreview,
  renderRedactedPdfPreview,
  sanitizePdf,
  mergePacketPdfFiles,
  openSanitizationDocumentSession,
} from "./engine";
import type { PacketWorkerRequest, PacketWorkerResponse } from "./workerProtocol";
import type { PacketSessionRequest, PacketSessionProgress } from "./workerProtocol";

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

let session: Awaited<ReturnType<typeof openSanitizationDocumentSession>> | undefined;
let busy = false;
const progress = (phase: PacketSessionProgress["phase"], pageNumber?: number, elapsedMs?: number) =>
  port.postMessage({ progress: { phase, pageNumber, elapsedMs, rss: process.memoryUsage().rss } });

port.on("message", async (request: PacketWorkerRequest | PacketSessionRequest) => {
  try {
    if (busy) throw new Error("Packet worker is busy.");
    busy = true;
    if (request.operation === "sessionOpen") {
      if (session) throw new Error("Packet session source is already fixed.");
      progress("startup", undefined, process.uptime() * 1000);
      session = await openSanitizationDocumentSession(Buffer.from(request.bytes), request.selection, progress);
      progress("idle");
      port.postMessage({ ok: true, result: null });
      return;
    }
    if (request.operation === "sessionBatch") {
      if (!session) throw new Error("Packet session is not open.");
      const result = await session.generateBatch(request.pageOrder);
      progress("idle");
      port.postMessage({ ok: true, result });
      return;
    }
    const result = await (request.operation === "mergeSanitizedBatchFiles"
      ? mergePacketPdfFiles(
          request.inputPaths,
          request.outputPath,
          request.expectedBatchPageGeometry,
        )
      : request.operation === "analyze"
      ? analyzePdf(Buffer.from(request.bytes), request.manufacturer)
      : request.operation === "preview"
        ? renderPdfPreview(Buffer.from(request.bytes), request.pageNumber, request.options)
        : request.operation === "redactedPreview"
          ? renderRedactedPdfPreview(
              Buffer.from(request.bytes),
              request.pageNumber,
              request.bounds,
              request.expectedDimensions,
              request.options,
            )
        : sanitizePdf(Buffer.from(request.bytes), request.selection));
    port.postMessage({ ok: true, result } satisfies PacketWorkerResponse);
  } catch (error) {
    await session?.close();
    session = undefined;
    port.postMessage(serializeError(error));
  } finally {
    busy = false;
  }
});