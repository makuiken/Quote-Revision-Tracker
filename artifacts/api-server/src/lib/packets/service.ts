import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  manufacturerPacketManifestTable,
  manufacturerPacketsTable,
  quotesTable,
  type ManufacturerPacket,
} from "@workspace/db";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import { packetEngine } from "./engine";
import {
  isAbandonedProcessingJob,
  recoveryAction,
} from "./recovery";
import type { PacketPageAnalysis, RedactionRect } from "./types";

const storage = new ObjectStorageService();
const MAX_PROCESSING_ATTEMPTS = 3;
const MAX_PACKET_BYTES = 40 * 1024 * 1024;
const MAX_CONCURRENT_PACKET_JOBS = 2;
const RECOVERY_BATCH_SIZE = 50;
const pendingPacketJobs = new Set<number>();
let activePacketJobs = 0;

export { isAbandonedProcessingJob } from "./recovery";

export function serializePacket(packet: ManufacturerPacket) {
  return {
    id: packet.id,
    quoteId: packet.quoteId,
    manufacturer: packet.manufacturer,
    detectedManufacturer: packet.detectedManufacturer,
    originalName: packet.originalName,
    status: packet.status,
    pageCount: packet.pageCount,
    analysis: packet.analysis,
    manualRedactions: packet.manualRedactions,
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

/**
 * Claim then process one durable job. Calling this without awaiting is safe:
 * the DB transition to processing is persisted first and retry can recover an
 * instance that exits mid-render.
 */
export async function processPacket(packetId: number): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    const [packet] = await tx
      .select()
      .from(manufacturerPacketsTable)
      .where(eq(manufacturerPacketsTable.id, packetId))
      .for("update");
    if (!packet || packet.status !== "queued") return null;
    const [quote] = await tx
      .select({ archivedAt: quotesTable.archivedAt })
      .from(quotesTable)
      .where(eq(quotesTable.id, packet.quoteId))
      .for("update");
    if (!quote || quote.archivedAt) return null;
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

    const analysis = await packetEngine.analyzePdf(source, claimed.manufacturer);
    if (!validAnalysis(analysis.pages)) {
      throw new Error("PDF analysis returned invalid or unsupported page geometry.");
    }

    // A null value means the reviewer has not explicitly accepted/changed the
    // suggestions. Never sanitize or publish based on automatic suggestions.
    // packetEngine's compatibility interface is intersected with its legacy
    // type in the currently published declaration; the worker adapter returns
    // this profile alongside pages at runtime.
    const detectedProfile = (
      analysis as typeof analysis & { profile: string }
    ).profile;
    if (claimed.manualRedactions === null) {
      await db
        .update(manufacturerPacketsTable)
        .set({
          status: "needs_review",
          analysis: analysis.pages,
          detectedManufacturer:
            detectedProfile === "unknown" ? null : detectedProfile,
          pageCount: analysis.pages.length,
          processingStartedAt: null,
        })
        .where(
          and(
            eq(manufacturerPacketsTable.id, claimed.id),
            eq(manufacturerPacketsTable.status, "processing"),
            eq(
              manufacturerPacketsTable.processingAttemptToken,
              attemptToken,
            ),
          ),
        );
      return;
    }

    const manual = claimed.manualRedactions as Record<string, RedactionRect[]>;
    const redactionsByPage = Object.fromEntries(
      Object.entries(manual).map(([page, rectangles]) => [Number(page), rectangles]),
    );
    const sanitized = await packetEngine.generateSanitizedPacket({
      bytes: source,
      // Prefer the explicit manufacturer but pass a bounded deterministic
      // detection result through to the engine when the upload did not name it.
      manufacturer:
        claimed.manufacturer ??
        (detectedProfile === "unknown" ? null : detectedProfile),
      redactionsByPage,
    });
    if (
      sanitized.pages.length !== analysis.pages.length ||
      sanitized.pages.some((page, index) => page.pageNumber !== index + 1 || !page.pngBytes.length) ||
      !sanitized.pdfBytes.length
    ) {
      throw new Error("PDF sanitization returned incomplete page output.");
    }

    const pdfPath = renderedPdfPath(claimed.quoteId, claimed.id);
    const pagePaths = sanitized.pages.map((page) =>
      renderedPagePath(claimed.quoteId, claimed.id, page.pageNumber),
    );
    await storage.saveObjectEntityImmutable(pdfPath, sanitized.pdfBytes, "application/pdf");
    await Promise.all(
      sanitized.pages.map((page, index) =>
        storage.saveObjectEntityImmutable(pagePaths[index]!, page.pngBytes, "image/png"),
      ),
    );
    const hash = createHash("sha256").update(sanitized.pdfBytes).digest("hex");
    await db
      .update(manufacturerPacketsTable)
      .set({
        status: "ready_for_approval",
        analysis: analysis.pages,
          detectedManufacturer:
            detectedProfile === "unknown" ? null : detectedProfile,
        pageCount: sanitized.pages.length,
        sanitizedPdfObjectPath: pdfPath,
        sanitizedPdfSha256: hash,
        sanitizedPageObjectPaths: pagePaths,
        processingStartedAt: null,
      })
      .where(
        and(
          eq(manufacturerPacketsTable.id, claimed.id),
          eq(manufacturerPacketsTable.status, "processing"),
            eq(
              manufacturerPacketsTable.processingAttemptToken,
              attemptToken,
            ),
        ),
      );
  } catch (error) {
    await db
      .update(manufacturerPacketsTable)
      .set({
        status: "failed",
        processingStartedAt: null,
        failureMessage: cleanError(error),
      })
      .where(
        and(
          eq(manufacturerPacketsTable.id, claimed.id),
          eq(manufacturerPacketsTable.status, "processing"),
          eq(
            manufacturerPacketsTable.processingAttemptToken,
            attemptToken,
          ),
        ),
      );
  }
}

