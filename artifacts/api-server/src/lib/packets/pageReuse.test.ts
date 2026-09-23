import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  assertCompleteCheckpoints, boundedReusablePages, checkpointObjectPaths,
  commitCheckpointBatch, completedCheckpointPages, loadReusablePage, MAX_CHECKPOINT_BYTES,
  pageFingerprint, resetRenderCheckpoints, reusablePageValid, selectReusablePages,
  type PacketProcessingState, type ReusablePage,
} from "./checkpoints";
import { runPagePipeline } from "./pipeline";
import type { PacketPageAnalysis, RedactionRect } from "./types";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pdf = Buffer.from("%PDF-page");
const png = Buffer.from("PNG-page");
const pages: PacketPageAnalysis[] = [1, 2, 3].map((pageNumber) => ({
  pageNumber, width: 612, height: 792, pageType: "other", suggestedRects: [],
}));
const box = { x: 1, y: 2, width: 3, height: 4 };
const keys = (rects: Record<number, RedactionRect[]> = {}) =>
  pages.map((page) => pageFingerprint("source-digest", page, rects[page.pageNumber] ?? []));
function cached(index: number, key = keys()[index]!): ReusablePage {
  return {
    reuseVersion: 1, pageKey: key, pageNumbers: [index + 1],
    pdfPath: `/objects/manufacturer-packets/7/8/renders/unique-${index}.pdf`,
    pagePaths: [`/objects/manufacturer-packets/7/8/renders/unique-page-${index + 1}.png`],
    pdfBytes: pdf.length, pngBytes: png.length, pdfSha256: digest(pdf), pngSha256: digest(png),
  };
}
function state(): PacketProcessingState {
  return { version: 1, analysisKey: "analysis", analysis: { pages, profile: "unknown" },
    renderKey: "render", batches: [], reusablePages: pages.map((_, index) => cached(index)),
    progress: { stage: "rendering", completedPages: 0, totalPages: 3 } };
}

test("first/middle/last/multi-page edits and no-op select exactly unchanged pages", () => {
  for (const changed of [[], [1], [2], [3], [1, 3], [1, 2, 3]]) {
    const rects = Object.fromEntries(changed.map((page) => [page, [box]]));
    assert.deepEqual(selectReusablePages(state(), 7, 8, keys(rects)).map((p) => p.pageNumbers[0]),
      [1, 2, 3].filter((page) => !changed.includes(page)));
  }
  const withBox = state();
  withBox.reusablePages![1] = cached(1, keys({ 2: [box] })[1]);
  assert.deepEqual(selectReusablePages(withBox, 7, 8, keys()).map((p) => p.pageNumbers[0]), [1, 3]);
});

test("fingerprints bind source, page identity, geometry, rectangles but not UI reason/order", () => {
  const page = pages[0]!;
  const original = pageFingerprint("source", page, [box, { ...box, x: 7 }]);
  assert.equal(original, pageFingerprint("source", page, [{ ...box, x: 7 }, { ...box, reason: "manual" }]));
  for (const changed of [
    pageFingerprint("other-source", page, [box, { ...box, x: 7 }]),
    pageFingerprint("source", { ...page, width: 600 }, [box, { ...box, x: 7 }]),
    pageFingerprint("source", { ...page, pageNumber: 2 }, [box, { ...box, x: 7 }]),
    pageFingerprint("source", page, [box, { ...box, width: 7 }]),
  ]) assert.notEqual(original, changed);
  const incompatible = state();
  incompatible.reusablePages![0]!.pageKey = "0".repeat(64); // incompatible policy fingerprint
  assert.deepEqual(selectReusablePages(incompatible, 7, 8, keys()).map((p) => p.pageNumbers[0]), [2, 3]);
});

test("legacy, malformed, cross-packet, cross-quote and wrong-page paths cannot be reused", () => {
  const valid = cached(0);
  assert.equal(reusablePageValid(valid, 7, 8), true);
  assert.equal(reusablePageValid(valid, 7, 9), false);
  assert.equal(reusablePageValid(valid, 6, 8), false);
  for (const patch of [
    { reuseVersion: undefined }, { pngSha256: undefined }, { pageKey: "legacy" },
    { pageNumbers: [1, 2] }, { pagePaths: [valid.pagePaths[0]!.replace("page-1", "page-2")] },
    { pdfPath: valid.pdfPath.replace("/renders/", "/source/") }, { pngBytes: -1 },
  ]) assert.equal(reusablePageValid({ ...valid, ...patch } as ReusablePage, 7, 8), false);
});

