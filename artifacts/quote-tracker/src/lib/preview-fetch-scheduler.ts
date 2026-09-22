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