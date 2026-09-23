import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { admitPageOverlap, LocalCheckpointStage, runPagePipeline, settleUploads } from "./pipeline";

test("pipeline overlaps only next render and commits in order", async () => {
  const events: string[] = [];
  await runPagePipeline({
    start: 0, end: 3, admit: () => true,
    render: async (i) => { events.push(`render${i}`); return i; },
    persist: async (_, i) => {
      events.push(`persist${i}`);
      await new Promise((resolve) => setImmediate(resolve));
      events.push(`commit${i}`);
    },
  });
  assert.ok(events.indexOf("render1") < events.indexOf("commit0"));
  assert.ok(events.indexOf("render2") > events.indexOf("commit0"));
  assert.deepEqual(events.filter((s) => s.startsWith("commit")), ["commit0", "commit1", "commit2"]);
});

test("speculative synchronous render failure still preserves current durable page", async () => {
  const committed: number[] = [];
  await assert.rejects(runPagePipeline({
    start: 0, end: 3, admit: () => true,
    render: (i) => { if (i === 1) throw new Error("render failed"); return Promise.resolve(i); },
    persist: async (_, i) => { await new Promise((resolve) => setImmediate(resolve)); committed.push(i); },
  }), /render failed/);
  assert.deepEqual(committed, [0]);
});

test("persistence failure waits for speculative render settlement", async () => {
  let settled = false;
  await assert.rejects(runPagePipeline({
    start: 0, end: 3, admit: () => true,
    render: async (i) => {
      if (i) { await new Promise((resolve) => setImmediate(resolve)); settled = true; throw new Error("next"); }
      return i;
    },
    persist: () => { throw new Error("persist"); },
  }), /persist/);
  assert.equal(settled, true);
});

test("synchronous upload throw does not bypass sibling settlement", async () => {
  let settled = false;
  await assert.rejects(settleUploads([
    () => { throw new Error("upload"); },
    async () => { await new Promise((resolve) => setImmediate(resolve)); settled = true; },
  ]), /upload/);
  assert.equal(settled, true);
});

test("admission enforces pixel, doubled actual bytes, RSS and serial fallback", async () => {
  const valid = { currentPixels: 2_000_000, nextPixels: 2_000_000, retainedBytes: 1_000_000, rss: 200_000_000 };
  assert.equal(admitPageOverlap(valid), true);
  for (const invalid of [
    { nextPixels: 11_000_000 }, { retainedBytes: 17 * 1024 * 1024 },
    { rss: 700 * 1024 * 1024 }, { rss: NaN }, { retainedBytes: -1 },
  ]) assert.equal(admitPageOverlap({ ...valid, ...invalid }), false);
  const events: string[] = [];
  await runPagePipeline({
    start: 0, end: 2, admit: () => false,
    render: async (i) => { events.push(`render${i}`); return i; },
    persist: async (_, i) => { events.push(`commit${i}`); },
  });
  assert.deepEqual(events, ["render0", "commit0", "render1", "commit1"]);
});

test("local staging verifies bytes, falls back only for absence and cleans up", async () => {
  const bytes = Buffer.from("checkpoint");
  const checkpoint = { pdfPath: "/objects/a", pdfBytes: bytes.length, pdfSha256: createHash("sha256").update(bytes).digest("hex") };
  const stage = new LocalCheckpointStage(100);
  let downloads = 0;
  const download = async () => { downloads++; return bytes; };
  let path = "";
  try {
    await stage.put(checkpoint, bytes);
    path = await stage.resolve(checkpoint, download);
    assert.equal(dirname(path), dirname(await stage.outputPath()));
    assert.equal(downloads, 0);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, Buffer.alloc(bytes.length));
    await assert.rejects(stage.resolve(checkpoint, download), /integrity/);
    assert.equal(downloads, 0);
    await rm(path);
    path = await stage.resolve(checkpoint, download);
    assert.equal(downloads, 1);
    await assert.rejects(stage.put({ ...checkpoint, pdfPath: "bad" }, Buffer.alloc(bytes.length)), /integrity/);
    await assert.rejects(stage.resolve({ ...checkpoint, pdfPath: "remote-bad" }, async () => Buffer.alloc(bytes.length)), /integrity/);
    await assert.rejects(new LocalCheckpointStage(1).put(checkpoint, bytes), /budget/);
  } finally {
    await stage.close();
  }
  await assert.rejects(stat(path), { code: "ENOENT" });
});