test("both PDF and PNG missing/corrupt/truncated reject with bounded downloads and no retry", async () => {
  const page = cached(0);
  let calls = 0;
  assert.deepEqual(await loadReusablePage(page, async (path, limit) => {
    const bytes = path.endsWith(".pdf") ? pdf : png;
    assert.equal(limit, bytes.length);
    calls++;
    return bytes;
  }), pdf);
  assert.equal(calls, 2);
  for (const extension of [".pdf", ".png"]) {
    for (const mode of ["missing", "corrupt", "truncated"]) {
      calls = 0;
      await assert.rejects(loadReusablePage(page, async (path) => {
        calls++;
        const bytes = path.endsWith(".pdf") ? pdf : png;
        if (!path.endsWith(extension)) return bytes;
        if (mode === "missing") throw new Error("not found");
        return mode === "corrupt" ? Buffer.alloc(bytes.length) : bytes.subarray(1);
      }), /not found|integrity/);
      assert.ok(calls <= 2);
    }
  }
});

test("only explicit redaction resets preserve cache references independently of prefix", () => {
  const before = state();
  const review = resetRenderCheckpoints(before, true)!;
  assert.equal(review.batches.length, 0);
  assert.equal(review.reusablePages!.length, 3);
  assert.equal(checkpointObjectPaths(review).length, 6);
  assert.equal(resetRenderCheckpoints(before)!.reusablePages!.length, 0);
  assert.throws(() => assertCompleteCheckpoints(review), /incomplete/);
});

test("bounded union deduplicates prefix/cache bytes; distinct objects exceed the limit", () => {
  const large = { ...cached(0), pdfBytes: MAX_CHECKPOINT_BYTES / 2, pngBytes: 1 };
  const value = { ...state(), batches: [large], reusablePages: [large] };
  assert.equal(completedCheckpointPages(value), 1);
  assert.throws(() => completedCheckpointPages({
    ...value, reusablePages: [large, { ...cached(1), pdfBytes: MAX_CHECKPOINT_BYTES / 2 }],
  }), /limit/);
  assert.equal(boundedReusablePages([large, { ...large, pageKey: "b".repeat(64) }]).length, 1);
  assert.equal(boundedReusablePages([large, { ...cached(1), pdfBytes: MAX_CHECKPOINT_BYTES / 2 }]).length, 1);
});

test("mixed reused/new pages commit only in order and resume after interrupted publication", async () => {
  let durable = state();
  const available = selectReusablePages(durable, 7, 8, keys({ 2: [box] }));
  let renderCalls = 0;
  const attempt = async (failPage?: number) => runPagePipeline({
    start: durable.batches.length, end: 3, admit: () => true,
    render: async (index) => {
      const reused = available.find((page) => page.pageNumbers[0] === index + 1);
      if (reused) return reused;
      renderCalls++;
      return cached(index, keys({ 2: [box] })[index]);
    },
    persist: async (page) => {
      const next = { ...durable, batches: [...durable.batches, page],
        reusablePages: boundedReusablePages([...durable.reusablePages!, page]) };
      await commitCheckpointBatch(next, async () => {}, async (value) => {
        if (page.pageNumbers[0] === failPage) return false;
        durable = value;
        return true;
      });
    },
  });
  await assert.rejects(attempt(3), /superseded/);
  assert.equal(completedCheckpointPages(durable), 2);
  assert.throws(() => assertCompleteCheckpoints(durable), /incomplete/);
  await attempt();
  assertCompleteCheckpoints(durable);
  assert.equal(renderCalls, 1);
  assert.deepEqual(durable.batches.map((page) => page.pageNumbers[0]), [1, 2, 3]);
  assert.equal(durable.batches[0]!.pdfPath, cached(0).pdfPath);
  assert.equal(durable.batches[2]!.pdfSha256, cached(2).pdfSha256);
});