import assert from "node:assert/strict";
import test from "node:test";

import { PacketWorkerAbortedError } from "./workerClient";
import { PreviewSingleflight } from "./previewSingleflight";

test("one cancelled subscriber does not cancel another preview waiter", async () => {
  const flights = new PreviewSingleflight<string>();
  let calls = 0;
  let release!: (value: string) => void;
  const work = ({ signal }: { signal: AbortSignal }) => {
    calls++;
    return new Promise<string>((resolve, reject) => {
      release = resolve;
      signal.addEventListener("abort", () => reject(new Error("underlying aborted")), { once: true });
    });
  };
  const firstController = new AbortController();
  const deadlineAt = Date.now() + 5_000;
  const first = flights.subscribe("page", work, { signal: firstController.signal, deadlineAt });
  const second = flights.subscribe("page", work, { deadlineAt });
  firstController.abort();
  await assert.rejects(first, PacketWorkerAbortedError);
  assert.equal(calls, 1);
  release("png");
  assert.equal(await second, "png");
});

test("last subscriber cancellation aborts shared preview work", async () => {
  const flights = new PreviewSingleflight<void>();
  const controller = new AbortController();
  let underlyingAborted = false;
  const result = flights.subscribe(
    "page",
    ({ signal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        underlyingAborted = true;
        reject(new Error("cancelled"));
      }, { once: true });
    }),
    { signal: controller.signal, deadlineAt: Date.now() + 5_000 },
  );
  controller.abort();
  await assert.rejects(result, PacketWorkerAbortedError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(underlyingAborted, true);
});