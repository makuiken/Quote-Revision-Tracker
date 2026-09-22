export type PreviewQueueEntry = {
  cancelled: boolean;
  grant: () => void;
};

export class PreviewFetchScheduler {
  private readonly queue: PreviewQueueEntry[] = [];
  private active = 0;

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Preview concurrency must be a positive integer.");
    }
  }

  schedule(grant: () => void): () => void {
    let granted = false;
    const entry: PreviewQueueEntry = {
      cancelled: false,
      grant: () => {
        granted = true;
        grant();
      },
    };
    this.queue.push(entry);
    this.drain();

    return () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      if (granted) {
        this.active = Math.max(0, this.active - 1);
        this.drain();
      }
    };
  }

  get activeCount() {
    return this.active;
  }

  // Admission belongs to the actual request promise, never a React effect or
  // query observer. Unmount/abort must not free a slot before fetch settles.
  run<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const abort = () => {
        if (started) return;
        cancel();
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      const cancel = this.schedule(() => {
        started = true;
        // Defer invocation so the release callback is initialized even when
        // admission is synchronous or the request throws synchronously.
        Promise.resolve().then(() => {
          if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          return request();
        }).then(resolve, reject).finally(() => {
          signal?.removeEventListener("abort", abort);
          cancel();
        });
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  get queuedCount() {
    return this.queue.filter((entry) => !entry.cancelled).length;
  }

  private drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next || next.cancelled) continue;
      this.active += 1;
      next.grant();
    }
  }
}

export type DragPoint = { x: number; y: number };
export type DragBounds = { width: number; height: number };

export function redactionFromDrag(
  start: DragPoint,
  end: DragPoint,
  bounds: DragBounds,
  minimumSize = 10,
) {
  const endX = Math.max(0, Math.min(bounds.width, end.x));
  const endY = Math.max(0, Math.min(bounds.height, end.y));
  const width = Math.abs(endX - start.x);
  const height = Math.abs(endY - start.y);
  if (width <= minimumSize || height <= minimumSize) return null;
  return {
    x: Math.min(start.x, endX),
    y: Math.min(start.y, endY),
    width,
    height,
    reason: "Manual Redaction",
  };
}