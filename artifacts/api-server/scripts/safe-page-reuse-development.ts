import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { and, eq } from "drizzle-orm";
import { db, pool, quotesTable, signoffsTable, manufacturerPacketsTable as packets,
  packetCheckpointObjectsTable as registry } from "@workspace/db";
import { processPacket, packetSourcePath } from "../src/lib/packets/service";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { readProcessingState, resetRenderCheckpoints, checkpointObjectPaths } from "../src/lib/packets/checkpoints";
import { retireCheckpointCandidate } from "../src/lib/packets/checkpointCleanup";
import type { RedactionRect } from "../src/lib/packets/types";

if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1") {
  throw new Error("This integration harness is development-only.");
}
const tag = `TASK95-${randomUUID()}`;
const storage = new ObjectStorageService();
const objects = new Set<string>();
const ids: number[] = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const evidence = (stage: string, data: object = {}) => console.log(JSON.stringify({ task: 95, stage, ...data }));
type Boxes = Record<string, RedactionRect[]>;
type Row = typeof packets.$inferSelect;
let quoteId: number | undefined;
let running: Promise<unknown> | undefined;
const ledgerPath = `/tmp/task95-evidence/${tag}.jsonl`;
mkdirSync("/tmp/task95-evidence", { recursive: true, mode: 0o700 });
function ledger(record: object) {
  const fd = openSync(ledgerPath, "a", 0o600);
  try { writeSync(fd, `${JSON.stringify({ fixtureTag: tag, quoteId, ...record })}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function remember(path: string) {
  if (objects.has(path)) return;
  // Persist before any upload or mutation can drop the last database reference.
  ledger({ kind: "object", path });
  objects.add(path);
}
const originalSave = ObjectStorageService.prototype.saveObjectEntityImmutable;
ObjectStorageService.prototype.saveObjectEntityImmutable = async function(path, ...args) {
  if (quoteId !== undefined && ids.some(id => path.startsWith(`/objects/manufacturer-packets/${quoteId}/${id}/`))) {
    remember(path);
  }
  return originalSave.call(this, path, ...args);
};
async function get(id: number): Promise<Row> {
  const [r] = await db.select().from(packets).where(and(eq(packets.id, id), eq(packets.quoteId, quoteId!)));
  assert.ok(r);
  checkpointObjectPaths(r.processingState).forEach(remember);
  if (r.sanitizedPdfObjectPath) remember(r.sanitizedPdfObjectPath);
  r.sanitizedPageObjectPaths?.forEach(remember);
  return r;
}
async function set(id: number, values: Partial<typeof packets.$inferInsert>) {
  await db.update(packets).set(values).where(and(eq(packets.id, id), eq(packets.quoteId, quoteId!)));
}
async function create(source: Buffer, manual: Boxes, manufacturer: string | null = null) {
  const [r] = await db.insert(packets).values({
    quoteId: quoteId!, originalName: "development-fixture.pdf", declaredSize: source.length,
    manufacturer, uploadObjectPath: `/objects/task95/${tag}/${randomUUID()}`,
    manualRedactions: manual, status: "awaiting_upload",
  }).returning();
  ids.push(r.id);
  ledger({ kind: "packet", packetId: r.id });
  const path = packetSourcePath(quoteId!, r.id);
  remember(path);
  await storage.saveObjectEntityImmutable(path, source, "application/pdf");
  await set(r.id, { sourceObjectPath: path, status: "queued" });
  return r.id;
}
async function queue(id: number, manual: Boxes) {
  const r = await get(id);
  await set(id, { manualRedactions: structuredClone(manual), status: "queued", attemptCount: 0,
    processingStartedAt: null, processingAttemptToken: null,
    processingState: resetRenderCheckpoints(r.processingState, true),
    sanitizedPdfObjectPath: null, sanitizedPdfSha256: null, sanitizedPageObjectPaths: null });
}
async function run(id: number, count: number, renders: number, label: string) {
  const start = Date.now();
  running = processPacket(id, false);
  assert.equal(await running, "processed");
  const r = await get(id);
  assert.equal(r.status, "ready_for_approval", r.failureMessage ?? label);
  const s = readProcessingState(r.processingState)!;
  assert.equal(s.progress.completedPages, count);
  assert.equal(s.progress.stage, "complete");
  // These counters originate from worker render acknowledgements, not test estimates.
  const progress = s.progress as typeof s.progress & { renderedPages?: number; reusedPages?: number };
  assert.equal(progress.renderedPages, renders, `${label}: actual worker rendered pages`);
  assert.equal(progress.reusedPages, count - renders, `${label}: verified reused pages`);
  assert.equal(r.sanitizedPageObjectPaths?.length, count);
  const bytes = await storage.downloadObjectBytesBounded(r.sanitizedPdfObjectPath!, 120 * 1024 * 1024);
  assert.equal(hash(bytes), r.sanitizedPdfSha256);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), count);
  evidence(label, { pages: count, renderedPages: progress.renderedPages,
    reusedPages: progress.reusedPages, fullPathMs: Date.now() - start });
  return r;
}
async function pixelHashes(r: Row) {
  return Promise.all(r.sanitizedPageObjectPaths!.map(async path => {
    const image = await loadImage(await storage.downloadObjectBytesBounded(path, 24 * 1024 * 1024));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return hash(ctx.getImageData(0, 0, image.width, image.height).data);
  }));
}
async function parity(source: Buffer, manual: Boxes, current: Row, count: number, manufacturer: string | null = null) {
  const fresh = await create(source, manual, manufacturer);
  const full = await run(fresh, count, count, "fresh-full-render");
  assert.deepEqual(await pixelHashes(current), await pixelHashes(full));
  evidence("full-fresh-pixel-parity", { pages: count, identical: true });
}
try {
  const [q] = await db.insert(quotesTable).values({ quoteNumber: tag, customerName: "Task95 development fixture",
    categories: [], createdById: tag, createdByName: tag }).returning();
  quoteId = q.id;
  ledger({ kind: "fixture" });
  evidence("fixture-created", { fixtureTag: tag, quoteId, ledgerPath });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 5; n++) {
    const page = pdf.addPage([240, 300]);
    page.drawText(`Synthetic public page ${n}`, { x: 20, y: 200, size: 12, font });
    page.drawText("Synthetic selection area", { x: 20, y: 250, size: 12, font });
  }
  const source = Buffer.from(await pdf.save());
  const manual: Boxes = Object.fromEntries([1, 2, 3, 4, 5].map(n =>
    [String(n), [{ x: 18, y: 35, width: 150, height: 25 }]]));
  const id = await create(source, manual);
  let current = await run(id, 5, 5, "baseline-full");
  const signedPath = current.sanitizedPdfObjectPath!;
  const signedHash = current.sanitizedPdfSha256!;
  // Exercise retirement racing an own-row edit before installing a signature:
  // a blanket signature fence must not mask reusable-cache protection.
  const retained = readProcessingState(current.processingState)!.reusablePages![0];
  const retainedHashes = await Promise.all([retained.pdfPath, ...retained.pagePaths].map(async path =>
    hash(await storage.downloadObjectBytesBounded(path, 24 * 1024 * 1024))));
  let retirement: Promise<boolean[]> | undefined;
  await db.transaction(async tx => {
    await tx.select().from(quotesTable).where(eq(quotesTable.id, quoteId!)).for("update");
    const [locked] = await tx.select().from(packets).where(eq(packets.id, id)).for("update");
    await tx.update(packets).set({ status: "queued", processingState: resetRenderCheckpoints(locked.processingState, true),
      sanitizedPdfObjectPath: null, sanitizedPdfSha256: null, sanitizedPageObjectPaths: null })
      .where(eq(packets.id, id));
    retirement = Promise.all([retained.pdfPath, ...retained.pagePaths].map(path => retireCheckpointCandidate(path, id)));
    // Let competing transactions reach the held quote lock; never await them
    // until this transaction commits.
    await sleep(50);
  });
  assert.deepEqual(await retirement!, [false, false]);
  assert.deepEqual(await Promise.all([retained.pdfPath, ...retained.pagePaths].map(async path =>
    hash(await storage.downloadObjectBytesBounded(path, 24 * 1024 * 1024)))), retainedHashes);
  current = await run(id, 5, 0, "cleanup-race-no-op");
  evidence("concurrent-retirement", { retainedPdfAndPngProtected: true, signatureFenceAbsent: true });
  // An explicitly synthetic signature row binds immutable prior evidence. This
  // does not claim HTTP approval/signing coverage or impersonate a real signer.
  const [signed] = await db.insert(signoffsTable).values({ quoteId, customerName: tag,
    signatureType: "typed", signatureData: "SYNTHETIC DEVELOPMENT SIGNATURE",
    signedPacketId: id, signedPacketSha256: signedHash,
    signedDocumentObjectPath: signedPath, signedDocumentSha256: signedHash }).returning();
  for (const page of ["1", "3", "5"]) {
    for (const action of ["add", "move", "resize", "remove"]) {
      const before = current;
      if (action === "add") manual[page].push({ x: 20, y: 85, width: 120, height: 20 });
      if (action === "move") manual[page][1].x += 8;
      if (action === "resize") manual[page][1].width += 12;
      if (action === "remove") manual[page].pop();
      await queue(id, manual);
      current = await run(id, 5, 1, `${page}-${action}`);
      current.sanitizedPageObjectPaths!.forEach((path, index) => {
        if (index + 1 !== Number(page)) assert.equal(path, before.sanitizedPageObjectPaths![index]);
        else assert.notEqual(path, before.sanitizedPageObjectPaths![index]);
      });
      await parity(source, manual, current, 5);
    }
  }
  await queue(id, manual);
  current = await run(id, 5, 0, "no-op");
  manual["1"][0].x += 1;
  manual["5"][0].x += 1;
  await queue(id, manual);
  current = await run(id, 5, 2, "multi-page");
  await parity(source, manual, current, 5);
  for (const kind of ["pdf", "png"] as const) {
    for (const failure of ["missing", "corrupt"] as const) {
      const state = readProcessingState(current.processingState)!;
      const cache = (state as typeof state & { reusablePages?: Array<{ pdfPath: string; pagePaths: string[] }> }).reusablePages;
      assert.ok(cache?.length, "Completed result must retain reusable pages");
      const path = kind === "pdf" ? cache[2].pdfPath : cache[2].pagePaths[0];
      assert.ok(objects.has(path), "Only own fixture objects may be damaged");
      await storage.deleteObjectEntity(path);
      if (failure === "corrupt") await storage.saveObjectEntityImmutable(path, Buffer.from("invalid fixture bytes"),
        kind === "pdf" ? "application/pdf" : "image/png");
      await queue(id, manual);
      current = await run(id, 5, 1, `${failure}-${kind}`);
      await parity(source, manual, current, 5);
    }
  }
  // Supersede a real running attempt at the first durable prefix. Quote-first
  // locking matches production ordering; no I/O occurs while locks are held.
  for (const boxes of Object.values(manual)) boxes[0].x += 2;
  await queue(id, manual);
  let done = false;
  running = processPacket(id, false).finally(() => { done = true; });
  let interrupted: Row | undefined;
  const deadline = Date.now() + 180_000;
  while (!done && Date.now() < deadline) {
    const r = await get(id);
    const s = readProcessingState(r.processingState);
    if (r.status === "processing" && s?.batches.length && s.batches.length < 5) {
      interrupted = await db.transaction(async tx => {
        await tx.select().from(quotesTable).where(eq(quotesTable.id, quoteId!)).for("update");
        const [locked] = await tx.select().from(packets).where(eq(packets.id, id)).for("update");
        const lockedState = readProcessingState(locked.processingState);
        if (locked.status !== "processing" || !lockedState?.batches.length || lockedState.batches.length >= 5) return undefined;
        await tx.update(packets).set({ processingAttemptToken: randomUUID() }).where(eq(packets.id, id));
        return locked;
      });
      if (interrupted) break;
    }
    await sleep(5);
  }
  await running;
  assert.ok(interrupted, "Failed to catch an incomplete durable prefix");
  const stopped = await get(id);
  assert.deepEqual(stopped.processingState, interrupted.processingState, "Superseded worker modified state");
  assert.ok((readProcessingState(stopped.processingState) as { reusablePages?: unknown[] })?.reusablePages?.length,
    "Interrupted attempt lost its reusable-page cache");
  const prefix = readProcessingState(stopped.processingState)!.batches;
  await set(id, { status: "queued", processingStartedAt: null });
  // Resumed counters may include previous acknowledged renders; inspect final
  // prefix identity separately instead of assuming per-invocation counters.
  running = processPacket(id, false);
  assert.equal(await running, "processed");
  current = await get(id);
  assert.equal(current.status, "ready_for_approval");
  prefix.forEach(b => assert.equal(current.sanitizedPageObjectPaths![b.pageNumbers[0] - 1], b.pagePaths[0]));
  await parity(source, manual, current, 5);
  evidence("supersession-resume", { retainedPrefixPages: prefix.length, tokenFenceHeld: true });
  const [signedAfter] = await db.select().from(signoffsTable).where(eq(signoffsTable.id, signed.id));
  assert.deepEqual(signedAfter, signed);
  assert.equal(hash(await storage.downloadObjectBytesBounded(signedPath, 120 * 1024 * 1024)), signedHash);
  evidence("prior-signed-evidence", { rowUnchanged: true, bytesUnchanged: true });
  const available = await Promise.all(["source.pdf", "fixture.json"].map(name =>
    access(`/tmp/task86-private/${name}`).then(() => true, () => false)));
  if (available.every(Boolean)) {
    const privateSource = await readFile("/tmp/task86-private/source.pdf");
    const fixture = JSON.parse(await readFile("/tmp/task86-private/fixture.json", "utf8"));
    assert.equal(fixture.pageCount, 31, "Expected exact private31 fixture");
    const boxes: Boxes = structuredClone(fixture.rectangles);
    const privateId = await create(privateSource, boxes, fixture.manufacturer ?? null);
    await run(privateId, 31, 31, "private31-baseline-full");
    boxes["16"] = [...(boxes["16"] ?? []), { x: 0, y: 0, width: 12, height: 12 }];
    await queue(privateId, boxes);
    const changed = await run(privateId, 31, 1, "private31-single-edit");
    await parity(privateSource, boxes, changed, 31, fixture.manufacturer ?? null);
  } else evidence("private31-skipped", { reason: "Exact private fixture unavailable" });
  evidence("matrix-passed");
} finally {
  await running?.catch(() => {});
  for (const id of ids) {
    const registered = await db.select().from(registry).where(eq(registry.packetId, id));
    registered.forEach(r => remember(r.objectPath));
    await get(id);
  }
  const failures: string[] = [];
  const pending = [...objects];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const path = pending.pop();
      if (!path) return;
      try { await storage.deleteObjectEntity(path); } catch { failures.push(path); }
    }
  }));
  // Keep registry/fixture ownership discoverable if deletion failed.
  if (!failures.length && quoteId !== undefined) {
    await db.delete(quotesTable).where(and(eq(quotesTable.id, quoteId), eq(quotesTable.createdById, tag)));
    for (const id of ids) {
      await db.delete(registry).where(eq(registry.packetId, id));
      assert.equal((await db.select().from(registry).where(eq(registry.packetId, id))).length, 0);
      assert.equal((await db.select().from(packets).where(eq(packets.id, id))).length, 0);
    }
  }
  evidence("cleanup", { fixtureTag: tag, packets: ids.length, objects: objects.size, failures: failures.length });
  ledger({ kind: "cleanup", failures: failures.length });
  ObjectStorageService.prototype.saveObjectEntityImmutable = originalSave;
  await pool.end();
  assert.equal(failures.length, 0, "Own fixture objects remain; registry retained for recovery");
}