import { Worker } from "node:worker_threads";

import type { PacketWorkerRequest, PacketWorkerResponse } from "./workerProtocol";
import type { PacketSessionRequest, PacketSessionResponse, PacketSessionProgress } from "./workerProtocol";

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

export class PacketWorkerQueueWaitError extends Error {
  constructor() { super("PDF processing queue wait limit exceeded."); this.name = "PacketWorkerQueueWaitError"; }
}
export type PacketSessionOptions = PacketWorkerRunOptions & {
  onProgress?: (progress: PacketSessionProgress) => void;
  /** Fires before waiting for in-flight checkpoint callbacks to settle. */
  onFailure?: (error: Error, progress: PacketSessionProgress | undefined) => void;
};
export const PACKET_SESSION_MAX_LIFETIME_MS = 15 * 60_000;
export const PACKET_SESSION_IDLE_MS = 90_000;

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
            void Promise.resolve()
              .then(job)
              .then(
                (value) => {
                  active--;
                  drain();
                  resolve(value);
                },
                (error: unknown) => {
                  active--;
                  drain();
                  reject(error);
                },
              );
          },
        };

        const deadlineWait = options.deadlineAt === undefined
          ? Number.POSITIVE_INFINITY
          : options.deadlineAt - Date.now();
        const waitMs = Math.min(options.maxWaitMs ?? Number.POSITIVE_INFINITY, deadlineWait);
        if (waitMs <= 0) {
          reject(new PacketWorkerQueueWaitError());
          return;
        }
        if (Number.isFinite(waitMs)) {
          waitTimer = setTimeout(
            () => cancel(new PacketWorkerQueueWaitError()),
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

/** Command timers are never refreshed by worker progress. */
export function runPacketSanitizationSession<T>(
  request: Extract<PacketSessionRequest, { operation: "sessionOpen" }>,
  callback: (generate: (order: number[]) => Promise<unknown>) => Promise<T>,
  options: PacketSessionOptions = {},
): Promise<T> {
  return workerQueue.run(async () => {
    const startupAt = Date.now();
    const worker = spawnPacketWorker();
    let failure: Error | undefined;
    let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
    let timer: NodeJS.Timeout | undefined;
    let lifetime: NodeJS.Timeout | undefined;
    let closed = false;
    let lastProgress: PacketSessionProgress | undefined;
    let callbackWork: Promise<T> | undefined;
    let termination: Promise<number> | undefined;
    let rejectFatal!: (error: Error) => void;
    const fatal = new Promise<never>((_, reject) => { rejectFatal = reject; });
    // Fatal events can occur during open before the callback race is installed.
    void fatal.catch(() => {});
    const fail = (error: Error) => {
      if (failure || closed) return;
      failure = error;
      termination = worker.terminate();
      void termination.catch(() => {});
      try { options.onFailure?.(error, lastProgress); } catch { /* Preserve original failure. */ }
      pending?.reject(error);
      pending = undefined;
      rejectFatal(error);
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new PacketWorkerTimeoutError(ms)), ms);
      timer.unref?.();
    };
    const onAbort = () => fail(new PacketWorkerAbortedError());
    const onError = (error: Error) => fail(error);
    const onExit = (code: number) => fail(new PacketWorkerError(`Packet session worker exited (${code}).`));
    const onMessage = (message: PacketSessionResponse) => {
      if (closed || failure) return;
      if ("progress" in message) {
        if (message.progress.phase === "startup") message.progress.elapsedMs = Date.now() - startupAt;
        lastProgress = message.progress;
        try { options.onProgress?.(message.progress); } catch (error) {
          fail(error instanceof Error ? error : new Error("Session progress callback failed."));
        }
        return;
      }
      if (!pending) { fail(new PacketWorkerError("Unexpected session response.")); return; }
      if (!message.ok) { fail(new PacketWorkerError(message.error.message, message.error.code)); return; }
      const current = pending;
      pending = undefined;
      arm(PACKET_SESSION_IDLE_MS);
      current.resolve(message.result);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const command = (message: PacketSessionRequest, transfer: ArrayBuffer[] = []) => {
      if (failure || closed) return Promise.reject(failure ?? new PacketWorkerError("Session is closed."));
      if (pending) {
        const error = new PacketWorkerError("Session batches must be awaited sequentially.");
        fail(error);
        return Promise.reject(error);
      }
      arm(PACKET_ENGINE_WORKER_TIMEOUT_MS);
      return new Promise<unknown>((resolve, reject) => {
        pending = { resolve, reject };
        try { worker.postMessage(message, transfer); } catch (error) {
          fail(error instanceof Error ? error : new Error("Session command failed."));
        }
      });
    };
    try {
      const remaining = Math.min(PACKET_SESSION_MAX_LIFETIME_MS, (options.deadlineAt ?? Infinity) - Date.now());
      if (remaining <= 0) throw new PacketWorkerTimeoutError(0);
      lifetime = setTimeout(() => fail(new PacketWorkerTimeoutError(remaining)), remaining);
      lifetime.unref?.();
      if (options.signal?.aborted) throw new PacketWorkerAbortedError();
      const bytes = new Uint8Array(request.bytes);
      await command({ ...request, bytes }, [bytes.buffer]);
      callbackWork = Promise.resolve().then(() => callback((pageOrder) => command({ operation: "sessionBatch", pageOrder })));
      return await Promise.race([fatal, callbackWork]);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Packet session callback failed."));
      throw error;
    } finally {
      closed = true;
      pending?.reject(failure ?? new PacketWorkerError("Session callback completed with an outstanding batch."));
      clearTimeout(timer);
      clearTimeout(lifetime);
      options.signal?.removeEventListener("abort", onAbort);
      // Keep error/exit listeners until termination has completed.
      await (termination ?? worker.terminate());
      // Checkpoint writes cannot be cancelled by worker termination. Do not let
      // service cleanup race those writes; keep capacity until callback settles.
      await callbackWork?.catch(() => {});
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    }
  }, "high", { ...options, maxWaitMs: PACKET_ENGINE_WORKER_TIMEOUT_MS });
}

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
      finish(() => reject(new PacketWorkerError(`Packet worker exited without a result (${code}).`)));
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
    try {
      worker.postMessage(request, transferList);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function spawnPacketWorker(): Worker {
  return new Worker(new URL("./packets-engine-worker.mjs", import.meta.url), {
    resourceLimits: PACKET_ENGINE_WORKER_RESOURCE_LIMITS,
    // Bundled ESM workers need no loaders. Host-injected V8/TLS flags are
    // rejected by Worker when explicitly copied into execArgv.
    execArgv: process.execArgv.filter((argument) => argument === "--enable-source-maps"),
  });
}

export function runPacketEngineInWorker(
  request: PacketWorkerRequest,
  options: PacketWorkerRunOptions = {},
): Promise<unknown> {
  const operation: string = request.operation;
  const preview = operation === "preview" || operation === "redactedPreview";
  if (request.operation === "mergeSanitizedBatchFiles") {
    options = { ...options, deadlineAt: Math.min(
      options.deadlineAt ?? Infinity,
      Date.now() + PACKET_ENGINE_WORKER_TIMEOUT_MS,
    ) };
  }
  return workerQueue.run(
    () => {
      if (options.signal?.aborted) throw new PacketWorkerAbortedError();
      const remaining = options.deadlineAt === undefined
        ? PACKET_ENGINE_WORKER_TIMEOUT_MS
        : Math.min(PACKET_ENGINE_WORKER_TIMEOUT_MS, options.deadlineAt - Date.now());
      if (remaining <= 0) throw new PacketWorkerTimeoutError(0);
      // Copy only after admission. Queued callers retain their existing view
      // rather than doubling every large PDF in memory under backpressure.
      if (request.operation === "mergeSanitizedBatchFiles") {
        return runWorkerWithDeadline(spawnPacketWorker(), request, remaining, [], options.signal);
      }
      const copies = [new Uint8Array(request.bytes)];
      const copiedRequest = { ...request, bytes: copies[0]! };
      return runWorkerWithDeadline(
        spawnPacketWorker(),
        copiedRequest,
        remaining,
        copies.map((bytes) => bytes.buffer as ArrayBuffer),
        options.signal,
      );
    },
    preview ? "normal" : "high",
    options,
  );
}