export function kickPacketProcessing(packetId: number) {
  pendingPacketJobs.add(packetId);
  drainPacketQueue();
}

function drainPacketQueue() {
  while (
    activePacketJobs < MAX_CONCURRENT_PACKET_JOBS &&
    pendingPacketJobs.size > 0
  ) {
    const packetId = pendingPacketJobs.values().next().value as number;
    pendingPacketJobs.delete(packetId);
    activePacketJobs += 1;
    void processPacket(packetId)
      .catch((error: unknown) => {
        // Do not produce an unhandled rejection. The row remains queued if the
        // claim itself failed, so its explicit bounded retry path can recover.
        logger.error({ err: error, packetId }, "Packet job claim failed");
      })
      .finally(() => {
        activePacketJobs -= 1;
        drainPacketQueue();
      });
  }
}

/** Requeue durable work after a process crash without ever touching archives. */
export async function recoverPacketJobs(now = Date.now()): Promise<void> {
  const candidates = await db
    .select({ id: manufacturerPacketsTable.id })
    .from(manufacturerPacketsTable)
    .where(inArray(manufacturerPacketsTable.status, ["queued", "processing"]))
    .limit(RECOVERY_BATCH_SIZE);
  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx) => {
      const [packet] = await tx
        .select()
        .from(manufacturerPacketsTable)
        .where(eq(manufacturerPacketsTable.id, candidate.id))
        .for("update");
      if (!packet) return null;
      const [quote] = await tx
        .select({ archivedAt: quotesTable.archivedAt })
        .from(quotesTable)
        .where(eq(quotesTable.id, packet.quoteId))
        .for("update");
      if (!quote || quote.archivedAt) return null;
      const action = recoveryAction(
        packet,
        false,
        MAX_PROCESSING_ATTEMPTS,
        now,
      );
      if (action === "skip") return null;
      if (action === "queue" && packet.status === "queued") return packet.id;
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
        return null;
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
      return requeued?.id ?? null;
    });
    if (outcome) kickPacketProcessing(outcome);
  }
}

let recoveryTimer: NodeJS.Timeout | undefined;

export function startPacketJobRecovery(): void {
  if (recoveryTimer) return;
  const recover = () =>
    recoverPacketJobs().catch((error: unknown) =>
      logger.error({ err: error }, "Packet job recovery scan failed"),
    );
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