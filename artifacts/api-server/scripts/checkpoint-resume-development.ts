import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { and, eq } from "drizzle-orm";
import { db, pool, quotesTable, manufacturerPacketsTable as packets, packetCheckpointObjectsTable as checkpointObjects } from "@workspace/db";
import { processPacket, packetSourcePath } from "../src/lib/packets/service";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { packetEngine, renderPdfPreviewInWorker } from "../src/lib/packets/engine";
import { readProcessingState } from "../src/lib/packets/checkpoints";
import type { RedactionRect } from "../src/lib/packets/types";

if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1") {
  throw new Error("This integration harness is development-only.");
}
const tag = `TASK86-INTEGRATION-${randomUUID()}`;
const storage = new ObjectStorageService();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const started = Date.now();
const evidence = (stage: string, details: object = {}) =>
  console.log(JSON.stringify({ task: 86, stage, elapsedMs: Date.now() - started, ...details }));
let quoteId: number | undefined;
let packetId: number | undefined;
let running: Promise<unknown> | undefined;
let analyses = 0;
const createdObjectPaths = new Set<string>();
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
function observe(r: Awaited<ReturnType<typeof row>>) {
  const s = readProcessingState(r.processingState);
  if (!s) return;
  const rasterPages = s.batches.flatMap((batch) => {
    assert.equal(batch.pageNumbers.length, 1, "Every durable checkpoint must contain one page");
    assert.equal(batch.pagePaths.length, 1, "Every durable checkpoint must contain one raster");
    createdObjectPaths.add(batch.pdfPath);
    batch.pagePaths.forEach((path) => createdObjectPaths.add(path));
    return batch.pageNumbers;
  }).length;
  if (s.progress.stage !== "complete") {
    assert.equal(s.progress.completedPages, rasterPages,
      "Progress must count only durably committed page rasters");
  }
  if (r.status === "ready_for_approval") {
    assert.equal(s.progress.stage, "complete", "Approval became available before rendering completed");
    assert.equal(s.progress.completedPages, s.analysis.pages.length,
      "Complete progress did not count every raster page");
    assert.equal(r.sanitizedPageObjectPaths?.length, s.analysis.pages.length,
      "Approval became available without every page raster");
  }
}
async function runToReady(expectedPages: number, options: {
  expectedPrefix?: ReturnType<typeof state>["batches"];
  forbiddenPaths?: Set<string>;
} = {}) {
  let done = false;
  let sawExpectedPrefix = options.expectedPrefix === undefined;
  running = processPacket(packetId!, false).finally(() => { done = true; });
  while (!done) {
    const r = await row();
    observe(r);
    const current = readProcessingState(r.processingState);
    if (current?.batches.length) {
      if (options.expectedPrefix &&
          current.batches.length >= options.expectedPrefix.length &&
          JSON.stringify(current.batches.slice(0, options.expectedPrefix.length)) ===
            JSON.stringify(options.expectedPrefix)) {
        sawExpectedPrefix = true;
      }
      if (options.forbiddenPaths) {
        assert.ok(current.batches.every((batch) =>
          [batch.pdfPath, ...batch.pagePaths].every((path) => !options.forbiddenPaths!.has(path))),
        "Changed redactions reused an invalidated checkpoint path");
      }
    }
    await sleep(20);
  }
  assert.equal(await running, "processed");
  const r = await row();
  observe(r);
  assert.equal(r.status, "ready_for_approval", r.failureMessage ?? "not ready");
  assert.equal(r.pageCount, expectedPages);
  assert.equal(r.sanitizedPageObjectPaths?.length, expectedPages);
  assert.equal(state(r).progress.stage, "complete");
  assert.equal(state(r).progress.completedPages, expectedPages);
  assert.equal(state(r).progress.totalPages, expectedPages);
  createdObjectPaths.add(r.sanitizedPdfObjectPath!);
  r.sanitizedPageObjectPaths!.forEach((path) => createdObjectPaths.add(path));
  assert.ok(sawExpectedPrefix, "Resume did not retain the durable checkpoint prefix");
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
  const privateSourcePath = "/tmp/task86-private/source.pdf";
  const privateGeometryPath = "/tmp/task86-private/fixture.json";
  const exactFixtureAvailable = await Promise.all([
    access(privateSourcePath).then(() => true, () => false),
    access(privateGeometryPath).then(() => true, () => false),
  ]).then((available) => available.every(Boolean));
  let source: Buffer;
  let manual: Record<string, RedactionRect[]>;
  let pageCount: number;
  let manufacturer: string | null = null;
  if (exactFixtureAvailable) {
    const fixture = JSON.parse(await readFile(privateGeometryPath, "utf8")) as {
      pageCount: number;
      manufacturer?: string | null;
      geometry: Array<{ pageNumber: number; width: number; height: number }>;
      rectangles: Record<string, RedactionRect[]>;
    };
    source = await readFile(privateSourcePath);
    pageCount = fixture.pageCount;
    manufacturer = fixture.manufacturer ?? null;
    manual = fixture.rectangles;
    assert.equal(fixture.geometry.length, pageCount);
    assert.deepEqual(fixture.geometry.map((page) => page.pageNumber),
      Array.from({ length: pageCount }, (_, index) => index + 1));
    assert.deepEqual(Object.keys(manual).map(Number),
      Array.from({ length: pageCount }, (_, index) => index + 1));
  } else {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pageCount = 40;
    for (let i = 1; i <= pageCount; i++) {
      const page = pdf.addPage([240, 300]);
      page.drawRectangle({ x: 20, y: 240, width: 180, height: 40, color: rgb(0, 0, 0) });
      page.drawText(`SYNTHETIC SECRET ${i}`, { x: 25, y: 252, size: 10, font, color: rgb(1, 1, 1) });
      page.drawRectangle({ x: 20, y: 160, width: 180, height: 40, color: rgb(0, 0, 0) });
      page.drawText(`Public test page ${i}`, { x: 20, y: 100, size: 12, font });
    }
    source = Buffer.from(await pdf.save());
    manual = Object.fromEntries(Array.from({ length: pageCount }, (_, i) => [
      String(i + 1), [{ x: 18, y: 18, width: 184, height: 44 }],
    ]));
  }
  const [quote] = await db.insert(quotesTable).values({
    quoteNumber: tag, customerName: "Task 86 development fixture",
    categories: [], createdById: tag, createdByName: "Task86 development harness",
    notes: "Ephemeral development-only checkpoint evidence.",
  }).returning();
  quoteId = quote.id;
  const [packet] = await db.insert(packets).values({
    quoteId, originalName: exactFixtureAvailable ? "task86-private-source.pdf" : "task86-synthetic-40-pages.pdf",
    declaredSize: source.length, manufacturer,
    uploadObjectPath: `/objects/task86-development/${tag}/unused-upload`,
    status: "awaiting_upload", manualRedactions: manual,
  }).returning();
  packetId = packet.id;
  const sourcePath = packetSourcePath(quoteId, packetId);
  await storage.saveObjectEntityImmutable(sourcePath, source, "application/pdf");
  createdObjectPaths.add(sourcePath);
  await update({ sourceObjectPath: sourcePath, status: "queued" });
  evidence("fixture", { quoteId, packetId, fixture: exactFixtureAvailable ? "exact-private" : "synthetic",
    sourceBytes: source.length, pages: pageCount });
  let done = false;
  running = processPacket(packetId, false).finally(() => { done = true; });
  const deadline = Date.now() + 180_000;
  let interrupted: Awaited<ReturnType<typeof row>> | undefined;
  while (!done && Date.now() < deadline) {
    const r = await row();
    observe(r);
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
  assert.ok(prefix.length >= 2 && prefix.length < pageCount);
  assert.ok(prefix.every((batch) => batch.pageNumbers.length === 1 && batch.pagePaths.length === 1));
  const prefixHashes = await Promise.all(prefix.map(async b => {
    const bytes = await storage.downloadObjectBytesBounded(b.pdfPath, b.pdfBytes);
    assert.equal(hash(bytes), b.pdfSha256);
    return { pdf: hash(bytes), pngs: await Promise.all(b.pagePaths.map(async p =>
      hash(await storage.downloadObjectBytesBounded(p, 10 * 1024 * 1024)))) };
  }));
  evidence("interrupted", { batches: prefix.length, completedPages: state(stopped).progress.completedPages, analyses });
  await update({ status: "queued", processingStartedAt: null });
  const ready = await runToReady(pageCount, { expectedPrefix: prefix });
  for (const [i, b] of prefix.entries()) {
    assert.equal(hash(await storage.downloadObjectBytesBounded(b.pdfPath, b.pdfBytes)), prefixHashes[i].pdf);
    assert.deepEqual(await Promise.all(b.pagePaths.map(async p =>
      hash(await storage.downloadObjectBytesBounded(p, 10 * 1024 * 1024)))), prefixHashes[i].pngs);
  }
  assert.equal(analyses, 1, "Source analysis was rerun on resume");
  const finalBytes = await storage.downloadObjectBytesBounded(ready.sanitizedPdfObjectPath!, 100 * 1024 * 1024);
  assert.equal((await PDFDocument.load(finalBytes)).getPageCount(), pageCount);
  assert.equal(hash(finalBytes), ready.sanitizedPdfSha256);
  if (!exactFixtureAvailable) {
    assert.deepEqual(await pixels(finalBytes, [30, 30]), [255, 255, 255, 255]);
    assert.deepEqual(await pixels(finalBytes, [30, 110]), [0, 0, 0, 255]);
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(finalBytes) }).promise;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      assert.equal((await (await doc.getPage(n)).getTextContent()).items.length, 0);
    }
  } finally { await doc.cleanup(); await doc.loadingTask.destroy(); }
  evidence("resumed", { pages: pageCount, analyses, prefixPathsAndHashesUnchanged: true,
    completeRasterCount: ready.sanitizedPageObjectPaths?.length, approvalOnlyAfterComplete: true, textItems: 0 });
  const changed = Object.fromEntries(Object.entries(manual).map(([n, boxes]) =>
    [n, n === "1" ? [...boxes, exactFixtureAvailable
      ? { x: 0, y: 0, width: 612, height: 792 }
      : { x: 18, y: 98, width: 184, height: 44 }] : boxes]));
  // Deliberately preserve the old state to exercise renderFingerprint invalidation,
  // rather than hiding errors behind the HTTP route's eager checkpoint reset.
  await update({
    manualRedactions: changed, status: "queued", attemptCount: 0,
    sanitizedPdfObjectPath: null, sanitizedPdfSha256: null, sanitizedPageObjectPaths: null,
  });
  const oldPaths = new Set(createdObjectPaths);
  const regenerated = await runToReady(pageCount, { forbiddenPaths: oldPaths });
  assert.equal(analyses, 1);
  assert.equal(state(regenerated).analysisKey, state(ready).analysisKey);
  assert.notEqual(state(regenerated).renderKey, state(ready).renderKey);
  assert.ok(regenerated.sanitizedPageObjectPaths?.every((path) => !oldPaths.has(path)));
  assert.ok(!oldPaths.has(regenerated.sanitizedPdfObjectPath!));
  const changedBytes = await storage.downloadObjectBytesBounded(regenerated.sanitizedPdfObjectPath!, 100 * 1024 * 1024);
  assert.equal((await PDFDocument.load(changedBytes)).getPageCount(), pageCount);
  assert.notEqual(hash(changedBytes), hash(finalBytes));
  if (!exactFixtureAvailable) {
    assert.deepEqual(await pixels(changedBytes, [30, 110]), [255, 255, 255, 255]);
  }
  evidence("regenerated", { pages: pageCount, analyses, changedRedactionInvalidatedPrefix: true,
    oldRenderPathsNotReused: true });
} finally {
  await running?.catch(() => {});
  // All own writers have settled. Capture the durable registry before deleting
  // the packet: polling cannot observe uploaded-but-uncommitted checkpoints.
  if (packetId !== undefined) {
    const registered = await db.select({ path: checkpointObjects.objectPath })
      .from(checkpointObjects).where(eq(checkpointObjects.packetId, packetId));
    registered.forEach(({ path }) => createdObjectPaths.add(path));
    const [remaining] = await db.select().from(packets)
      .where(and(eq(packets.id, packetId), eq(packets.quoteId, quoteId!)));
    if (remaining) {
      if (remaining.sourceObjectPath) createdObjectPaths.add(remaining.sourceObjectPath);
      if (remaining.sanitizedPdfObjectPath) createdObjectPaths.add(remaining.sanitizedPdfObjectPath);
      remaining.sanitizedPageObjectPaths?.forEach((path) => createdObjectPaths.add(path));
    }
  }
  if (quoteId !== undefined) {
    await db.delete(quotesTable).where(and(eq(quotesTable.id, quoteId), eq(quotesTable.createdById, tag)));
  }
  let deletedObjects = 0;
  const cleanupFailures: string[] = [];
  for (const path of createdObjectPaths) {
    try {
      await storage.deleteObjectEntity(path);
      deletedObjects++;
    } catch {
      cleanupFailures.push(path);
    }
  }
  evidence("cleanup", { databaseFixtureDeleted: quoteId !== undefined, deletedObjects,
    cleanupFailures: cleanupFailures.length });
  assert.equal(cleanupFailures.length, 0, "Could not remove every ephemeral fixture object");
  if (packetId !== undefined) {
    await db.delete(checkpointObjects).where(eq(checkpointObjects.packetId, packetId));
    assert.equal((await db.select().from(checkpointObjects)
      .where(eq(checkpointObjects.packetId, packetId))).length, 0);
    assert.equal((await db.select().from(packets).where(eq(packets.id, packetId))).length, 0);
  }
  if (quoteId !== undefined) {
    assert.equal((await db.select().from(quotesTable).where(eq(quotesTable.id, quoteId))).length, 0);
  }
  evidence("cleanupVerified", { packetId, quoteId, ownRegistryRowsRemoved: true });
  packetEngine.analyzePdf = originalAnalyze;
  await pool.end();
}