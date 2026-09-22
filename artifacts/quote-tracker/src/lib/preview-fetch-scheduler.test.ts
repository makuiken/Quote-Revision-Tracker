import assert from "node:assert/strict";
import test from "node:test";
import {
  PreviewFetchScheduler,
  redactionFromDrag,
} from "./preview-fetch-scheduler";

test("preview scheduler admits at most two and advances after a cache-hit release", () => {
  const scheduler = new PreviewFetchScheduler(2);
  const granted: number[] = [];
  const releases = [1, 2, 3].map((id) =>
    scheduler.schedule(() => granted.push(id)),
  );

  assert.deepEqual(granted, [1, 2]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.queuedCount, 1);

  // A cache hit has no in-flight transition, but it still must surrender the
  // admission slot or visible requests behind it will deadlock.
  releases[0]();
  assert.deepEqual(granted, [1, 2, 3]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.queuedCount, 0);

  releases[0]();
  assert.equal(scheduler.activeCount, 2, "release is idempotent");
  releases[1]();
  releases[2]();
  assert.equal(scheduler.activeCount, 0);
});

test("cancelled queued preview is never admitted", () => {
  const scheduler = new PreviewFetchScheduler(1);
  const granted: number[] = [];
  const releaseFirst = scheduler.schedule(() => granted.push(1));
  const cancelSecond = scheduler.schedule(() => granted.push(2));
  scheduler.schedule(() => granted.push(3));

  cancelSecond();
  releaseFirst();
  assert.deepEqual(granted, [1, 3]);
});

test("redaction geometry uses pointer-up coordinates and page bounds", () => {
  assert.deepEqual(
    redactionFromDrag(
      { x: 20, y: 30 },
      { x: 80, y: 95 },
      { width: 100, height: 100 },
    ),
    {
      x: 20,
      y: 30,
      width: 60,
      height: 65,
      reason: "Manual Redaction",
    },
  );

  assert.deepEqual(
    redactionFromDrag(
      { x: 90, y: 90 },
      { x: -20, y: -30 },
      { width: 100, height: 100 },
    ),
    {
      x: 0,
      y: 0,
      width: 90,
      height: 90,
      reason: "Manual Redaction",
    },
  );
  assert.equal(
    redactionFromDrag(
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { width: 100, height: 100 },
    ),
    null,
  );
  assert.ok(
    redactionFromDrag(
      { x: 10, y: 10 },
      { x: 14, y: 14 },
      { width: 100, height: 100 },
      3,
    ),
    "a small but intentional scaled-screen drag is accepted",
  );
});