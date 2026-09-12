import assert from "node:assert/strict";
import test from "node:test";

import {
  isAbandonedProcessingJob,
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