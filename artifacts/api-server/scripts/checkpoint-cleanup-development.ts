import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import {
  db, pool, quotesTable, manufacturerPacketsTable as packets,
  packetCheckpointObjectsTable as objects, scopedApprovalRequestsTable,
  scopedApprovalsTable, signoffsTable,
} from "@workspace/db";
import {
  assertCheckpointPublication, legacyCheckpointPaths, registerCheckpointManifest,
  registerCheckpointPaths, retireCheckpointCandidate,
} from "../src/lib/packets/checkpointCleanup";

// Real PostgreSQL adapters, isolated temporary registry and rolled-back fixtures.
// Storage acknowledgements/late writes are injected deterministically; no real
// private object is created or deleted by this harness.
const rollback = new Error("intentional fixture rollback");
let assertions = 0;
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE TEMP TABLE packet_checkpoint_objects (
      object_path text PRIMARY KEY, packet_id integer NOT NULL, attempt_token text,
      created_at timestamptz NOT NULL DEFAULT now(), next_check_at timestamptz NOT NULL DEFAULT now()
    ) ON COMMIT DROP`);
    const [quote] = await tx.insert(quotesTable).values({
      quoteNumber: `checkpoint-cleanup-${randomUUID()}`, customerName: "Cleanup integration fixture",
      categories: ["Windows"], createdById: "cleanup-test", createdByName: "Cleanup test",
    }).returning();
    const [packet] = await tx.insert(packets).values({
      quoteId: quote!.id, originalName: "fixture.pdf", declaredSize: 1,
      uploadObjectPath: `/cleanup-test/${randomUUID()}`, status: "processing",
      processingAttemptToken: "attempt-a",
    }).returning();
    const id = packet!.id;
    const path = (name: string) => `/objects/manufacturer-packets/${quote!.id}/${id}/renders/${name}`;
    const pdf = path("batch.pdf"), png = path("page.png");
    const state = {
      version: 1, analysisKey: "a", analysis: { pages: [], profile: "unknown" }, renderKey: "r",
      batches: [{ pdfPath: pdf, pagePaths: [png] }],
      progress: { stage: "rendering", completedPages: 1, totalPages: 1 },
    };
    await registerCheckpointPaths(tx, id, "attempt-a", [pdf, png]);
    await assertCheckpointPublication(tx, id, "attempt-a", null, state);
    // An upload with a lost acknowledgement still has a durable reservation.
    const storage = new Set([pdf, png]);
    assert.equal(await retireCheckpointCandidate(pdf, id, tx), false);
    assertions++;
    // Ambiguous reference acknowledgement: durable reference wins over local
    // failure state, even after the worker's lease has expired.
    await tx.update(packets).set({ processingState: state, status: "failed" }).where(eq(packets.id, id));
    assert.equal(await retireCheckpointCandidate(pdf, id, tx), false);
    await tx.update(packets).set({ status: "processing", processingAttemptToken: "attempt-b" }).where(eq(packets.id, id));
    assert.equal(await retireCheckpointCandidate(pdf, id, tx), false);
    assertions += 2;
    // Finalization releases only batches, preserving the final page projection.
    await registerCheckpointManifest(tx, { id, processingState: state });
    await tx.update(packets).set({
      processingState: { ...state, batches: [] }, status: "ready_for_approval",
      sanitizedPageObjectPaths: [png],
    }).where(eq(packets.id, id));
    assert.equal(await retireCheckpointCandidate(pdf, id, tx), true);
    assert.equal(await retireCheckpointCandidate(png, id, tx), false);
    storage.delete(pdf); // delete succeeded but acknowledgement was lost
    assert.equal(await retireCheckpointCandidate(pdf, id, tx), true);
    storage.add(pdf); // expired worker finishes its earlier upload AFTER delete
    assert.equal(await retireCheckpointCandidate(pdf, id, tx), true);
    storage.delete(pdf);
    assert.equal(storage.has(pdf), false);
    // Re-registration cannot revive a retired reference, even with old token.
    await registerCheckpointPaths(tx, id, "attempt-a", [pdf]);
    await assert.rejects(assertCheckpointPublication(tx, id, "attempt-a", null, state), /retired/);
    assertions += 6;
    // Legacy malformed analysis still registers every explicit batch path.
    assert.deepEqual(legacyCheckpointPaths({ version: 0, batches: state.batches }), [pdf, png]);
    assertions++;
    const evidence = path("evidence.png");
    await registerCheckpointPaths(tx, id, null, [evidence]);
    const [request] = await tx.insert(scopedApprovalRequestsTable).values({
      quoteId: quote!.id, token: randomUUID(), productTypes: ["Windows"],
      snapshot: { pages: [evidence] }, documentVersion: "test", createdById: "test",
    }).returning();
    assert.equal(await retireCheckpointCandidate(evidence, id, tx), false);
    await tx.insert(scopedApprovalsTable).values({
      requestId: request!.id, quoteId: quote!.id, productTypes: ["Windows"],
      snapshot: { pages: [evidence] }, documentVersion: "test", customerName: "Test",
      stakeholderRole: "Other", signatureType: "typed", signatureData: "Test",
      signedDocumentObjectPath: path("signed.pdf"), signedDocumentSha256: "a".repeat(64),
    });
    await tx.update(scopedApprovalRequestsTable).set({ snapshot: {} }).where(eq(scopedApprovalRequestsTable.id, request!.id));
    assert.equal(await retireCheckpointCandidate(evidence, id, tx), false);
    await tx.insert(signoffsTable).values({
      quoteId: quote!.id, customerName: "Test", signatureType: "typed", signatureData: "Test",
      signedDocumentObjectPath: pdf,
    });
    assert.equal(await retireCheckpointCandidate(pdf, id, tx), false);
    assertions += 3;
    // Protected/failing low keys leave the due head: bounded ordered pages
    // progress to later candidates instead of retrying the same first object.
    const fresh = path("fresh.pdf");
    await registerCheckpointPaths(tx, id, null, [fresh]);
    const [head] = await tx.select().from(objects).orderBy(asc(objects.nextCheckAt), asc(objects.objectPath)).limit(1);
    assert.equal(head!.objectPath, fresh);
    assert.equal(await retireCheckpointCandidate(fresh, id, tx), true);
    const [tombstone] = await tx.select().from(objects).where(eq(objects.objectPath, fresh));
    assert.equal(tombstone!.attemptToken, null);
    assert.ok(tombstone!.nextCheckAt.getTime() > Date.now());
    assertions += 4;
    // No FK: explicit packet deletion does not remove late-write tombstones.
    await tx.delete(packets).where(eq(packets.id, id));
    assert.equal(await retireCheckpointCandidate(fresh, id, tx), true);
    assertions++;
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  await pool.end();
}
console.log(`PASS: ${assertions} real-database cleanup lifecycle assertions; fixtures rolled back.`);