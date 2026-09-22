import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { and, eq } from "drizzle-orm";
import { db, pool, quotesTable, manufacturerPacketsTable as packets } from "@workspace/db";
import { processPacket, packetSourcePath } from "../src/lib/packets/service";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { packetEngine, renderPdfPreviewInWorker } from "../src/lib/packets/engine";
import { readProcessingState } from "../src/lib/packets/checkpoints";

if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1") {
  throw new Error("This integration harness is development-only.");
}
const tag = `TASK81-INTEGRATION-${randomUUID()}`;
const storage = new ObjectStorageService();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const started = Date.now();
const evidence = (stage: string, details: object = {}) =>
  console.log(JSON.stringify({ task: 81, stage, elapsedMs: Date.now() - started, ...details }));
let quoteId: number | undefined;
let packetId: number | undefined;
let running: Promise<unknown> | undefined;
let analyses = 0;
const originalAnalyze = packetEngine.analyzePdf;
packetEngine.analyzePdf = async (...args) => {
  analyses++;
  return originalAnalyze.apply(packetEngine, args);
};
async function row() {
  const [r] = await db.select().from(packets).where(and(eq(packets.id, packetId!), eq(packets.quoteId, quoteId!)));
  assert.ok(r);
  return r;
}
async function update(values: Partial<typeof packets.$inferInsert>) {
  await db.update(packets).set(values).where(and(eq(packets.id, packetId!), eq(packets.quoteId, quoteId!)));
}
function state(r: Awaited<ReturnType<typeof row>>) {
  const s = readProcessingState(r.processingState);
  assert.ok(s);
  return s;
}
async function runToReady() {
  let done = false;
  running = processPacket(packetId!, false).finally(() => { done = true; });
  while (!done) {
    const r = await row();
    if (r.status === "ready_for_approval") {
      assert.equal(state(r).progress.completedPages, 40);
      assert.equal(state(r).batches.flatMap(b => b.pageNumbers).length, 40);
    }
    await sleep(100);
  }
  assert.equal(await running, "processed");
  const r = await row();
  assert.equal(r.status, "ready_for_approval", r.failureMessage ?? "not ready");
  assert.equal(r.pageCount, 40);
  assert.equal(r.sanitizedPageObjectPaths?.length, 40);
  assert.equal(state(r).progress.stage, "complete");
  return r;
}
async function pixels(bytes: Buffer, point: [number, number]) {
  const png = await renderPdfPreviewInWorker(bytes, 1, { dpi: 72 });
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return [...ctx.getImageData(...point, 1, 1).data];
}
try {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 40; i++) {
    const page = pdf.addPage([240, 300]);
    page.drawRectangle({ x: 20, y: 240, width: 180, height: 40, color: rgb(0, 0, 0) });
    page.drawText(`SYNTHETIC SECRET ${i}`, { x: 25, y: 252, size: 10, font, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 20, y: 160, width: 180, height: 40, color: rgb(0, 0, 0) });
    page.drawText(`Public test page ${i}`, { x: 20, y: 100, size: 12, font });
  }
  const source = Buffer.from(await pdf.save());
  const [quote] = await db.insert(quotesTable).values({
    quoteNumber: tag, customerName: "Synthetic integration fixture",
    categories: [], createdById: tag, createdByName: "Task81 development harness",
    notes: "Own synthetic fixture only. Retained and archived as checkpoint evidence.",
  }).returning();
  quoteId = quote.id;
  const manual = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [
    String(i + 1), [{ x: 18, y: 18, width: 184, height: 44 }],
  ]));
  const [packet] = await db.insert(packets).values({
    quoteId, originalName: "task81-synthetic-40-pages.pdf", declaredSize: source.length,
    uploadObjectPath: `/objects/task81-development/${tag}/unused-upload`,
    status: "awaiting_upload", manualRedactions: manual,
  }).returning();
  packetId = packet.id;
  const sourcePath = packetSourcePath(quoteId, packetId);
  await storage.saveObjectEntityImmutable(sourcePath, source, "application/pdf");
  await update({ sourceObjectPath: sourcePath, status: "queued" });
  evidence("fixture", { quoteId, packetId, sourceBytes: source.length, pages: 40 });
  let done = false;
  running = processPacket(packetId, false).finally(() => { done = true; });
  const deadline = Date.now() + 180_000;
  let interrupted: Awaited<ReturnType<typeof row>> | undefined;
  while (!done && Date.now() < deadline) {
    const r = await row();
    const s = readProcessingState(r.processingState);
    if (r.status === "processing" && s && s.batches.length >= 2) {
      // Lock the own row so the prefix snapshot and supersession are atomic.
      interrupted = await db.transaction(async tx => {
        const [locked] = await tx.select().from(packets).where(eq(packets.id, packetId!)).for("update");
        assert.equal(locked.status, "processing");
        await tx.update(packets).set({
          processingAttemptToken: randomUUID(), processingStartedAt: new Date(),
        }).where(eq(packets.id, packetId!));
        return locked;
      });
      break;
    }
    await sleep(30);
  }
  await running;
  assert.ok(interrupted, "Did not interrupt a durable prefix within deadline");
  const prefix = state(interrupted).batches;
  const stopped = await row();
  assert.equal(stopped.status, "processing");
  assert.deepEqual(state(stopped).batches, prefix, "Old worker committed after losing token");
  assert.ok(prefix.length >= 2 && prefix.length < 20);
  const prefixHashes = await Promise.all(prefix.map(async b => {
    const bytes = await storage.downloadObjectBytesBounded(b.pdfPath, b.pdfBytes);
    assert.equal(hash(bytes), b.pdfSha256);
    return { pdf: hash(bytes), pngs: await Promise.all(b.pagePaths.map(async p =>
      hash(await storage.downloadObjectBytesBounded(p, 10 * 1024 * 1024)))) };
  }));
  evidence("interrupted", { batches: prefix.length, completedPages: state(stopped).progress.completedPages, analyses });
  await update({ status: "queued", processingStartedAt: null });
  const ready = await runToReady();
  assert.deepEqual(state(ready).batches.slice(0, prefix.length), prefix);
  for (const [i, b] of prefix.entries()) {
    assert.equal(hash(await storage.downloadObjectBytesBounded(b.pdfPath, b.pdfBytes)), prefixHashes[i].pdf);
    assert.deepEqual(await Promise.all(b.pagePaths.map(async p =>
      hash(await storage.downloadObjectBytesBounded(p, 10 * 1024 * 1024)))), prefixHashes[i].pngs);
  }
  assert.equal(analyses, 1, "Source analysis was rerun on resume");
  const finalBytes = await storage.downloadObjectBytesBounded(ready.sanitizedPdfObjectPath!, 100 * 1024 * 1024);
  assert.equal((await PDFDocument.load(finalBytes)).getPageCount(), 40);
  assert.equal(hash(finalBytes), ready.sanitizedPdfSha256);
  assert.deepEqual(await pixels(finalBytes, [30, 30]), [255, 255, 255, 255]);
  assert.deepEqual(await pixels(finalBytes, [30, 110]), [0, 0, 0, 255]);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(finalBytes) }).promise;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      assert.equal((await (await doc.getPage(n)).getTextContent()).items.length, 0);
    }
  } finally { await doc.cleanup(); await doc.loadingTask.destroy(); }
  evidence("resumed", { pages: 40, analyses, prefixPathsAndHashesUnchanged: true, pdfSha256: hash(finalBytes), textItems: 0 });
  const changed = Object.fromEntries(Object.entries(manual).map(([n, boxes]) =>
    [n, [...boxes, { x: 18, y: 98, width: 184, height: 44 }]]));
  // Deliberately preserve the old state to exercise renderFingerprint invalidation,
  // rather than hiding errors behind the HTTP route's eager checkpoint reset.
  await update({
    manualRedactions: changed, status: "queued", attemptCount: 0,
    sanitizedPdfObjectPath: null, sanitizedPdfSha256: null, sanitizedPageObjectPaths: null,
  });
  const regenerated = await runToReady();
  assert.equal(analyses, 1);
  assert.equal(state(regenerated).analysisKey, state(ready).analysisKey);
  assert.notEqual(state(regenerated).renderKey, state(ready).renderKey);
  const oldPaths = new Set(state(ready).batches.flatMap(b => [b.pdfPath, ...b.pagePaths]));
  assert.ok(state(regenerated).batches.every(b => [b.pdfPath, ...b.pagePaths].every(p => !oldPaths.has(p))));
  const changedBytes = await storage.downloadObjectBytesBounded(regenerated.sanitizedPdfObjectPath!, 100 * 1024 * 1024);
  assert.equal((await PDFDocument.load(changedBytes)).getPageCount(), 40);
  assert.notEqual(hash(changedBytes), hash(finalBytes));
  assert.deepEqual(await pixels(changedBytes, [30, 110]), [255, 255, 255, 255]);
  evidence("regenerated", { pages: 40, analyses, oldRenderPathsNotReused: true, changedRegionWhite: true, pdfSha256: hash(changedBytes) });
} finally {
  await running?.catch(() => {});
  // Retain immutable artifacts, including superseded checkpoint objects. Never
  // attempt broad object listing/deletion in this evidence harness.
  if (quoteId !== undefined) {
    await db.update(quotesTable).set({
      archivedAt: new Date(), archiveReason: "Task81 synthetic development evidence; retained immutable checkpoint objects",
      archivedById: tag, archivedByName: "Task81 development harness",
    }).where(and(eq(quotesTable.id, quoteId), eq(quotesTable.createdById, tag)));
    evidence("retained_archived_fixture", { quoteId, packetId });
  }
  packetEngine.analyzePdf = originalAnalyze;
  await pool.end();
}