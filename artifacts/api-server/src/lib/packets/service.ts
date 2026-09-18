import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  manufacturerPacketManifestTable,
  manufacturerPacketsTable,
  manufacturerRedactionTemplatesTable,
  pool,
  quotesTable,
  scopedApprovalsTable,
  signoffsTable,
  type ManufacturerPacket,
} from "@workspace/db";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import { recordOperationalFailure } from "../operationalSignals";
import { packetEngine } from "./engine";
import {
  isAbandonedProcessingJob,
  nextRecoveryScanCursor,
  recoveryAction,
} from "./recovery";
import type { PacketPageAnalysis, RedactionRect } from "./types";
import {
  canonicalManufacturer,
  matchingTemplateRedactions,
  templateLayoutMismatchFeedback,
  templateNoActiveMatchFeedback,
} from "./templates";
import { pdfCapacityConfiguration } from "./capacity";
import { PacketWorkerError, PacketWorkerTimeoutError } from "./workerClient";

const storage = new ObjectStorageService();
const MAX_PROCESSING_ATTEMPTS = 3;
const MAX_PACKET_BYTES = 40 * 1024 * 1024;
const PACKET_WORKER_LOCK_BASE = 7_472_657_400;
const RECOVERY_PAGE_SIZE = 50;
const RECOVERY_MAX_PAGES = 4;
const PACKET_SLOT_RETRY_MS = 1_000;
const pendingPacketJobs = new Set<number>();
let activeLocalPacketJobs = 0;
let packetRetryTimer: NodeJS.Timeout | undefined;
let recoveryScanCursor = 0;

export { isAbandonedProcessingJob } from "./recovery";

/**
 * Advisory locks are session-scoped, so this connection is intentionally held
 * for the complete packet job rather than just the claim transaction. Every
 * API replica therefore competes for the same finite set of slots.
 */
function globalPacketWorkerSlotCount(): number {
  return pdfCapacityConfiguration().packetSlots;
}

