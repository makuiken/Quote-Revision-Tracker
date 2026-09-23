import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
import { packetEngine, mergePacketPdfFilesInWorker, withPacketSanitizationSession } from "./engine";
import { admitPageOverlap, LocalCheckpointStage, runPagePipeline, settleUploads } from "./pipeline";
import {
  analysisFingerprint, assertCompleteCheckpoints, assertDocumentBudget,
  commitCheckpointBatch, completedCheckpointPages, MAX_CHECKPOINT_BYTES,
  readProcessingState, renderFingerprint, resumeRender,
  boundedReusablePages, pageFingerprint, selectReusablePages, loadReusablePage,
  type PacketProcessingState, type ReusablePage,
} from "./checkpoints";
import {
  isAbandonedProcessingJob,
  nextRecoveryScanCursor,
  refreshProcessingLease,
  recoveryAction,
} from "./recovery";
import { PACKET_WORKER_LOCK_BASE, tryAcquirePacketWorkerSlot } from "./packetCapacity";
import type { PacketPageAnalysis, RedactionRect } from "./types";
import {
  canonicalManufacturer,
  matchingTemplateRedactions,
  templateLayoutMismatchFeedback,
  templateNoActiveMatchFeedback,
} from "./templates";
import { pdfCapacityConfiguration } from "./capacity";
import { PacketWorkerError, PacketWorkerQueueWaitError, PacketWorkerTimeoutError } from "./workerClient";
import {
  assertCheckpointPublication, registerCheckpointManifest, registerCheckpointPaths,
  sweepCheckpointObjects,
} from "./checkpointCleanup";

