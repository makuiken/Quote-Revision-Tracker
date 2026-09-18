import { Worker } from "node:worker_threads";

import type { PacketWorkerRequest, PacketWorkerResponse } from "./workerProtocol";

export const MAX_PACKET_ENGINE_WORKERS = 1;
export const PACKET_ENGINE_WORKER_TIMEOUT_MS = 90_000;
export const PACKET_ENGINE_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 384,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8,
} as const;

export class PacketWorkerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`PDF processing exceeded the ${timeoutMs}ms hard wall-clock limit.`);
    this.name = "PacketWorkerTimeoutError";
  }
}

export class PacketWorkerError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "PacketWorkerError";
  }
}

/**
 * A tiny priority semaphore. Limiting worker creation bounds native canvas
 * memory; prioritizing packet state transitions prevents a burst of optional
 * page previews from starving upload analysis or sanitization.
 */
export function createBoundedWorkerQueue(maxConcurrent = MAX_PACKET_ENGINE_WORKERS) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Packet worker concurrency must be a positive integer.");
  }
  let active = 0;
  const pending: Array<{ start: () => void; priority: "high" | "normal" }> = [];

  const drain = () => {
    while (active < maxConcurrent && pending.length > 0) {
      active++;
      pending.shift()!.start();
    }
  };

  return {
    run<T>(
      job: () => Promise<T>,
      priority: "high" | "normal" = "normal",
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const entry = {
          priority,
          start: () => {
            void job().then(resolve, reject).finally(() => {
              active--;
              drain();
            });
          },
        };
        const firstNormal = pending.findIndex((item) => item.priority === "normal");
        if (priority === "high" && firstNormal >= 0) {
          pending.splice(firstNormal, 0, entry);
        } else {
          pending.push(entry);
        }
        drain();
      });
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

const workerQueue = createBoundedWorkerQueue();

/**
 * Handles one worker response and forcibly terminates the worker at deadline.
 * Parsing and native rasterization do not provide useful cancellation points,
 * so this is intentionally process-level rather than a Promise.race alone.
 */
export function runWorkerWithDeadline(
  worker: Worker,
  request: PacketWorkerRequest,
  timeoutMs = PACKET_ENGINE_WORKER_TIMEOUT_MS,
  transferList: ArrayBuffer[] = [],
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      void worker.terminate();
      callback();
    };
    const onMessage = (response: PacketWorkerResponse) => {
      if (response?.ok) {
        finish(() => resolve(response.result));
      } else {
        const error = response && "error" in response ? response.error : undefined;
        finish(() => reject(new PacketWorkerError(error?.message ?? "Packet worker failed.", error?.code)));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number) => {
      if (code !== 0) finish(() => reject(new PacketWorkerError(`Packet worker exited unexpectedly (${code}).`)));
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new PacketWorkerTimeoutError(timeoutMs)));
    }, timeoutMs);

    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.postMessage(request, transferList);
  });
}

function spawnPacketWorker(): Worker {
  return new Worker(new URL("./packets-engine-worker.mjs", import.meta.url), {
    resourceLimits: PACKET_ENGINE_WORKER_RESOURCE_LIMITS,
    // `--input-type` is valid only for the parent stdin/eval invocation, not
    // for a worker file. Excluding it also keeps CLI verification callers from
    // changing the deployed worker's startup behavior.
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
  });
}

export function runPacketEngineInWorker(request: PacketWorkerRequest): Promise<unknown> {
  // Copy then transfer the exact input view. The caller's upload buffer remains
  // usable while the worker owns its independent bytes.
  const bytes = new Uint8Array(request.bytes);
  const copiedRequest = { ...request, bytes } as PacketWorkerRequest;
  return workerQueue.run(
    () =>
      runWorkerWithDeadline(
        spawnPacketWorker(),
        copiedRequest,
        PACKET_ENGINE_WORKER_TIMEOUT_MS,
        [bytes.buffer as ArrayBuffer],
      ),
    request.operation === "preview" ? "normal" : "high",
  );
}