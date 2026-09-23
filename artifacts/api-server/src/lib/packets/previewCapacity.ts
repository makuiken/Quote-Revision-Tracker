import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool, manufacturerPacketsTable, quotesTable } from "@workspace/db";
import { pdfCapacityConfiguration } from "./capacity";
import { PACKET_WORKER_LOCK_BASE, tryAcquirePacketWorkerSlot } from "./packetCapacity";
import { PacketWorkerQueueFullError } from "./workerClient";

/**
 * Cached previews bypass this gate. Cold previews may only use idle global
 * packet capacity; another replica's redaction job must not compete with them.
 * Acquisition is nonblocking, and no DB connection is held while waiting.
 */
export async function withOptionalPacketPreview<T>(render: () => Promise<T>): Promise<T> {
  const [pending] = await db.select({ id: manufacturerPacketsTable.id })
    .from(manufacturerPacketsTable)
    .innerJoin(quotesTable, eq(quotesTable.id, manufacturerPacketsTable.quoteId))
    .where(and(
      inArray(manufacturerPacketsTable.status, ["queued", "processing"]),
      isNull(quotesTable.archivedAt),
    )).limit(1);
  if (pending) throw new PacketWorkerQueueFullError();
  const slot = await tryAcquirePacketWorkerSlot(
    pool, PACKET_WORKER_LOCK_BASE, pdfCapacityConfiguration().packetSlots,
  );
  if (!slot) throw new PacketWorkerQueueFullError();
  try {
    return await render();
  } finally {
    await slot.release();
  }
}