const storage = new ObjectStorageService();
const MAX_PROCESSING_ATTEMPTS = 3;
const MAX_PACKET_BYTES = 40 * 1024 * 1024;
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
  const slotCount = globalPacketWorkerSlotCount();
  try {
    return await tryAcquirePacketWorkerSlot(
      pool,
      PACKET_WORKER_LOCK_BASE,
      slotCount,
    );
  } catch (error) {
    recordOperationalFailure("packet_processing");
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
    processingProgress: readProcessingState(packet.processingState)?.progress ?? {
      stage: packet.status === "processing" ? "analysis" : packet.status,
      completedPages: 0,
      totalPages: packet.pageCount ?? 0,
      ...(packet.status === "failed" ? { errorStage: "unknown" } : {}),
    },
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

function cleanError(error: unknown, sourcePage?: number) {
  if (error instanceof PacketWorkerQueueWaitError) {
    return "PDF processing could not start before the worker queue wait limit. Retry to resume saved progress.";
  }
  if (error instanceof PacketWorkerTimeoutError) {
    return `PDF processing timed out${sourcePage === undefined ? "" : ` on source page ${sourcePage}`}. Retry to resume saved progress.`;
  }
  if (error instanceof PacketWorkerError) {
    return error.code === "ERR_WORKER_OUT_OF_MEMORY"
      ? "PDF processing exceeded its memory limit. Saved progress is retained for retry."
      : `PDF processing worker failed: ${error.message}`;
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
      .select({ id: manufacturerPacketsTable.id, processingState: manufacturerPacketsTable.processingState })
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
    // A write may commit even if its acknowledgement is lost. Failure updates
    // preserve the actual durable checkpoint rather than a stale local copy.
    if (values.status === "failed") {
      const durableState = readProcessingState(packet.processingState);
      const reportedState = readProcessingState(values.processingState);
      values = { ...values, processingState: durableState ? {
        ...durableState, progress: {
          ...durableState.progress, stage: "failed",
          errorStage: reportedState?.progress.errorStage ?? durableState.progress.stage,
        },
      } : null };
    }
    if ("processingState" in values) {
      await registerCheckpointManifest(tx, packet, values.processingState);
      await assertCheckpointPublication(tx, packetId, attemptToken, packet.processingState, values.processingState);
    }
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
            sql`${manufacturerPacketsTable.processingState}->'batches' @> ${JSON.stringify([{ pdfPath: path }])}::jsonb`,
            sql`${manufacturerPacketsTable.processingState}->'batches' @> ${JSON.stringify([{ pagePaths: [path] }])}::jsonb`,
            sql`${manufacturerPacketsTable.processingState}->'reusablePages' @> ${JSON.stringify([{ pdfPath: path }])}::jsonb`,
            sql`${manufacturerPacketsTable.processingState}->'reusablePages' @> ${JSON.stringify([{ pagePaths: [path] }])}::jsonb`,
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
  scheduleOnContention = true,
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
    if (scheduleOnContention) {
      pendingPacketJobs.add(packetId);
      schedulePacketQueueRetry();
    }
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
    await refreshProcessingLease(
      updateProcessingPacketWithRetry,
      claimed.quoteId,
      claimed.id,
      attemptToken,
      {
        status: "processing",
        processingStartedAt: new Date(now),
      },
    );
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
      clearInterval(timer);
      await heartbeatChain;
      if (heartbeatFailure) throw heartbeatFailure;
      return result;
    } finally {
      clearInterval(timer);
      // The chain records heartbeat errors instead of rejecting, so settling
      // it cannot replace the original operation error on the failure path.
      await heartbeatChain;
    }
  };
  let newlyWrittenRenderPaths: string[] = [];
  let processingState: PacketProcessingState | null = null;
  let processingStage = "source_download";
  let activeSourcePage: number | undefined;
  let sessionFailure: { stage: string; sourcePage?: number } | undefined;
  let renderSnapshot: { stage: string; sourcePage?: number } = { stage: "worker_queue" };
  let persistenceFailure: { error: unknown; stage: string; sourcePage?: number } | undefined;
  const localCheckpoints = new LocalCheckpointStage(MAX_CHECKPOINT_BYTES);
  const persistState = async (): Promise<void> => {
    const committed = await updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
      processingState,
      processingStartedAt: new Date(),
    });
    if (!committed) throw new Error("Packet processing lease was superseded.");
  };
  const stageStartedAt = Date.now();
  const stageTimings: Record<string, number> = {};
  let previousStageAt = stageStartedAt;
  const finishStage = (stage: string): void => {
    const now = Date.now();
    stageTimings[stage] = now - previousStageAt;
    previousStageAt = now;
  };
  const timed = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      stageTimings[name] = (stageTimings[name] ?? 0) + Date.now() - startedAt;
    }
  };

  try {
    processingStage = "source_download";
    const source = await storage.downloadObjectBytesBounded(
      claimed.sourceObjectPath,
      MAX_PACKET_BYTES,
    );
    finishStage("sourceDownloadMs");
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

    const analysisKey = analysisFingerprint(source, claimed.manufacturer);
    const previousState = readProcessingState(claimed.processingState);
    const cachedAnalysis = previousState?.analysisKey === analysisKey
      ? previousState.analysis : null;
    processingStage = "analysis";
    const analysis = cachedAnalysis ?? await withHeartbeats(() =>
      packetEngine.analyzePdf(source, claimed.manufacturer),
    );
    finishStage("analysisMs");
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
    processingState = cachedAnalysis ? previousState! : {
      version: 1, analysisKey, analysis: { pages: analysis.pages, profile: detectedProfile },
      renderKey: null, batches: [],
      progress: { stage: "analysis", completedPages: 0, totalPages: analysis.pages.length },
    };
    await persistState();
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
        processingState: {
          ...processingState,
          progress: { stage: "needs_review", completedPages: 0, totalPages: analysis.pages.length },
        },
        processingStartedAt: null,
      });
      logger.info(
        {
          packetId: claimed.id,
          pageCount: analysis.pages.length,
          totalMs: Date.now() - stageStartedAt,
          stages: stageTimings,
        },
        "Packet analysis stage timings",
      );
      return;
    }

    const manual = claimed.manualRedactions as Record<string, RedactionRect[]>;
    const redactionsByPage = Object.fromEntries(
      Object.entries(manual).map(([page, rectangles]) => [Number(page), rectangles]),
    );
    const redactionCount = Object.values(redactionsByPage).reduce(
      (count, rectangles) => count + rectangles.length,
      0,
    );
    // Enforce the original document-wide limits before splitting the work. A
    // small batch must never become a way around the raster/output budget.
    assertDocumentBudget(analysis.pages);
    processingState = resumeRender(processingState, renderFingerprint(analysisKey, manual));
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const pageKeys = analysis.pages.map((page) =>
      pageFingerprint(sourceSha256, page, redactionsByPage[page.pageNumber] ?? []));
    const verified = new Map<number, ReusablePage>();
    // Candidates remain durable references throughout I/O. A sweeper cannot
    // retire them between verification and ordered acknowledgement.
    await withHeartbeats(async () => {
      const candidates = selectReusablePages(processingState!, claimed.quoteId, claimed.id, pageKeys);
      for (const page of candidates) {
        const index = page.pageNumbers[0]! - 1;
        try {
          const pdf = await loadReusablePage(page, (path, limit) => storage.downloadObjectBytesBounded(path, limit));
          await localCheckpoints.put(page, pdf);
          verified.set(index, page);
        } catch (error) {
          logger.warn({ err: error, packetId: claimed.id, sourcePage: index + 1 },
            "Cached page unavailable or invalid; regenerating page");
        }
      }
    });
    // Legacy or unverified prefixes are not trusted. Rebuild a contiguous
    // acknowledged prefix from verified candidates and freshly rendered pages.
    processingState = { ...processingState, batches: [], reusablePages: [...verified.values()] };
    processingStage = "rendering";
    let completed = completedCheckpointPages(processingState);
    let reusedPages = 0;
    let renderedPages = 0;
    processingState.progress = { stage: processingStage, completedPages: completed, totalPages: analysis.pages.length,
      reusedPages, renderedPages };
    await persistState();
    const sanitizeStartedAt = Date.now();
    logger.info({ packetId: claimed.id, completedPages: completed, totalPages: analysis.pages.length,
      remainingPages: analysis.pages.length - completed }, "Packet render session starting");
    // The session holds the worker queue only for unfinished pages. Final merge
    // must run after it closes, since merge acquires that same queue.
    processingStage = "worker_queue";
    const processPages = async (session?: { generateBatch: (pages: number[]) => Promise<import("./types").SanitizedPacket> }) => {
    await runPagePipeline({
      start: completed,
      end: analysis.pages.length,
      render: async (index) => {
        const reused = verified.get(index);
        if (reused) return { reused, sanitized: undefined, renderStartedAt: Date.now(), workerMs: 0 };
        if (!session) throw new Error("Missing renderer for changed page.");
        renderSnapshot = { stage: "rendering", sourcePage: analysis.pages[index]!.pageNumber };
        const renderStartedAt = Date.now();
        const sanitized = await timed("batchWorkerMs", () => session.generateBatch([analysis.pages[index]!.pageNumber]));
        return { reused: undefined, sanitized, renderStartedAt, workerMs: Date.now() - renderStartedAt };
      },
      admit: ({ sanitized }, index) => {
        if (!sanitized) return false;
        const pixels = (page: PacketPageAnalysis) =>
          Math.ceil(page.width * 160 / 72) * Math.ceil(page.height * 160 / 72);
        return admitPageOverlap({
          currentPixels: pixels(analysis.pages[index]!),
          nextPixels: pixels(analysis.pages[index + 1]!),
          retainedBytes: sanitized.pdfBytes.length + sanitized.pages.reduce((sum, page) => sum + page.pngBytes.length, 0),
          rss: process.memoryUsage().rss,
        });
      },
      persist: async ({ reused, sanitized, renderStartedAt, workerMs }, index) => {
      try {
      if (reused) {
        const nextState: PacketProcessingState = {
          ...processingState!,
          batches: [...processingState!.batches, reused],
          progress: { stage: "rendering", completedPages: completed + 1,
            totalPages: analysis.pages.length, reusedPages: reusedPages + 1, renderedPages },
        };
        processingState = await commitCheckpointBatch(nextState, async () => {}, (state) =>
          updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
            processingState: state, processingStartedAt: new Date(),
          }));
        completed++;
        reusedPages++;
        return;
      }
      if (!sanitized) throw new Error("Missing sanitized page.");
      // One-page commits are valid under the existing two-page maximum and
      // preserve each finished page before a later slow page can time out.
      const pageOrder = [analysis.pages[index]!.pageNumber];
      activeSourcePage = pageOrder[0];
      processingStage = "rendering";
      const timingsBeforeBatch = { ...stageTimings };
      if (sanitized.pages.length !== pageOrder.length ||
          sanitized.pages.some((page, index) => page.pageNumber !== index + 1 || !page.pngBytes.length) ||
          !sanitized.pdfBytes.length) {
        throw new Error("PDF sanitization returned incomplete batch output.");
      }
      const pdfPath = renderedPdfPath(claimed.quoteId, claimed.id);
      // Engine pageNumber is local output order, not the source page identity.
      const pagePaths = pageOrder.map((pageNumber) => renderedPagePath(claimed.quoteId, claimed.id, pageNumber));
      const checkpoint: ReusablePage = {
          pageNumbers: pageOrder, pdfPath, pagePaths,
          reuseVersion: 1, pageKey: pageKeys[index]!,
          pngSha256: createHash("sha256").update(sanitized.pages[0]!.pngBytes).digest("hex"),
          pdfSha256: createHash("sha256").update(sanitized.pdfBytes).digest("hex"),
          pdfBytes: sanitized.pdfBytes.length,
          pngBytes: sanitized.pages.reduce((sum, page) => sum + page.pngBytes.length, 0),
      };
      const nextState: PacketProcessingState = {
        ...processingState!,
        batches: [...processingState!.batches, checkpoint],
        reusablePages: boundedReusablePages([...(processingState!.reusablePages ?? []), checkpoint]),
        progress: { stage: "rendering", completedPages: completed + pageOrder.length, totalPages: analysis.pages.length,
          reusedPages, renderedPages: renderedPages + 1 },
      };
      // Registration must acknowledge before any storage write. If registration
      // commits but its acknowledgement is lost, no upload occurs and the
      // retained candidate is harmless. Checkpoint cleanup is always durable.
      processingStage = "checkpoint_registration";
      await timed("batchRegistrationMs", () =>
        registerCheckpointPaths(db, claimed.id, attemptToken, [pdfPath, ...pagePaths]));
      newlyWrittenRenderPaths = [];
      // Keep the prior durable state if this commit fails. Failure reporting
      // must not accidentally reference partially persisted output.
      processingStage = "storage";
      processingState = await commitCheckpointBatch(nextState,
        () => timed("batchStorageMs", async () => {
          await settleUploads([
            () => storage.saveObjectEntityImmutable(pdfPath, sanitized.pdfBytes, "application/pdf"),
            ...sanitized.pages.map((page, index) => () =>
              storage.saveObjectEntityImmutable(pagePaths[index]!, page.pngBytes, "image/png")),
          ]);
          await heartbeat();
        }),
        (state) => {
          processingStage = "checkpoint_commit";
          return timed("batchCommitMs", () =>
            updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
              processingState: state, processingStartedAt: new Date(),
            }));
        },
      );
      newlyWrittenRenderPaths = [];
      completed += pageOrder.length;
      renderedPages++;
      try {
        await localCheckpoints.put(nextState.batches[nextState.batches.length - 1]!, sanitized.pdfBytes);
      } catch (error) {
        // Only operational disk failures may bypass this optimization. The
        // checkpoint is already durable; final merge can redownload and retry
        // staging. Integrity/budget errors remain explicit hard failures.
        if (!(error as NodeJS.ErrnoException).code) throw error;
        logger.warn({ err: error, packetId: claimed.id, sourcePage: activeSourcePage },
          "Local checkpoint staging failed; final merge will download the durable checkpoint");
      }
      logger.info({ packetId: claimed.id, sourcePage: activeSourcePage, completedPages: completed,
        totalPages: analysis.pages.length, batchMs: Date.now() - renderStartedAt,
        timings: { batchWorkerMs: workerMs, ...Object.fromEntries(
          ["batchRegistrationMs", "batchStorageMs", "batchCommitMs"]
            .map((key) => [key, (stageTimings[key] ?? 0) - (timingsBeforeBatch[key] ?? 0)])) },
      }, "Packet page checkpoint committed");
      activeSourcePage = undefined;
      } catch (error) {
        persistenceFailure = { error, stage: processingStage, sourcePage: activeSourcePage };
        throw error;
      }
      },
    });
    };
    // No-op jobs never acquire a raster session; merge remains a separate
    // bounded worker operation producing a fresh immutable complete PDF.
    if (verified.size === analysis.pages.length) await withHeartbeats(() => processPages());
    else await withHeartbeats(() => withPacketSanitizationSession({
      bytes: source, redactionsByPage,
      pageDimensions: analysis.pages.map(({ pageNumber, width, height }) => ({ pageNumber, width, height })),
    }, processPages, {
      onProgress(progress) {
        if (progress.phase !== "idle") {
          renderSnapshot = { stage: `render_${progress.phase}`,
            sourcePage: progress.pageNumber ?? renderSnapshot.sourcePage };
        }
        logger.info({ packetId: claimed.id, phase: progress.phase, sourcePage: progress.pageNumber,
          elapsedMs: progress.elapsedMs, workerRss: progress.rss, completedPages: completed,
          totalPages: analysis.pages.length }, "Packet render worker progress");
      },
      onFailure(error, progress) {
        // Capture diagnostics immediately, but do not publish a failed state
        // until the session awaits any in-flight storage/fenced commit.
        sessionFailure = {
          stage: error instanceof PacketWorkerQueueWaitError ? "worker_queue"
            : persistenceFailure?.error === error ? persistenceFailure.stage : renderSnapshot.stage,
          sourcePage: persistenceFailure?.error === error ? persistenceFailure.sourcePage : renderSnapshot.sourcePage,
        };
        logger.warn({ packetId: claimed.id, stage: sessionFailure.stage,
          sourcePage: sessionFailure.sourcePage, workerPhase: progress?.phase,
          completedPages: completed }, "Packet render session failed; awaiting durable checkpoint settlement");
      },
    }));
    stageTimings.sanitizeMs = Date.now() - sanitizeStartedAt;
    previousStageAt = Date.now();
    assertCompleteCheckpoints(processingState);
    processingStage = "finalizing";
    processingState.progress = { stage: processingStage, completedPages: completed, totalPages: analysis.pages.length,
      reusedPages, renderedPages };
    await persistState();
    const pdfPath = renderedPdfPath(claimed.quoteId, claimed.id);
    const pagePaths = processingState.batches.flatMap((batch) => batch.pagePaths);
    const batches = processingState.batches;
    newlyWrittenRenderPaths = [pdfPath];
    const hash = await withHeartbeats(async () => {
      try {
        const inputPaths: string[] = [];
        // Only one compressed batch buffer is live during staging, never all
        // packet pixels. Hash-check immutable checkpoints before final merge.
        for (const batch of batches) {
          inputPaths.push(await localCheckpoints.resolve(batch, () =>
            storage.downloadObjectBytesBounded(batch.pdfPath, Math.min(batch.pdfBytes, MAX_CHECKPOINT_BYTES))));
        }
        const outputPath = await localCheckpoints.outputPath();
        const expectedBatchPageGeometry = batches.map((batch) =>
          batch.pageNumbers.map((pageNumber) => {
            const page = analysis.pages[pageNumber - 1]!;
            return { width: page.width, height: page.height };
          }));
        processingStage = "final_merge";
        await timed("finalMergeWorkerMs", () =>
          mergePacketPdfFilesInWorker(inputPaths, outputPath, expectedBatchPageGeometry));
        if ((await stat(outputPath)).size > MAX_CHECKPOINT_BYTES) throw new Error("Merged packet exceeds the output limit.");
        const bytes = await readFile(outputPath);
        if (!bytes.length) throw new Error("Merged packet is empty.");
        processingStage = "storage";
        await timed("finalStorageMs", () => storage.saveObjectEntityImmutable(pdfPath, bytes, "application/pdf"));
        return createHash("sha256").update(bytes).digest("hex");
      } finally {
        await localCheckpoints.close();
      }
    });
    finishStage("finalizeMs");
    processingStage = "final_commit";
    const committed = await timed("finalCommitMs", () => updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
      status: "ready_for_approval",
      analysis: analysis.pages,
      detectedManufacturer:
        detectedProfile === "unknown" ? null : detectedProfile,
      pageCount: analysis.pages.length,
      sanitizedPdfObjectPath: pdfPath,
      sanitizedPdfSha256: hash,
      sanitizedPageObjectPaths: pagePaths,
      processingStartedAt: null,
      failureMessage: null,
      processingState: { ...processingState, batches: [], progress: {
        stage: "complete", completedPages: completed, totalPages: analysis.pages.length, reusedPages, renderedPages,
      } },
    }));
    if (!committed) {
      await cleanupUncommittedRenderObjects(
        claimed.id,
        newlyWrittenRenderPaths,
      );
    }
    logger.info(
      {
        packetId: claimed.id,
        pageCount: analysis.pages.length,
        redactedPageCount: Object.values(redactionsByPage).filter(
          (rectangles) => rectangles.length > 0,
        ).length,
        redactionCount,
        totalMs: Date.now() - stageStartedAt,
        stages: stageTimings,
      },
      "Packet processing stage timings",
    );
  } catch (error) {
    const failureStage = error instanceof PacketWorkerQueueWaitError
      ? "worker_queue" : sessionFailure?.stage ?? processingStage;
    const failureSourcePage = sessionFailure ? sessionFailure.sourcePage : activeSourcePage;
    let failureCompletedPages: number | null = null;
    try {
      failureCompletedPages = processingState ? completedCheckpointPages(processingState) : 0;
    } catch {
      // Invalid checkpoint state may itself be the original failure. Diagnostics
      // must not rethrow validation and skip the fenced failure update/cleanup.
    }
    logger.error(
      {
        err: error,
        packetId: claimed.id,
        stage: failureStage,
        sourcePage: failureSourcePage,
        totalMs: Date.now() - stageStartedAt,
        unfinishedPhaseMs: Date.now() - previousStageAt,
        stages: stageTimings,
        completedPages: failureCompletedPages,
      },
      "Packet processing failed",
    );
    try {
      await updateProcessingPacketWithRetry(claimed.quoteId, claimed.id, attemptToken, {
        status: "failed",
        processingStartedAt: null,
        failureMessage: cleanError(error, failureSourcePage),
        ...(processingState ? { processingState: {
          ...processingState,
          progress: { ...processingState.progress, stage: "failed", errorStage: failureStage },
        } } : {}),
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
  } finally {
    await localCheckpoints.close();
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
export async function recoverPacketJobs(
  now = Date.now(),
  onQueued: (packetId: number) => void | Promise<void> = kickPacketProcessing,
  maxPages = RECOVERY_MAX_PAGES,
): Promise<void> {
  await sweepCheckpointObjects();
  let cursor = recoveryScanCursor;
  let scanned = 0;
  let queued = 0;
  let failed = 0;
  let skipped = 0;

  // Use a stable id cursor rather than an unordered LIMIT. A bounded number
  // of pages keeps a large backlog from monopolizing the API process while
  // ensuring stale rows are eventually considered behind queued rows.
  for (let page = 0; page < Math.min(maxPages, RECOVERY_MAX_PAGES); page += 1) {
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
        await onQueued(outcome.id);
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

/** For an authenticated scheduled caller: all dispatched work is awaited.
 * One bounded scan, one processed packet per invocation, no idle-wake claim.
 */
export async function recoverAndProcessPacketJobs(): Promise<void> {
  let dispatched = false;
  await recoverPacketJobs(Date.now(), async (packetId) => {
    if (dispatched) return;
    dispatched = true;
    await processPacket(packetId, false);
  }, 1);
}

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