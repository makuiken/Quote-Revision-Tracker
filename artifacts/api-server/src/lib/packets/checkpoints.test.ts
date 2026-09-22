import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisFingerprint, assertCompleteCheckpoints, assertDocumentBudget,
  checkpointObjectPaths, commitCheckpointBatch, completedCheckpointPages,
  renderFingerprint, resetRenderCheckpoints, resumeRender,
  type PacketProcessingState, type RenderCheckpoint,
} from "./checkpoints";

function state(): PacketProcessingState {
  return {
    version: 1, analysisKey: "source-analysis", renderKey: "review-v1",
    analysis: { profile: "unknown", pages: [1, 2, 3].map((pageNumber) => ({
      pageNumber, width: 612, height: 792, pageType: "other", suggestedRects: [],
    })) },
    batches: [], progress: { stage: "rendering", completedPages: 0, totalPages: 3 },
  };
}
function batch(pages: number[]): RenderCheckpoint {
  return { pageNumbers: pages, pdfPath: `/batch-${pages[0]}.pdf`,
    pagePaths: pages.map((page) => `/page-${page}.png`), pdfSha256: "a".repeat(64),
    pdfBytes: 20, pngBytes: 40 };
}
test("analysis cache binds source bytes, analyzer version and manufacturer", () => {
  const source = Buffer.from("%PDF-one");
  const first = analysisFingerprint(source, "Acme");
  assert.equal(first, analysisFingerprint(source, "Acme"));
  assert.notEqual(first, analysisFingerprint(Buffer.from("%PDF-two"), "Acme"));
  assert.notEqual(first, analysisFingerprint(source, "Other"));
});
test("changed redactions or source invalidate rendered checkpoints but retain analysis", () => {
  const original = state();
  const reviewed = { "1": [{ x: 1, y: 2, width: 3, height: 4 }] };
  original.renderKey = renderFingerprint(original.analysisKey, reviewed);
  original.batches = [batch([1, 2])];
  assert.equal(resumeRender(original, original.renderKey), original);
  const changed = renderFingerprint(original.analysisKey, { "1": [{ x: 9, y: 2, width: 3, height: 4 }] });
  const resumed = resumeRender(original, changed);
  assert.equal(resumed.batches.length, 0);
  assert.equal(resumed.analysis, original.analysis);
  assert.notEqual(renderFingerprint("other-source", reviewed), original.renderKey);
  assert.equal(resetRenderCheckpoints(original)?.renderKey, null);
});
test("retry after object failure preserves prior batch and never commits partial output", async () => {
  const prior = state();
  prior.batches = [batch([1, 2])];
  let durable = prior;
  let commits = 0;
  const next = { ...prior, batches: [...prior.batches, batch([3])] };
  await assert.rejects(commitCheckpointBatch(next, async () => {
    throw new Error("PNG upload interrupted");
  }, async (value) => { commits++; durable = value; return true; }), /interrupted/);
  assert.equal(commits, 0);
  assert.equal(completedCheckpointPages(durable), 2);
  assert.throws(() => assertCompleteCheckpoints(durable), /incomplete/);
  await commitCheckpointBatch(next, async () => {}, async (value) => { durable = value; return true; });
  assert.doesNotThrow(() => assertCompleteCheckpoints(durable));
  assert.deepEqual(checkpointObjectPaths(durable), [
    "/batch-1.pdf", "/page-1.png", "/page-2.png", "/batch-3.pdf", "/page-3.png",
  ]);
});
test("superseded attempt cannot publish a batch or become approval-ready", async () => {
  const prior = state();
  const next = { ...prior, batches: [batch([1, 2])] };
  await assert.rejects(commitCheckpointBatch(next, async () => {}, async () => false), /superseded/);
  assert.equal(prior.batches.length, 0);
  assert.throws(() => assertCompleteCheckpoints(prior), /incomplete/);
});
test("lost commit acknowledgement is resumable from the durable row", async () => {
  const prior = state();
  let durable = prior;
  const next = { ...prior, batches: [batch([1, 2])] };
  await assert.rejects(commitCheckpointBatch(next, async () => {}, async (value) => {
    durable = structuredClone(value);
    throw new Error("connection lost after commit");
  }), /connection lost/);
  const retry = resumeRender(durable, "review-v1");
  assert.equal(completedCheckpointPages(retry), 2);
  assert.equal(checkpointObjectPaths(retry).length, 3);
});
test("gaps, duplicates and cumulative output/pixel overages fail closed", () => {
  for (const pages of [[2, 3], [1, 1]]) {
    assert.throws(() => completedCheckpointPages({ ...state(), batches: [batch(pages)] }), /order/);
  }
  const oversized = batch([1, 2]);
  oversized.pngBytes = 120 * 1024 * 1024;
  assert.throws(() => completedCheckpointPages({ ...state(), batches: [oversized] }), /limit/);
  assert.doesNotThrow(() => assertDocumentBudget(state().analysis.pages));
  assert.throws(() => assertDocumentBudget(Array.from({ length: 60 }, (_, index) => ({
    ...state().analysis.pages[0]!, pageNumber: index + 1,
  }))), /pixels/);
});