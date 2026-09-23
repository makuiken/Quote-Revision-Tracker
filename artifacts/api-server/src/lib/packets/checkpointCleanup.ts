import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import {
  db, manufacturerPacketsTable as packets, packetCheckpointObjectsTable as objects,
  quotesTable, scopedApprovalRequestsTable, scopedApprovalsTable, signoffsTable,
} from "@workspace/db";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import { boundedReusablePages, checkpointObjectPaths, reusablePageValid, type ReusablePage } from "./checkpoints";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const storage = new ObjectStorageService();
const PAGE_SIZE = 25;
let backfillCursor = 0;
let sweeping = false;

/** Also accepts legacy manifests whose analysis/version is no longer readable. */
export function legacyCheckpointPaths(value: unknown): string[] {
  const state = value as { batches?: unknown; reusablePages?: unknown } | null;
  const batches = [...(Array.isArray(state?.batches) ? state.batches : []),
    ...(Array.isArray(state?.reusablePages) ? state.reusablePages : [])];
  return [...new Set(batches.flatMap((batch) => [
    batch?.pdfPath, ...(Array.isArray(batch?.pagePaths) ? batch.pagePaths : []),
  ]).filter((path): path is string => typeof path === "string" &&
    /^\/objects\/manufacturer-packets\/\d+\/\d+\/renders\/[^/]+\.(pdf|png)$/.test(path)))];
}

/** Call under the quote -> packet locks, before replacing/deleting a manifest. */
export async function registerCheckpointManifest(
  tx: Transaction, packet: { id: number; processingState: unknown },
  nextState: unknown = null,
): Promise<void> {
  const paths = legacyCheckpointPaths(packet.processingState);
  await registerCheckpointPaths(tx, packet.id, null, paths);
  const retained = new Set(legacyCheckpointPaths(nextState));
  const dropped = paths.filter((path) => !retained.has(path));
  if (dropped.length) {
    await tx.update(objects).set({ attemptToken: null })
      .where(and(eq(objects.packetId, packet.id), inArray(objects.objectPath, dropped)));
  }
}

export async function registerCheckpointPaths(
  tx: Pick<Transaction, "insert">, packetId: number, attemptToken: string | null, paths: string[],
): Promise<void> {
  if (!paths.length) return;
  // Never revive a tombstone, including on ambiguous insert acknowledgement.
  await tx.insert(objects).values([...new Set(paths)].map((objectPath) => ({
    objectPath, packetId, attemptToken,
  }))).onConflictDoNothing();
}

/** New references need a live pre-write reservation; durable references may resume. */
export async function assertCheckpointPublication(
  tx: Transaction, packetId: number, attemptToken: string, previous: unknown, next: unknown,
): Promise<void> {
  const prior = new Set(legacyCheckpointPaths(previous));
  const additions = checkpointObjectPaths(next).filter((path) => !prior.has(path));
  if (!additions.length) return;
  const reservations = await tx.select().from(objects).where(and(
    inArray(objects.objectPath, additions), eq(objects.packetId, packetId),
    eq(objects.attemptToken, attemptToken),
  ));
  if (new Set(reservations.map((row) => row.objectPath)).size !== new Set(additions).size) {
    throw new Error("Checkpoint reservation retired or processing lease superseded.");
  }
}

async function backfillCheckpointManifests(): Promise<void> {
  const rows = await db.select({ id: packets.id }).from(packets)
    .where(gt(packets.id, backfillCursor)).orderBy(asc(packets.id)).limit(PAGE_SIZE);
  for (const row of rows) {
    try {
      await db.transaction(async (tx) => {
        const [identity] = await tx.select({ quoteId: packets.quoteId }).from(packets).where(eq(packets.id, row.id));
        if (!identity) return;
        await tx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, identity.quoteId)).for("update");
        const [packet] = await tx.select().from(packets).where(eq(packets.id, row.id)).for("update");
        if (!packet) return;
        // Legacy analysis versions need not be understood to release explicit
        // batch references on an already successfully finalized packet.
        const state = packet.processingState as { batches?: unknown; reusablePages?: unknown } | null;
        const complete = state && (Array.isArray(state.batches) || Array.isArray(state.reusablePages)) &&
          ["ready_for_approval", "approved"].includes(packet.status) && packet.sanitizedPdfObjectPath;
        const nextState = complete ? { ...state, batches: [],
          reusablePages: boundedReusablePages(
            (Array.isArray(state.reusablePages) ? state.reusablePages : [])
              .filter((page: ReusablePage) => reusablePageValid(page, packet.quoteId, packet.id)),
          ),
        } : packet.processingState;
        await registerCheckpointManifest(tx, packet, nextState);
        if (complete) {
          await tx.update(packets).set({ processingState: nextState }).where(eq(packets.id, packet.id));
        }
      });
    } catch (err) {
      logger.warn({ err, packetId: row.id }, "Checkpoint manifest backfill deferred");
    } finally {
      // A malformed legacy row must not starve subsequent packets. Wraparound
      // retries it on the next bounded pass.
      backfillCursor = row.id;
    }
  }
  if (rows.length < PAGE_SIZE) backfillCursor = 0;
}

