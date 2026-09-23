import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { openSanitizationDocumentSession, sanitizePdf, withPacketSanitizationSession } from "./engine";

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([90, 100]);
  const page = pdf.addPage([180, 160]);
  page.setCropBox(10, 20, 120, 130);
  page.setRotation(degrees(90));
  page.drawRectangle({ x: 10, y: 20, width: 100, height: 100, color: rgb(0, 0, 0) });
  return Buffer.from(await pdf.save());
}
const pages = [
  { pageNumber: 1, expectedWidth: 90, expectedHeight: 100, bounds: [] },
  { pageNumber: 2, expectedWidth: 120, expectedHeight: 130, bounds: [{ x: 0, y: 0, width: .5, height: .5 }] },
];

test("persistent document batches match legacy PNG bytes, crop, rotation and arbitrary order", async () => {
  const bytes = await fixture();
  const legacy = await sanitizePdf(bytes, { pages, pageOrder: [2, 1] });
  const session = await openSanitizationDocumentSession(bytes, { pages });
  try {
    for (const [index, page] of [2, 1].entries()) {
      const batch = await session.generateBatch([page]);
      assert.deepEqual(batch.pagePngs[0], legacy.pagePngs[index]);
      assert.equal(batch.pages[0]!.width, legacy.pages[index]!.width);
      assert.equal(batch.pages[0]!.height, legacy.pages[index]!.height);
      assert.equal(batch.pages[0]!.pageNumber, 1);
      assert.equal((await PDFDocument.load(batch.pdf)).getPageCount(), 1);
    }
    await assert.rejects(session.generateBatch([2]), /already consumed/);
  } finally { await session.close(); }
  await assert.rejects(session.generateBatch([1]), /closed/);
});

test("session preflights every requested geometry and rejects invalid orders", async () => {
  const bytes = await fixture();
  await assert.rejects(openSanitizationDocumentSession(bytes, { pages: [
    pages[0]!, { ...pages[1]!, expectedWidth: 180 },
  ] }), /different source page dimensions/);
  const session = await openSanitizationDocumentSession(bytes, { pages });
  try {
    await assert.rejects(session.generateBatch([1, 1]), /unique source/);
    await assert.rejects(session.generateBatch([3]), /invalid source/);
    assert.equal((await session.generateBatch([2, 1])).pageCount, 2);
  } finally { await session.close(); }
});

test("worker callback rejection and failed open release session capacity", async () => {
  const bytes = await fixture();
  const input = {
    bytes, redactionsByPage: {},
    pageDimensions: pages.map((p) => ({ pageNumber: p.pageNumber, width: p.expectedWidth, height: p.expectedHeight })),
  };
  await assert.rejects(withPacketSanitizationSession(input, async () => { throw new Error("checkpoint failed"); }), /checkpoint failed/);
  await assert.rejects(withPacketSanitizationSession({ ...input, bytes: Buffer.from("invalid") }, async () => {}), /PDF/);
  const phases: string[] = [];
  await withPacketSanitizationSession(input, async (session) => {
    assert.equal((await session.generateBatch([2])).pages.length, 1);
  }, { onProgress: (progress) => phases.push(progress.phase) });
  assert.equal(phases.filter((phase) => phase === "startup").length, 1);
  assert.ok(phases.includes("png"));
});

test("abort waits for outstanding checkpoint callback before releasing capacity", async () => {
  const controller = new AbortController();
  let settled = false;
  let checkpointDone = false;
  const work = withPacketSanitizationSession({
    bytes: await fixture(), redactionsByPage: {},
    pageDimensions: [{ pageNumber: 1, width: 90, height: 100 }],
  }, async (session) => {
    await session.generateBatch([1]);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
    checkpointDone = true;
  }, { signal: controller.signal });
  void work.then(() => { settled = true; }, () => { settled = true; });
  await assert.rejects(work, /cancelled/);
  assert.equal(checkpointDone, true);
});

test("absolute session deadline reports phase immediately but waits for checkpoint settlement", async () => {
  let failed = false;
  let checkpointDone = false;
  const input = {
    bytes: await fixture(), redactionsByPage: {},
    pageDimensions: [{ pageNumber: 1, width: 90, height: 100 }],
  };
  await assert.rejects(withPacketSanitizationSession(input, async (session) => {
    await session.generateBatch([1]);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.equal(failed, true);
    checkpointDone = true;
  }, {
    deadlineAt: Date.now() + 2500,
    onFailure(error, progress) {
      assert.match(error.message, /wall-clock/);
      assert.equal(progress?.phase, "idle");
      failed = true;
    },
  }), /wall-clock/);
  assert.equal(checkpointDone, true);
  await withPacketSanitizationSession(input, async (session) => {
    assert.equal((await session.generateBatch([1])).pages.length, 1);
  });
});