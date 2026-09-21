import { Worker } from "node:worker_threads";

import type { PacketWorkerRequest, PacketWorkerResponse } from "./workerProtocol";

export const MAX_PACKET_ENGINE_WORKERS = 1;
export const MAX_PENDING_PREVIEW_JOBS = 4;
export const PACKET_ENGINE_WORKER_TIMEOUT_MS = 90_000;
export const PACKET_ENGINE_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 384,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8,
} as const;

export type PacketWorkerRunOptions = {
  signal?: AbortSignal;
  /** Absolute wall-clock deadline, including time spent waiting for a slot. */
  deadlineAt?: number;
};

export class PacketWorkerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`PDF processing exceeded the ${timeoutMs}ms hard wall-clock limit.`);
    this.name = "PacketWorkerTimeoutError";
  }
}

export class PacketWorkerQueueFullError extends Error {
  constructor() {
    super("PDF preview capacity is busy. Please retry shortly.");
    this.name = "PacketWorkerQueueFullError";
  }
}

export class PacketWorkerAbortedError extends Error {
  constructor() {
    super("PDF preview was cancelled.");
    this.name = "PacketWorkerAbortedError";
  }
}

export class PacketWorkerError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "PacketWorkerError";
  }
}

type QueueOptions = PacketWorkerRunOptions & { maxWaitMs?: number };

/**
 * A priority semaphore. Optional normal-priority work is bounded and
 * cancellable; high-priority packet state transitions are never rejected.
 */
export function createBoundedWorkerQueue(
  maxConcurrent = MAX_PACKET_ENGINE_WORKERS,
  maxPendingNormal = MAX_PENDING_PREVIEW_JOBS,
) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Packet worker concurrency must be a positive integer.");
  }
  if (!Number.isInteger(maxPendingNormal) || maxPendingNormal < 0) {
    throw new Error("Packet preview queue capacity must be a non-negative integer.");
  }
  let active = 0;
  const pending: Array<{
    start: () => void;
    priority: "high" | "normal";
    cancel: (error: Error) => void;
  }> = [];

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
      options: QueueOptions = {},
    ): Promise<T> {
      if (options.signal?.aborted) return Promise.reject(new PacketWorkerAbortedError());
      const normalPending = pending.reduce(
        (count, item) => count + (item.priority === "normal" ? 1 : 0),
        0,
      );
      if (priority === "normal" && active >= maxConcurrent && normalPending >= maxPendingNormal) {
        return Promise.reject(new PacketWorkerQueueFullError());
      }

      return new Promise<T>((resolve, reject) => {
        let waitTimer: NodeJS.Timeout | undefined;
        let started = false;
        const remove = () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        };
        const cleanupWait = () => {
          if (waitTimer) clearTimeout(waitTimer);
          options.signal?.removeEventListener("abort", onAbort);
        };
        const cancel = (error: Error) => {
          if (started) return;
          remove();
          cleanupWait();
          reject(error);
          drain();
        };
        const onAbort = () => cancel(new PacketWorkerAbortedError());
        const entry = {
          priority,
          cancel,
          start: () => {
            started = true;
            cleanupWait();
            void job().then(resolve, reject).finally(() => {
              active--;
              drain();
            });
          },
        };

        const deadlineWait = options.deadlineAt === undefined
          ? Number.POSITIVE_INFINITY
          : options.deadlineAt - Date.now();
        const waitMs = Math.min(options.maxWaitMs ?? Number.POSITIVE_INFINITY, deadlineWait);
        if (waitMs <= 0) {
          reject(new PacketWorkerTimeoutError(0));
          return;
        }
        if (Number.isFinite(waitMs)) {
          waitTimer = setTimeout(
            () => cancel(new PacketWorkerTimeoutError(Math.max(0, Math.round(waitMs)))),
            waitMs,
          );
          waitTimer.unref?.();
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });

        const firstNormal = pending.findIndex((item) => item.priority === "normal");
        if (priority === "high" && firstNormal >= 0) pending.splice(firstNormal, 0, entry);
        else pending.push(entry);
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
 * Terminates and awaits worker shutdown on every completion path. In
 * particular, cancellation does not release the semaphore slot while native
 * PDF/canvas code can still be running.
 */
export function runWorkerWithDeadline(
  worker: Worker,
  request: PacketWorkerRequest,
  timeoutMs = PACKET_ENGINE_WORKER_TIMEOUT_MS,
  transferList: ArrayBuffer[] = [],
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      void worker.terminate().then(callback, callback);
    };
    const onMessage = (response: PacketWorkerResponse) => {
      if (response?.ok) finish(() => resolve(response.result));
      else {
        const error = response && "error" in response ? response.error : undefined;
        finish(() => reject(new PacketWorkerError(error?.message ?? "Packet worker failed.", error?.code)));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number) => {
      if (code !== 0) finish(() => reject(new PacketWorkerError(`Packet worker exited unexpectedly (${code}).`)));
    };
    const onAbort = () => finish(() => reject(new PacketWorkerAbortedError()));
    timeout = setTimeout(
      () => finish(() => reject(new PacketWorkerTimeoutError(timeoutMs))),
      Math.max(0, timeoutMs),
    );
    timeout.unref?.();

    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    worker.postMessage(request, transferList);
  });
}

function spawnPacketWorker(): Worker {
  return new Worker(new URL("./packets-engine-worker.mjs", import.meta.url), {
    resourceLimits: PACKET_ENGINE_WORKER_RESOURCE_LIMITS,
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
  });
}

export function runPacketEngineInWorker(
  request: PacketWorkerRequest,
  options: PacketWorkerRunOptions = {},
): Promise<unknown> {
  const operation: string = request.operation;
  const preview = operation === "preview" || operation === "redactedPreview";
  return workerQueue.run(
    () => {
      if (options.signal?.aborted) throw new PacketWorkerAbortedError();
      const remaining = options.deadlineAt === undefined
        ? PACKET_ENGINE_WORKER_TIMEOUT_MS
        : Math.min(PACKET_ENGINE_WORKER_TIMEOUT_MS, options.deadlineAt - Date.now());
      if (remaining <= 0) throw new PacketWorkerTimeoutError(0);
      // Copy only after admission. Queued callers retain their existing view
      // rather than doubling every large PDF in memory under backpressure.
      const bytes = new Uint8Array(request.bytes);
      const copiedRequest = { ...request, bytes } as PacketWorkerRequest;
      return runWorkerWithDeadline(
        spawnPacketWorker(),
        copiedRequest,
        remaining,
        [bytes.buffer as ArrayBuffer],
        options.signal,
      );
    },
    preview ? "normal" : "high",
    options,
  );
}