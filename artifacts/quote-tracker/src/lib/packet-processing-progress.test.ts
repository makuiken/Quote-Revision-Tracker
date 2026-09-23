import assert from "node:assert/strict";
import test from "node:test";
import {
  packetProcessingProgressText,
  packetRenderBreakdown,
} from "./packet-processing-progress";

test("legacy packet progress remains readable when render counts are absent", () => {
  assert.equal(
    packetProcessingProgressText({
      stage: "rendering",
      completedPages: 2,
      totalPages: 8,
    }),
    "rendering — 2 of 8 pages completed",
  );
  assert.equal(packetRenderBreakdown(undefined), null);
});

test("packet progress reports actual rendered and reused counts", () => {
  const progress = {
    stage: "rendering",
    completedPages: 6,
    totalPages: 8,
    renderedPages: 2,
    reusedPages: 4,
  };

  assert.equal(
    packetProcessingProgressText(progress),
    "rendering — 6 of 8 pages completed (2 pages rendered, 4 pages reused)",
  );
  assert.equal(
    packetRenderBreakdown(progress),
    "2 pages rendered, 4 pages reused",
  );
});

test("packet progress does not infer a missing count from the planned total", () => {
  assert.equal(
    packetRenderBreakdown({
      stage: "complete",
      completedPages: 5,
      totalPages: 12,
      renderedPages: 1,
    }),
    "1 page rendered",
  );
  assert.equal(
    packetRenderBreakdown({
      stage: "complete",
      completedPages: 5,
      totalPages: 12,
      reusedPages: 0,
    }),
    "0 pages reused",
  );
});