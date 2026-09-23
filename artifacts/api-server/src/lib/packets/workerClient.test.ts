import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  MAX_PACKET_ENGINE_WORKERS,
  PACKET_ENGINE_WORKER_RESOURCE_LIMITS,
  PacketWorkerAbortedError,
  PacketWorkerQueueFullError,
  PacketWorkerTimeoutError,
  PacketWorkerQueueWaitError,
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

test("normal preview queue rejects excess work without affecting high priority work", async () => {
  const queue = createBoundedWorkerQueue(1, 1);
  let release!: () => void;
  const active = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queuedPreview = queue.run(async () => undefined);
  await assert.rejects(queue.run(async () => undefined), PacketWorkerQueueFullError);
  const processing = queue.run(async () => "processing", "high");
  release();
  assert.equal(await processing, "processing");
  await Promise.all([active, queuedPreview]);
});

test("aborting queued work removes it immediately", async () => {
  const queue = createBoundedWorkerQueue(1, 2);
  let release!: () => void;
  const active = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = queue.run(async () => undefined, "normal", { signal: controller.signal });
  assert.equal(queue.pendingCount, 1);
  controller.abort();
  await assert.rejects(queued, PacketWorkerAbortedError);
  assert.equal(queue.pendingCount, 0);
  release();
  await active;
});

test("queue wait deadline expires without starting stale work", async () => {
  const queue = createBoundedWorkerQueue(1, 2);
  let release!: () => void;
  let started = false;
  const active = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    queue.run(async () => { started = true; }, "normal", { deadlineAt: Date.now() + 10 }),
    PacketWorkerQueueWaitError,
  );
  assert.equal(started, false);
  release();
  await active;
});

test("active worker abort waits for termination before queue slot is released", async () => {
  const queue = createBoundedWorkerQueue(1, 1);
  const controller = new AbortController();
  const worker = new Worker("setInterval(() => {}, 1_000)", { eval: true });
  const first = queue.run(
    () => runWorkerWithDeadline(
      worker,
      { operation: "analyze", bytes: new Uint8Array(Buffer.from("%PDF-")) },
      5_000,
      [],
      controller.signal,
    ),
  );
  let secondStarted = false;
  const second = queue.run(async () => { secondStarted = true; });
  controller.abort();
  assert.equal(secondStarted, false);
  await assert.rejects(first, PacketWorkerAbortedError);
  await second;
  assert.equal(secondStarted, true);
});

test("a synchronously throwing job releases its semaphore slot", async () => {
  const queue = createBoundedWorkerQueue(1, 1);
  const failed = queue.run(() => {
    throw new Error("sync failure");
  });
  const next = queue.run(async () => "admitted");
  await assert.rejects(failed, /sync failure/);
  assert.equal(await next, "admitted");
  assert.equal(queue.activeCount, 0);
});

test("an admission deadline removes queued work and frees normal capacity", async () => {
  const queue = createBoundedWorkerQueue(1, 1);
  let release!: () => void;
  const active = queue.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const expired = queue.run(async () => undefined, "normal", { deadlineAt: Date.now() + 10 });
  await assert.rejects(expired, PacketWorkerQueueWaitError);
  assert.equal(queue.pendingCount, 0);
  const replacement = queue.run(async () => "replacement");
  release();
  await active;
  assert.equal(await replacement, "replacement");
});