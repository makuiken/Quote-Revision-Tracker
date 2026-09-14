import assert from "node:assert/strict";
import test from "node:test";

import {
  isAbandonedProcessingJob,
  nextRecoveryScanCursor,
  PROCESSING_ABANDONED_AFTER_MS,
  recoveryAction,
} from "./recovery";

test("recovery predicate only claims stale processing work", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(
    isAbandonedProcessingJob(
      { status: "processing", processingStartedAt: new Date(now - PROCESSING_ABANDONED_AFTER_MS - 1) },
      now,
    ),
    true,
  );
  assert.equal(
    isAbandonedProcessingJob(
      { status: "processing", processingStartedAt: new Date(now - PROCESSING_ABANDONED_AFTER_MS) },
      now,
    ),
    false,
  );
  assert.equal(
    isAbandonedProcessingJob({ status: "queued", processingStartedAt: null }, now),
    false,
  );
});

test("recovery claim policy respects archive and terminal attempt cap", () => {
  const now = Date.UTC(2026, 0, 1);
  const stale = {
    status: "processing",
    processingStartedAt: new Date(now - PROCESSING_ABANDONED_AFTER_MS - 1),
    attemptCount: 2,
  };
  assert.equal(recoveryAction(stale, false, 3, now), "queue");
  assert.equal(recoveryAction(stale, false, 2, now), "fail");
  assert.equal(recoveryAction(stale, true, 3, now), "skip");
});

test("queued work stays recoverable after a worker-slot miss", () => {
  const now = Date.UTC(2026, 0, 1);
  // Slot pressure never changes the durable row to processing. A later
  // bounded recovery scan must therefore select the queued row normally.
  assert.equal(
    recoveryAction(
      { status: "queued", processingStartedAt: null, attemptCount: 0 },
      false,
      3,
      now,
    ),
    "queue",
  );
  assert.equal(
    recoveryAction(
      { status: "queued", processingStartedAt: null, attemptCount: 3 },
      false,
      3,
      now,
    ),
    "fail",
  );
});

test("a non-stale processing row is never claimed twice by recovery", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(
    recoveryAction(
      {
        status: "processing",
        processingStartedAt: new Date(now - PROCESSING_ABANDONED_AFTER_MS),
        attemptCount: 1,
      },
      false,
      3,
      now,
    ),
    "skip",
  );
});

test("bounded recovery scans advance past a full page before wrapping", () => {
  assert.equal(nextRecoveryScanCursor(200, 50, 50), 200);
  assert.equal(nextRecoveryScanCursor(237, 37, 50), 0);
});