async function tryAcquireGlobalPacketWorkerSlot(): Promise<{
  release: () => Promise<void>;
  slot: number;
} | null> {
  const client = await pool.connect();
  const slotCount = globalPacketWorkerSlotCount();
  try {
    for (let slot = 0; slot < slotCount; slot += 1) {
      const lockKey = PACKET_WORKER_LOCK_BASE + slot;
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [lockKey],
      );
      if (!result.rows[0]?.acquired) continue;

      let released = false;
      return {
        slot,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query(
              "SELECT pg_advisory_unlock($1::bigint)",
              [lockKey],
            );
            client.release();
          } catch (error) {
            // Never return a connection that might still own the advisory
            // lock. Destroying it is safer than leaking a global slot.
            client.release(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        },
      };
    }
    client.release();
    return null;
  } catch (error) {
    recordOperationalFailure("packet_processing");
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export function serializePacket(packet: ManufacturerPacket) {
  return {
    id: packet.id,
    quoteId: packet.quoteId,
    manufacturer: packet.manufacturer,
    productType: packet.productType,
    detectedManufacturer: packet.detectedManufacturer,
    originalName: packet.originalName,
    status: packet.status,
    pageCount: packet.pageCount,
    analysis: packet.analysis,
    manualRedactions: packet.manualRedactions,
    appliedTemplate: packet.appliedRedactionTemplateId
      ? {
          id: packet.appliedRedactionTemplateId,
          name: packet.appliedRedactionTemplateName ?? "",
          manufacturer: packet.manufacturer!,
          productType: packet.productType!,
        }
      : null,
    failureMessage: packet.failureMessage,
    createdAt: packet.createdAt,
    updatedAt: packet.updatedAt,
    approvedAt: packet.approvedAt,
  };
}

export async function getPacket(quoteId: number, packetId: number) {
  const [packet] = await db
    .select()
    .from(manufacturerPacketsTable)
    .where(
      and(
        eq(manufacturerPacketsTable.id, packetId),
        eq(manufacturerPacketsTable.quoteId, quoteId),
      ),
    );
  return packet ?? null;
}

export async function getApprovedPacket(quoteId: number) {
  const [packet] = await db
    .select()
    .from(manufacturerPacketsTable)
    .where(
      and(
        eq(manufacturerPacketsTable.quoteId, quoteId),
        eq(manufacturerPacketsTable.status, "approved"),
      ),
    )
    .orderBy(manufacturerPacketsTable.approvedAt);
  return packet ?? null;
}

export async function loadApprovedManifest(
  tx: Pick<typeof db, "select">,
  quoteId: number,
) {
  return tx
    .select({
      packetId: manufacturerPacketManifestTable.packetId,
      pageNumber: manufacturerPacketManifestTable.pageNumber,
      pageOrder: manufacturerPacketManifestTable.pageOrder,
      sanitizedPdfObjectPath: manufacturerPacketsTable.sanitizedPdfObjectPath,
      sanitizedPdfSha256: manufacturerPacketsTable.sanitizedPdfSha256,
      pagePath: manufacturerPacketsTable.sanitizedPageObjectPaths,
    })
    .from(manufacturerPacketManifestTable)
    .innerJoin(
      manufacturerPacketsTable,
      eq(manufacturerPacketManifestTable.packetId, manufacturerPacketsTable.id),
    )
    .where(
      and(
        eq(manufacturerPacketManifestTable.quoteId, quoteId),
        eq(manufacturerPacketsTable.status, "approved"),
      ),
    )
    .orderBy(manufacturerPacketManifestTable.pageOrder);
}

export function packetSourcePath(quoteId: number, packetId: number) {
  return `/objects/manufacturer-packets/${quoteId}/${packetId}/source.pdf`;
}

export function packetUploadPath(quoteId: number, packetId: number) {
  return `/objects/manufacturer-packet-staging/${quoteId}/${packetId}-${randomUUID()}.pdf`;
}

function renderedPdfPath(quoteId: number, packetId: number) {
  return `/objects/manufacturer-packets/${quoteId}/${packetId}/renders/${randomUUID()}.pdf`;
}

function renderedPagePath(quoteId: number, packetId: number, pageNumber: number) {
  return `/objects/manufacturer-packets/${quoteId}/${packetId}/renders/${randomUUID()}-page-${pageNumber}.png`;
}

function cleanError(error: unknown) {
  if (error instanceof PacketWorkerTimeoutError) {
    return "PDF analysis timed out before it could finish. Retry once; if it fails again, split the manufacturer quote into smaller PDFs.";
  }
  if (error instanceof PacketWorkerError) {
    return error.code === "ERR_WORKER_OUT_OF_MEMORY"
      ? "PDF analysis exceeded its memory limit. Split the manufacturer quote into smaller PDFs and upload them separately."
      : `PDF analysis worker failed: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : "Unknown packet processing error";
  return message.slice(0, 500);
}

function validAnalysis(pages: PacketPageAnalysis[]): boolean {
  return (
    pages.length > 0 &&
    pages.length <= 500 &&
    pages.every(
      (page, index) =>
        page.pageNumber === index + 1 &&
        Number.isFinite(page.width) &&
        page.width > 0 &&
        Number.isFinite(page.height) &&
        page.height > 0 &&
        page.suggestedRects.length <= 100,
    )
  );
}

type ProcessingPacketUpdate = Partial<typeof manufacturerPacketsTable.$inferInsert>;

/**
 * All processing metadata writes use the same quote-first lock discipline as
 * packet mutations. This prevents a product-type/manifest mutation from
 * racing a worker completion.
 */
async function updateProcessingPacket(
  quoteId: number,
  packetId: number,
  attemptToken: string,
  values: ProcessingPacketUpdate,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [quote] = await tx
      .select({ archivedAt: quotesTable.archivedAt })
      .from(quotesTable)
      .where(eq(quotesTable.id, quoteId))
      .for("update");
    if (!quote || quote.archivedAt) return false;
    const [packet] = await tx
      .select({ id: manufacturerPacketsTable.id })
      .from(manufacturerPacketsTable)
      .where(
        and(
          eq(manufacturerPacketsTable.id, packetId),
          eq(manufacturerPacketsTable.quoteId, quoteId),
          eq(manufacturerPacketsTable.status, "processing"),
          eq(manufacturerPacketsTable.processingAttemptToken, attemptToken),
        ),
      )
      .for("update");
    if (!packet) return false;
    await tx
      .update(manufacturerPacketsTable)
      .set(values)
      .where(eq(manufacturerPacketsTable.id, packetId));
    return true;
  });
}

async function updateProcessingPacketWithRetry(
  quoteId: number,
  packetId: number,
  attemptToken: string,
  values: ProcessingPacketUpdate,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await updateProcessingPacket(quoteId, packetId, attemptToken, values);
    } catch (error) {
      lastError = error;
      recordOperationalFailure("packet_processing");
      logger.warn(
        { err: error, packetId, attempt },
        "Packet finalization could not acquire database capacity; retrying",
      );
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw lastError;
}

async function saveRenderedPages(
  pages: Array<{ pngBytes: Uint8Array }>,
  paths: string[],
  heartbeat: () => Promise<void>,
): Promise<void> {
  const concurrency = 2;
  for (let index = 0; index < pages.length; index += concurrency) {
    const batch = pages.slice(index, index + concurrency);
    const writes = await Promise.allSettled(
      batch.map((page, offset) =>
        storage.saveObjectEntityImmutable(
          paths[index + offset]!,
          page.pngBytes,
          "image/png",
        ),
      ),
    );
    const failedWrite = writes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedWrite) throw failedWrite.reason;
    await heartbeat();
  }
}

/**
 * A render is written before its durable packet reference because object
 * storage cannot participate in the database transaction. On a lost/aborted
 * reference commit, remove only these newly generated paths. Every deletion
 * is guarded by a fresh reference/evidence check and failures are
 * fail-closed, so a signed or referenced object is never treated as garbage.
 */
async function cleanupUncommittedRenderObjects(
  packetId: number,
  paths: string[],
): Promise<void> {
  for (const path of paths) {
    try {
      const [packetReference] = await db
        .select({
          id: manufacturerPacketsTable.id,
        })
        .from(manufacturerPacketsTable)
        .where(
          or(
            eq(manufacturerPacketsTable.sanitizedPdfObjectPath, path),
            sql`${manufacturerPacketsTable.sanitizedPageObjectPaths} @> ${JSON.stringify([path])}::jsonb`,
          ),
        )
        .limit(1);
      if (packetReference) {
        logger.warn(
          { packetId, path, referencedByPacketId: packetReference.id },
          "Skipping cleanup of referenced packet render",
        );
        continue;
      }

      const [signedEvidence] = await db
        .select({ id: signoffsTable.id })
        .from(signoffsTable)
        .where(
          or(
            eq(signoffsTable.signedPacketId, packetId),
            eq(signoffsTable.signedDocumentObjectPath, path),
          ),
        )
        .limit(1);
      if (signedEvidence) {
        logger.warn(
          { packetId, path, signoffId: signedEvidence.id },
          "Skipping cleanup of signed packet evidence",
        );
        continue;
      }

      const [scopedEvidence] = await db
        .select({ id: scopedApprovalsTable.id })
        .from(scopedApprovalsTable)
        .where(eq(scopedApprovalsTable.signedDocumentObjectPath, path))
        .limit(1);
      if (scopedEvidence) {
        logger.warn(
          { packetId, path, approvalId: scopedEvidence.id },
          "Skipping cleanup of signed scoped evidence",
        );
        continue;
      }

      await storage.deleteObjectEntity(path);
    } catch (error) {
      // A failed protection check must never turn into a destructive cleanup.
      logger.error(
        { err: error, packetId, path },
        "Could not verify packet render references; leaving object in storage",
      );
    }
  }
}

/**
 * Claim then process one durable job. Calling this without awaiting is safe:
 * the DB transition to processing is persisted first and retry can recover an
 * instance that exits mid-render.
 */
export async function processPacket(
  packetId: number,
): Promise<"processed" | "contended"> {
  const slot = await tryAcquireGlobalPacketWorkerSlot();
  if (!slot) {
    // The durable row deliberately remains queued. Recovery will find it on a
    // later bounded scan instead of turning temporary slot pressure into a
    // failed attempt.
    logger.info(
      { packetId, globalSlotCount: globalPacketWorkerSlotCount() },
      "No global packet worker slot available; leaving packet queued",
    );
    pendingPacketJobs.add(packetId);
    schedulePacketQueueRetry();
    return "contended";
  }

  try {
    await processPacketWithSlot(packetId);
    return "processed";
  } finally {
    await slot.release();
  }
}

async function processPacketWithSlot(packetId: number): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    // The identity read is deliberately non-locking: it only discovers the
    // parent key. Actual row locks are always acquired quote first, packet
    // second throughout the packet lifecycle.
    const [identity] = await tx
      .select({ quoteId: manufacturerPacketsTable.quoteId })
      .from(manufacturerPacketsTable)
      .where(eq(manufacturerPacketsTable.id, packetId));
    if (!identity) return null;
    const [quote] = await tx
      .select({ archivedAt: quotesTable.archivedAt })
      .from(quotesTable)
      .where(eq(quotesTable.id, identity.quoteId))
      .for("update");
    if (!quote || quote.archivedAt) return null;
    const [packet] = await tx
      .select()
      .from(manufacturerPacketsTable)
      .where(
        and(
          eq(manufacturerPacketsTable.id, packetId),
          eq(manufacturerPacketsTable.quoteId, identity.quoteId),
        ),
      )
      .for("update");
    if (!packet || packet.status !== "queued") return null;
    if (packet.attemptCount >= MAX_PROCESSING_ATTEMPTS) {
      await tx
        .update(manufacturerPacketsTable)
        .set({
          status: "failed",
          failureMessage: "Processing retry limit reached. Upload a new packet.",
          processingStartedAt: null,
        })
        .where(eq(manufacturerPacketsTable.id, packet.id));
      return null;
    }
    const [updated] = await tx
      .update(manufacturerPacketsTable)
      .set({
        status: "processing",
        attemptCount: packet.attemptCount + 1,
        processingAttemptToken: randomUUID(),
        processingStartedAt: new Date(),
        failureMessage: null,
      })
      .where(eq(manufacturerPacketsTable.id, packet.id))
      .returning();
    return updated ?? null;
  });
  if (!claimed?.sourceObjectPath || !claimed.processingAttemptToken) return;
  const attemptToken = claimed.processingAttemptToken;
  let lastHeartbeatAt = Date.now();
  const heartbeat = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < 60_000) return;
    const stillOwned = await updateProcessingPacketWithRetry(
      claimed.quoteId,
      claimed.id,
      attemptToken,
      {
        status: "processing",
        processingStartedAt: new Date(now),
      },
    );
    if (!stillOwned) {
      throw new Error("Packet processing attempt was superseded during persistence.");
    }
    lastHeartbeatAt = now;
  };
  const withHeartbeats = async <T>(operation: () => Promise<T>): Promise<T> => {
    let heartbeatFailure: unknown;
    let heartbeatChain = Promise.resolve();
    await heartbeat(true);
    const timer = setInterval(() => {
      heartbeatChain = heartbeatChain
        .then(() => heartbeat(true))
        .catch((error: unknown) => {
          heartbeatFailure ??= error;
        });
    }, 60_000);
    timer.unref?.();
    try {
      const result = await operation();
      await heartbeatChain;
      if (heartbeatFailure) throw heartbeatFailure;
      return result;
    } finally {
      clearInterval(timer);
    }
  };
  let newlyWrittenRenderPaths: string[] = [];

  try {
    const source = await storage.downloadObjectBytesBounded(
      claimed.sourceObjectPath,
      MAX_PACKET_BYTES,
    );
    if (source.byteLength === 0 || source.byteLength > MAX_PACKET_BYTES) {
      throw new Error("Packet must be a non-empty PDF no larger than 40 MiB.");
    }
    if (
      source[0] !== 0x25 ||
      source[1] !== 0x50 ||
      source[2] !== 0x44 ||
      source[3] !== 0x46
    ) {
      throw new Error("Uploaded file is not a valid PDF.");
    }

    const analysis = await withHeartbeats(() =>
      packetEngine.analyzePdf(source, claimed.manufacturer),
    );
    if (!validAnalysis(analysis.pages)) {
      throw new Error("PDF analysis returned invalid or unsupported page geometry.");
    }

    // Null means the reviewer has not explicitly accepted/changed the
    // suggestions. An empty object is a valid explicit review with no
    // redactions. A template can prefill review, but never sanitize or publish.
    // Template geometry is applied only when the complete analyzed page layout
    // matches; never carry a subset of boxes across a changed document.
    // packetEngine's compatibility interface is intersected with its legacy
    // type in the currently published declaration; the worker adapter returns
    // this profile alongside pages at runtime.
    const detectedProfile = (
      analysis as typeof analysis & { profile: string }
    ).profile;
    const hasManualReview = claimed.manualRedactions !== null;
    if (!hasManualReview) {
      const [template] = claimed.manufacturer && claimed.productType
        ? await db
            .select()
            .from(manufacturerRedactionTemplatesTable)
            .where(
              and(
                eq(
                  manufacturerRedactionTemplatesTable.manufacturerCanonical,
                  canonicalManufacturer(claimed.manufacturer),
                ),
                sql`${manufacturerRedactionTemplatesTable.eligibleProductTypes} && ARRAY[${claimed.productType}]::text[]`,
                eq(manufacturerRedactionTemplatesTable.active, true),
              ),
            )
            .limit(1)
        : [];
      const manualFromTemplate = template
        ? matchingTemplateRedactions(analysis.pages, template.pages)
        : null;
      const templateFeedback = template
        ? manualFromTemplate
          ? null
          : templateLayoutMismatchFeedback(template.name)
        : templateNoActiveMatchFeedback(claimed.manufacturer, claimed.productType);
      if (template && !manualFromTemplate) {
        logger.warn(
          {
            packetId: claimed.id,
            templateId: template.id,
            manufacturer: claimed.manufacturer,
            productType: claimed.productType,
          },
          "Redaction template did not match the complete packet layout; manual review required",
        );
      } else if (!template) {
        logger.info(
          {
            packetId: claimed.id,
            manufacturer: claimed.manufacturer,
            productType: claimed.productType,
          },
          "No active redaction template matched; manual review required",
        );
      }
      await updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
        status: "needs_review",
        analysis: analysis.pages,
        manualRedactions: manualFromTemplate
          ? manualFromTemplate
          : claimed.manualRedactions,
        appliedRedactionTemplateId:
          manualFromTemplate ? template!.id : null,
        appliedRedactionTemplateName:
          manualFromTemplate ? template!.name : null,
        // `failureMessage` is also the durable processing-feedback field for
        // a needs_review packet. The prefix gives clients a stable reason
        // without inferring it from the current active template options.
        failureMessage: templateFeedback,
        detectedManufacturer:
          detectedProfile === "unknown" ? null : detectedProfile,
        pageCount: analysis.pages.length,
        processingStartedAt: null,
      });
      return;
    }

    const manual = claimed.manualRedactions as Record<string, RedactionRect[]>;
    const redactionsByPage = Object.fromEntries(
      Object.entries(manual).map(([page, rectangles]) => [Number(page), rectangles]),
    );
    const sanitized = await withHeartbeats(() =>
      packetEngine.generateSanitizedPacket({
        bytes: source,
        // Prefer the explicit manufacturer but pass a bounded deterministic
        // detection result through to the engine when the upload did not name it.
        manufacturer:
          claimed.manufacturer ??
          (detectedProfile === "unknown" ? null : detectedProfile),
        redactionsByPage,
      }),
    );
    if (
      sanitized.pages.length !== analysis.pages.length ||
      sanitized.pages.some((page, index) => page.pageNumber !== index + 1 || !page.pngBytes.length) ||
      !sanitized.pdfBytes.length
    ) {
      throw new Error("PDF sanitization returned incomplete page output.");
    }
    await heartbeat(true);

    const pdfPath = renderedPdfPath(claimed.quoteId, claimed.id);
    const pagePaths = sanitized.pages.map((page) =>
      renderedPagePath(claimed.quoteId, claimed.id, page.pageNumber),
    );
    newlyWrittenRenderPaths = [pdfPath, ...pagePaths];
    await storage.saveObjectEntityImmutable(pdfPath, sanitized.pdfBytes, "application/pdf");
    await heartbeat(true);
    await saveRenderedPages(sanitized.pages, pagePaths, heartbeat);
    const hash = createHash("sha256").update(sanitized.pdfBytes).digest("hex");
    const committed = await updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
      status: "ready_for_approval",
      analysis: analysis.pages,
      detectedManufacturer:
        detectedProfile === "unknown" ? null : detectedProfile,
      pageCount: sanitized.pages.length,
      sanitizedPdfObjectPath: pdfPath,
      sanitizedPdfSha256: hash,
      sanitizedPageObjectPaths: pagePaths,
      processingStartedAt: null,
      failureMessage: null,
    });
    if (!committed) {
      await cleanupUncommittedRenderObjects(
        claimed.id,
        newlyWrittenRenderPaths,
      );
    }
  } catch (error) {
    try {
      await updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
        status: "failed",
        processingStartedAt: null,
        failureMessage: cleanError(error),
      });
    } catch (updateError) {
      logger.error(
        { err: updateError, packetId: claimed.id },
        "Packet processing failure could not be persisted",
      );
    }
    // Storage writes can succeed even when their client call throws, and a
    // later failed-state update can commit without referencing those paths.
    // Always verify every allocated render path on a failed processing exit.
    await cleanupUncommittedRenderObjects(
      claimed.id,
      newlyWrittenRenderPaths,
    );
  }
}

export function kickPacketProcessing(packetId: number) {
  pendingPacketJobs.add(packetId);
  drainPacketQueue();
}

function schedulePacketQueueRetry() {
  if (packetRetryTimer) return;
  packetRetryTimer = setTimeout(() => {
    packetRetryTimer = undefined;
    drainPacketQueue();
  }, PACKET_SLOT_RETRY_MS);
  packetRetryTimer.unref();
}

function drainPacketQueue() {
  // Bound local acquisition attempts so a replica cannot consume the DB pool
  // while competing for the shared advisory-lock slots. The global locks
  // remain the authoritative cross-replica worker cap.
  const localAttemptLimit = Math.min(globalPacketWorkerSlotCount(), 2);
  while (
    pendingPacketJobs.size > 0 &&
    activeLocalPacketJobs < localAttemptLimit
  ) {
    const packetId = pendingPacketJobs.values().next().value as number;
    pendingPacketJobs.delete(packetId);
    activeLocalPacketJobs += 1;
    void processPacket(packetId)
      .then((outcome) => {
        activeLocalPacketJobs -= 1;
        // A contended attempt already scheduled a bounded retry. Draining
        // immediately here would spin against another replica's held slots.
        if (outcome === "processed") drainPacketQueue();
      })
      .catch((error: unknown) => {
        activeLocalPacketJobs -= 1;
        recordOperationalFailure("packet_recovery");
        logger.error({ err: error, packetId }, "Packet job claim failed");
        pendingPacketJobs.add(packetId);
        schedulePacketQueueRetry();
      });
  }
}

/** Requeue durable work after a process crash without ever touching archives. */
export async function recoverPacketJobs(now = Date.now()): Promise<void> {
  let cursor = recoveryScanCursor;
  let scanned = 0;
  let queued = 0;
  let failed = 0;
  let skipped = 0;

  // Use a stable id cursor rather than an unordered LIMIT. A bounded number
  // of pages keeps a large backlog from monopolizing the API process while
  // ensuring stale rows are eventually considered behind queued rows.
  for (let page = 0; page < RECOVERY_MAX_PAGES; page += 1) {
    const candidates = await db
      .select({ id: manufacturerPacketsTable.id })
      .from(manufacturerPacketsTable)
      .innerJoin(
        quotesTable,
        eq(manufacturerPacketsTable.quoteId, quotesTable.id),
      )
      .where(
        and(
          gt(manufacturerPacketsTable.id, cursor),
          inArray(manufacturerPacketsTable.status, ["queued", "processing"]),
          isNull(quotesTable.archivedAt),
        ),
      )
      .orderBy(asc(manufacturerPacketsTable.id))
      .limit(RECOVERY_PAGE_SIZE);
    if (candidates.length === 0) {
      recoveryScanCursor = 0;
      break;
    }

    for (const candidate of candidates) {
      cursor = candidate.id;
      scanned += 1;
      const outcome = await db.transaction(async (tx) => {
        const [identity] = await tx
          .select({ quoteId: manufacturerPacketsTable.quoteId })
          .from(manufacturerPacketsTable)
          .where(eq(manufacturerPacketsTable.id, candidate.id));
        if (!identity) return { kind: "skip" as const };
        const [quote] = await tx
          .select({ archivedAt: quotesTable.archivedAt })
          .from(quotesTable)
          .where(eq(quotesTable.id, identity.quoteId))
          .for("update");
        if (!quote || quote.archivedAt) return { kind: "skip" as const };
        const [packet] = await tx
          .select()
          .from(manufacturerPacketsTable)
          .where(
            and(
              eq(manufacturerPacketsTable.id, candidate.id),
              eq(manufacturerPacketsTable.quoteId, identity.quoteId),
            ),
          )
          .for("update");
        if (!packet) return { kind: "skip" as const };
        const action = recoveryAction(
          packet,
          false,
          MAX_PROCESSING_ATTEMPTS,
          now,
        );
        if (action === "skip") return { kind: "skip" as const };
        if (action === "queue" && packet.status === "queued") {
          return { kind: "queue", id: packet.id } as const;
        }
        if (action === "fail") {
          await tx
            .update(manufacturerPacketsTable)
            .set({
              status: "failed",
              processingStartedAt: null,
              processingAttemptToken: null,
              failureMessage: "Processing retry limit reached. Upload a new packet.",
            })
            .where(eq(manufacturerPacketsTable.id, packet.id));
          return { kind: "failed" as const };
        }
        const [requeued] = await tx
          .update(manufacturerPacketsTable)
          .set({
            status: "queued",
            processingStartedAt: null,
            processingAttemptToken: null,
            failureMessage: null,
          })
          .where(
            and(
              eq(manufacturerPacketsTable.id, packet.id),
              eq(manufacturerPacketsTable.processingAttemptToken, packet.processingAttemptToken!),
            ),
          )
          .returning({ id: manufacturerPacketsTable.id });
        return requeued
          ? ({ kind: "queue", id: requeued.id } as const)
          : ({ kind: "skip" } as const);
      }).catch((error: unknown) => {
        recordOperationalFailure("packet_recovery");
        logger.error(
          { err: error, packetId: candidate.id },
          "Packet recovery candidate failed; continuing bounded scan",
        );
        return { kind: "error" as const };
      });
      if (outcome.kind === "queue") {
        queued += 1;
        kickPacketProcessing(outcome.id);
      } else if (outcome.kind === "failed") {
        failed += 1;
      } else {
        skipped += 1;
      }
    }

    recoveryScanCursor = nextRecoveryScanCursor(
      cursor,
      candidates.length,
      RECOVERY_PAGE_SIZE,
    );
    if (recoveryScanCursor === 0) {
      break;
    }
  }

  logger.info(
    { scanned, queued, failed, skipped, pageSize: RECOVERY_PAGE_SIZE, maxPages: RECOVERY_MAX_PAGES },
    "Packet job recovery scan completed",
  );
}

let recoveryTimer: NodeJS.Timeout | undefined;

export function startPacketJobRecovery(): void {
  if (recoveryTimer) return;
  const recover = () =>
    recoverPacketJobs().catch((error: unknown) => {
      recordOperationalFailure("packet_recovery");
      logger.error({ err: error }, "Packet job recovery scan failed");
    });
  recover();
  recoveryTimer = setInterval(recover, 60_000);
  recoveryTimer.unref();
}

export async function queuePacketRetryForQuote(quoteId: number, packetId: number) {
  const result = await db.transaction(async (tx) => {
    const [quote] = await tx
      .select({ archivedAt: quotesTable.archivedAt })
      .from(quotesTable)
      .where(eq(quotesTable.id, quoteId))
      .for("update");
    if (!quote) return { kind: "notFound" as const };
    if (quote.archivedAt) return { kind: "archived" as const };
    const [packet] = await tx
      .select()
      .from(manufacturerPacketsTable)
      .where(
        and(
          eq(manufacturerPacketsTable.id, packetId),
          eq(manufacturerPacketsTable.quoteId, quoteId),
        ),
      )
      .for("update");
    if (!packet) return { kind: "notFound" as const };
    const isAbandoned = isAbandonedProcessingJob(packet);
    if (
      !(packet.status === "failed" || packet.status === "queued" || isAbandoned) ||
      packet.attemptCount >= MAX_PROCESSING_ATTEMPTS
    ) {
      return { kind: "notRetryable" as const };
    }
    const [updated] = await tx
      .update(manufacturerPacketsTable)
      .set({ status: "queued", processingStartedAt: null, failureMessage: null })
      .where(eq(manufacturerPacketsTable.id, packet.id))
      .returning();
    return { kind: "ok" as const, packet: updated! };
  });
  if (result.kind === "ok") kickPacketProcessing(result.packet.id);
  return result;
}