export async function retireCheckpointCandidate(
  objectPath: string, packetId: number,
  database: Pick<typeof db, "transaction"> = db,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [identity] = await tx.select({ quoteId: packets.quoteId }).from(packets).where(eq(packets.id, packetId));
    if (identity) {
      await tx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, identity.quoteId)).for("update");
    }
    const [packet] = await tx.select().from(packets).where(eq(packets.id, packetId)).for("update");
    const [candidate] = await tx.select().from(objects).where(eq(objects.objectPath, objectPath)).for("update");
    if (!candidate) return false;
    // Move every inspected row to the back of the due queue, including protected
    // rows and storage failures. No failure can monopolize the bounded head.
    await tx.update(objects).set({ nextCheckAt: new Date(Date.now() + 60 * 60_000) })
      .where(eq(objects.objectPath, objectPath));
    if (packet?.status === "processing" && candidate.attemptToken &&
        packet.processingAttemptToken === candidate.attemptToken) return false;
    const [reference] = await tx.select({ id: packets.id }).from(packets).where(or(
      eq(packets.sourceObjectPath, objectPath), eq(packets.uploadObjectPath, objectPath),
      eq(packets.sanitizedPdfObjectPath, objectPath),
      sql`${packets.sanitizedPageObjectPaths} @> ${JSON.stringify([objectPath])}::jsonb`,
      sql`${packets.processingState}->'batches' @> ${JSON.stringify([{ pdfPath: objectPath }])}::jsonb`,
      sql`${packets.processingState}->'batches' @> ${JSON.stringify([{ pagePaths: [objectPath] }])}::jsonb`,
      sql`${packets.processingState}->'reusablePages' @> ${JSON.stringify([{ pdfPath: objectPath }])}::jsonb`,
      sql`${packets.processingState}->'reusablePages' @> ${JSON.stringify([{ pagePaths: [objectPath] }])}::jsonb`,
    )).limit(1);
    if (reference) return false;
    const [signed] = await tx.select({ id: signoffsTable.id }).from(signoffsTable).where(or(
      eq(signoffsTable.signedPacketId, packetId), eq(signoffsTable.signedDocumentObjectPath, objectPath),
    )).limit(1);
    const [scoped] = await tx.select({ id: scopedApprovalsTable.id }).from(scopedApprovalsTable).where(or(
      eq(scopedApprovalsTable.signedDocumentObjectPath, objectPath),
      sql`strpos(${scopedApprovalsTable.snapshot}::text, ${objectPath}) > 0`,
    )).limit(1);
    const [request] = await tx.select({ id: scopedApprovalRequestsTable.id }).from(scopedApprovalRequestsTable)
      .where(sql`strpos(${scopedApprovalRequestsTable.snapshot}::text, ${objectPath}) > 0`).limit(1);
    if (signed || scoped || request) return false;
    // Commit the irreversible publication fence BEFORE external deletion. No
    // row locks are held during storage I/O. Null is never upgraded to a token.
    await tx.update(objects).set({ attemptToken: null }).where(eq(objects.objectPath, objectPath));
    return true;
  });
}

/** Bounded, due-index ordered work; tombstones deliberately survive forever. */
export async function sweepCheckpointObjects(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await backfillCheckpointManifests();
    const due = await db.select().from(objects).where(lte(objects.nextCheckAt, new Date()))
      .orderBy(asc(objects.nextCheckAt), asc(objects.objectPath)).limit(PAGE_SIZE);
    for (const candidate of due) {
      try {
        if (await retireCheckpointCandidate(candidate.objectPath, candidate.packetId)) {
          await storage.deleteObjectEntity(candidate.objectPath, 3_000);
        }
      } catch (err) {
        logger.warn({ err, packetId: candidate.packetId }, "Checkpoint cleanup deferred; durable candidate retained");
        // Even ambiguous retirement/deletion acknowledgements retain the row.
        await db.update(objects).set({ nextCheckAt: new Date(Date.now() + 60 * 60_000) })
          .where(eq(objects.objectPath, candidate.objectPath)).catch(() => undefined);
      }
    }
  } finally {
    sweeping = false;
  }
}