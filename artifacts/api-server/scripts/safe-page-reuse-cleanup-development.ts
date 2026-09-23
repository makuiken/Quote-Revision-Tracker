import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { eq, and } from "drizzle-orm";
import { db, pool, quotesTable, manufacturerPacketsTable as packets, packetCheckpointObjectsTable as registry } from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { checkpointObjectPaths } from "../src/lib/packets/checkpoints";

if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Development only");
const id = Number(process.env.TASK95_CLEANUP_PACKET_ID);
assert.ok(Number.isSafeInteger(id) && id > 0, "Explicit own fixture packet ID required");
const storage = new ObjectStorageService();
try {
  const [packet] = await db.select().from(packets).where(eq(packets.id, id));
  assert.ok(packet);
  const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.id, packet.quoteId));
  assert.ok(quote && /^TASK95-[a-f0-9-]{36}$/.test(quote.createdById ?? "") &&
    quote.quoteNumber === quote.createdById && quote.customerName === "Task95 development fixture");
  const owned = await db.select().from(packets).where(eq(packets.quoteId, quote.id));
  const paths = new Set<string>();
  const ledgerPath = `/tmp/task95-evidence/${quote.createdById}.jsonl`;
  const ledger = await readFile(ledgerPath, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  // Ignore only a torn trailing append. Every completed line must validate.
  const lines = ledger.split("\n");
  lines.pop();
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.equal(record.fixtureTag, quote.createdById);
    assert.equal(record.quoteId, quote.id);
    if (record.kind === "object") {
      assert.equal(typeof record.path, "string");
      assert.ok(!record.path.includes("..") && !record.path.includes("\\"));
      assert.ok(owned.some(row => record.path.startsWith(`/objects/manufacturer-packets/${quote.id}/${row.id}/`)),
        "Ledger path must belong to this exact ephemeral fixture");
      paths.add(record.path);
    }
  }
  for (const row of owned) {
    assert.notEqual(row.status, "processing", "Refusing cleanup with an active writer");
    (await db.select().from(registry).where(eq(registry.packetId, row.id))).forEach(r => paths.add(r.objectPath));
    checkpointObjectPaths(row.processingState).forEach(p => paths.add(p));
    if (row.sourceObjectPath) paths.add(row.sourceObjectPath);
    if (row.sanitizedPdfObjectPath) paths.add(row.sanitizedPdfObjectPath);
    row.sanitizedPageObjectPaths?.forEach(p => paths.add(p));
  }
  for (const path of paths) await storage.deleteObjectEntity(path);
  await db.delete(quotesTable).where(and(eq(quotesTable.id, quote.id), eq(quotesTable.createdById, quote.createdById!)));
  for (const row of owned) {
    await db.delete(registry).where(eq(registry.packetId, row.id));
    assert.equal((await db.select().from(registry).where(eq(registry.packetId, row.id))).length, 0);
    assert.equal((await db.select().from(packets).where(eq(packets.id, row.id))).length, 0);
  }
  console.log(JSON.stringify({ task: 95, stage: "recovery-cleanup", fixtureTag: quote.createdById,
    packets: owned.length, objects: paths.size, failures: 0 }));
} finally { await pool.end(); }