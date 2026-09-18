import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  MAX_PACKET_ENGINE_WORKERS,
  PACKET_ENGINE_WORKER_RESOURCE_LIMITS,
  PacketWorkerTimeoutError,
  createBoundedWorkerQueue,
  runWorkerWithDeadline,
} from "./workerClient";

test("packet worker queue caps concurrent work at configured capacity", async () => {
  const queue = createBoundedWorkerQueue(MAX_PACKET_ENGINE_WORKERS);
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 5 }, () =>
    queue.run(
      () =>
        new Promise<void>((resolve) => {
          active++;
          peak = Math.max(peak, active);
          setTimeout(() => {
            active--;
            resolve();
          }, 5);
        }),
    ),
  );
  await Promise.all(jobs);
  assert.equal(peak, MAX_PACKET_ENGINE_WORKERS);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pendingCount, 0);
  assert.ok(PACKET_ENGINE_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb <= 384);
});

test("packet processing jumps ahead of queued optional previews", async () => {
  const queue = createBoundedWorkerQueue(1);
  const order: string[] = [];
  let releaseActive!: () => void;
  const active = queue.run(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const preview = queue.run(async () => {
    order.push("preview");
  });
  const processing = queue.run(async () => {
    order.push("processing");
  }, "high");
  releaseActive();
  await Promise.all([active, preview, processing]);
  assert.deepEqual(order, ["processing", "preview"]);
});

test("hard deadline terminates an unresponsive packet worker", async () => {
  const worker = new Worker("setInterval(() => {}, 1_000)", { eval: true });
  await assert.rejects(
    runWorkerWithDeadline(
      worker,
      { operation: "analyze", bytes: new Uint8Array(Buffer.from("%PDF-")) },
      10,
    ),
    PacketWorkerTimeoutError,
  );
});