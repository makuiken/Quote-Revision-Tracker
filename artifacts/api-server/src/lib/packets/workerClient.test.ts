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

test("packet worker queue caps concurrent work at two", async () => {
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
  assert.equal(peak, 2);
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pendingCount, 0);
  assert.ok(PACKET_ENGINE_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb <= 384);
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