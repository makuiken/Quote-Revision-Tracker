import {
  PacketWorkerAbortedError,
  PacketWorkerTimeoutError,
} from "./workerClient";

type SubscriberOptions = {
  signal?: AbortSignal;
  deadlineAt: number;
};

type Flight<T> = {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
};

/**
 * Shares immutable preview generation without coupling the lifetime of one
 * HTTP request to the others. The underlying work is cancelled only when its
 * last subscriber leaves (or the first request's hard deadline expires).
 */
export class PreviewSingleflight<T> {
  private readonly flights = new Map<string, Flight<T>>();

  subscribe(
    key: string,
    work: (options: { signal: AbortSignal; deadlineAt: number }) => Promise<T>,
    options: SubscriberOptions,
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new PacketWorkerAbortedError());
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const deadlineAt = options.deadlineAt;
      let createdFlight!: Flight<T>;
      const deadlineTimer = setTimeout(
        () => controller.abort(new PacketWorkerTimeoutError(Math.max(0, deadlineAt - Date.now()))),
        Math.max(0, deadlineAt - Date.now()),
      );
      deadlineTimer.unref?.();
      const promise = work({ signal: controller.signal, deadlineAt })
        .catch((error: unknown) => {
          // Worker/download cancellation is the mechanism used to enforce the
          // flight deadline. Preserve timeout semantics for HTTP callers.
          if (controller.signal.reason instanceof PacketWorkerTimeoutError) {
            throw controller.signal.reason;
          }
          throw error;
        })
        .finally(() => {
          clearTimeout(deadlineTimer);
          if (this.flights.get(key) === createdFlight) this.flights.delete(key);
        });
      // A subscriber attaches below in the same turn, but suppress a transient
      // unhandled rejection if work fails synchronously.
      void promise.catch(() => undefined);
      flight = createdFlight = { controller, promise, subscribers: 0 };
      this.flights.set(key, flight);
    }
    flight.subscribers++;
    return this.waitForSubscriber(flight, options);
  }

  private waitForSubscriber(flight: Flight<T>, options: SubscriberOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        flight.subscribers--;
        if (flight.subscribers === 0) {
          // Make a subsequent request create fresh work immediately rather
          // than subscribing to the now-aborted promise while it settles.
          for (const [key, current] of this.flights) {
            if (current === flight) {
              this.flights.delete(key);
              break;
            }
          }
          flight.controller.abort();
        }
        callback();
      };
      const onAbort = () => finish(() => reject(new PacketWorkerAbortedError()));
      const timer = setTimeout(
        () => finish(() => reject(new PacketWorkerTimeoutError(Math.max(0, options.deadlineAt - Date.now())))),
        Math.max(0, options.deadlineAt - Date.now()),
      );
      timer.unref?.();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (options.signal?.aborted) onAbort();
    });
  }

  get activeCount(): number {
    return this.flights.size;
  }
}