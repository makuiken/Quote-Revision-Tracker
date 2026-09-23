import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import { Readable } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  manufacturerPacketManifestTable,
  manufacturerPacketsTable,
  manufacturerRedactionTemplatesTable,
  revisionsTable,
  scopedApprovalCoverageTable,
  scopedApprovalRequestsTable,
  signoffsTable,
  scopedApprovalsTable,
} from "@workspace/db";
import {
  ApproveManufacturerPacketParams,
  ApproveManufacturerPacketResponse,
  CompleteManufacturerPacketUploadParams,
  CompleteManufacturerPacketUploadResponse,
  GetManufacturerPacketPageParams,
  GetManufacturerPacketPageQueryParams,
  GetManufacturerPacketParams,
  GetManufacturerPacketResponse,
  GetSignedSignoffDocumentParams,
  GetScopedApprovalSignoffSnapshotParams,
  GetScopedApprovalSignoffSnapshotResponse,
  GetScopedApprovalPacketPageParams,
  GetUnsignedSignoffDocumentParams,
  ListManufacturerRedactionTemplateOptionsResponse,
  ListManufacturerPacketsParams,
  ListManufacturerPacketsResponse,
  GetManufacturerPacketManifestParams,
  GetManufacturerPacketManifestQueryParams,
  GetManufacturerPacketManifestResponse,
  SetManufacturerPacketManifestParams,
  SetManufacturerPacketManifestBody,
  SetManufacturerPacketManifestResponse,
  ClearManufacturerPacketManifestParams,
  DeleteManufacturerPacketParams,
  RequestManufacturerPacketUploadBody,
  RequestManufacturerPacketUploadParams,
  RequestManufacturerPacketUploadResponse,
  RetryManufacturerPacketParams,
  RetryManufacturerPacketResponse,
  SetManufacturerPacketRedactionsBody,
  SetManufacturerPacketRedactionsParams,
  SetManufacturerPacketRedactionsResponse,
  SetManufacturerPacketManufacturerParams,
  SetManufacturerPacketManufacturerBody,
  SetManufacturerPacketManufacturerResponse,
} from "@workspace/api-zod";
import {
  requireApproved,
  requireAuth,
  getUserProfile,
  type AuthedRequest,
} from "../middlewares/requireAuth";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { applyPrivateObjectHeaders } from "../lib/privateObjectHeaders";
import {
  getPacket,
  kickPacketProcessing,
  packetSourcePath,
  packetUploadPath,
  queuePacketRetryForQuote,
  serializePacket,
} from "../lib/packets/service";
import {
  computeDocumentVersion,
  ensureUnsignedDocumentCached,
  ensureLegacySignedDocumentSnapshot,
  lockQuoteRow,
  manifestFitsDocumentBudget,
  UnsignedDocumentBuildCapacityError,
} from "./quotes";
import { loadApprovedManifest } from "../lib/packets/service";
import {
  createBoundedWorkerQueue,
  PacketWorkerAbortedError,
  PacketWorkerQueueFullError,
  PacketWorkerTimeoutError,
  runPacketEngineInWorker,
} from "../lib/packets/workerClient";
import { PreviewSingleflight } from "../lib/packets/previewSingleflight";
import { withOptionalPacketPreview } from "../lib/packets/previewCapacity";
import { invalidateApprovalCoverage, invalidateLegacyApproval } from "../lib/scopedApprovals";
import { changedManifestProductTypes, manifestChanged } from "../lib/packets/manifestScope";
import {
  deduplicateTemplateOptions,
  expandTemplateOptions,
} from "../lib/packets/templates";
import { resetRenderCheckpoints } from "../lib/packets/checkpoints";
import { registerCheckpointManifest } from "../lib/packets/checkpointCleanup";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const originalPreviewJobs = new PreviewSingleflight<void>();
const originalPreviewAdmission = createBoundedWorkerQueue(1, 4);
const ORIGINAL_PREVIEW_HTTP_BUDGET_MS = 29_000;

router.use(requireAuth, requireApproved);

router.get("/manufacturer-redaction-template-options", async (_req, res): Promise<void> => {
  const templates = await db
    .select({
      manufacturer: manufacturerRedactionTemplatesTable.manufacturer,
      manufacturerCanonical: manufacturerRedactionTemplatesTable.manufacturerCanonical,
      eligibleProductTypes: manufacturerRedactionTemplatesTable.eligibleProductTypes,
    })
    .from(manufacturerRedactionTemplatesTable)
    .where(eq(manufacturerRedactionTemplatesTable.active, true))
    .orderBy(manufacturerRedactionTemplatesTable.manufacturer);
  const unique = deduplicateTemplateOptions(
    expandTemplateOptions(templates),
  ).map(({ manufacturer, productType }) => ({
    manufacturer,
    productType,
  }));
  res.json(ListManufacturerRedactionTemplateOptionsResponse.parse(unique));
});

function parseParams<T>(
  parser: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  res: Response,
): T | null {
  const parsed = parser.safeParse(value);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid route parameters." });
    return null;
  }
  return parsed.data;
}

async function loadLockedSignoffSnapshot(quoteId: number) {
  return db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, quoteId);
    if (!quote) return null;
    const revisions = await tx
      .select()
      .from(revisionsTable)
      .where(
        and(
          eq(revisionsTable.quoteId, quote.id),
          eq(revisionsTable.excludedFromSignoff, false),
        ),
      )
      .orderBy(revisionsTable.createdAt);
    const manifest = await loadApprovedManifest(tx, quote.id);
    return {
      manifest,
      version: computeDocumentVersion(quote, revisions, manifest),
    };
  });
}

async function streamPrivateObject(
  objectPath: string,
  res: Response,
): Promise<void> {
  const file = await storage.getObjectEntityFile(objectPath);
  const response = await storage.downloadObject(file, 0);
  res.status(response.status);
  applyPrivateObjectHeaders(response.headers, res);
  if (response.body) {
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
  } else {
    res.end();
  }
}

router.get("/quotes/:id/manufacturer-packets", async (req, res): Promise<void> => {
  const params = parseParams(ListManufacturerPacketsParams, req.params, res);
  if (!params) return;
  const packets = await db
    .select()
    .from(manufacturerPacketsTable)
    .where(eq(manufacturerPacketsTable.quoteId, params.id))
    .orderBy(manufacturerPacketsTable.createdAt);
  res.json(ListManufacturerPacketsResponse.parse(packets.map(serializePacket)));
});

router.patch(
  "/quotes/:id/manufacturer-packets/:packetId/product-type",
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const packetId = Number(req.params.packetId);
    const productType = (req.body as { productType?: unknown } | undefined)?.productType;
    if (!Number.isInteger(id) || !Number.isInteger(packetId) || typeof productType !== "string") {
      res.status(400).json({ error: "A valid productType is required." }); return;
    }
    const outcome = await db.transaction(async (tx) => {
      const quote = await lockQuoteRow(tx, id);
      if (!quote) return { kind: "notFound" as const };
      if (quote.archivedAt) return { kind: "archived" as const };
      if (!quote.categories.includes(productType)) return { kind: "invalid" as const };
      const [packet] = await tx.select().from(manufacturerPacketsTable).where(
        and(eq(manufacturerPacketsTable.id, packetId), eq(manufacturerPacketsTable.quoteId, id)),
      ).for("update");
      if (!packet) return { kind: "notFound" as const };
      const changed = packet.productType !== productType;
      const requiresReviewReset = changed && packet.productType !== null;
      if (requiresReviewReset && (packet.status === "queued" || packet.status === "processing")) {
        return { kind: "notEditable" as const };
      }
      if (requiresReviewReset) {
        await registerCheckpointManifest(tx, packet);
        // Published manifest membership is mutable projection state. Remove
        // this packet's pages before resetting it for reprocessing; immutable
        // scoped approval snapshots remain untouched.
        await tx
          .delete(manufacturerPacketManifestTable)
          .where(
            and(
              eq(manufacturerPacketManifestTable.quoteId, id),
              eq(manufacturerPacketManifestTable.packetId, packetId),
            ),
          );
      }
      const [updated] = await tx
        .update(manufacturerPacketsTable)
        .set(
          !requiresReviewReset || packet.status === "awaiting_upload"
            ? { productType }
            : {
                productType,
                status: "queued",
                processingState: resetRenderCheckpoints(packet.processingState),
                manualRedactions: null,
                appliedRedactionTemplateId: null,
                appliedRedactionTemplateName: null,
                sanitizedPdfObjectPath: null,
                sanitizedPdfSha256: null,
                sanitizedPageObjectPaths: null,
                failureMessage: null,
                attemptCount: 0,
                processingStartedAt: null,
                processingAttemptToken: null,
              },
        )
        .where(eq(manufacturerPacketsTable.id, packetId))
        .returning();
      if (changed && packet.status === "approved") {
        // A reassigned published packet changes both the old and new category's
        // content; all immutable snapshots stay downloadable.
        await invalidateApprovalCoverage(tx, id, [...new Set([packet.productType, productType].filter(Boolean) as string[])], "A manufacturer packet assignment changed.");
      }
      return {
        kind: "ok" as const,
        packet: updated!,
        shouldProcess: requiresReviewReset && packet.status !== "awaiting_upload",
      };
    });
    if (outcome.kind === "notFound") { res.status(404).json({ error: "Packet or quote not found." }); return; }
    if (outcome.kind === "archived") { res.status(400).json({ error: "This quote is archived. Restore it to edit packet assignment." }); return; }
    if (outcome.kind === "invalid") { res.status(400).json({ error: "productType must be an active product type on this quote." }); return; }
    if (outcome.kind === "notEditable") { res.status(409).json({ error: "Wait for packet processing to finish before changing its product type." }); return; }
    if (outcome.shouldProcess) kickPacketProcessing(outcome.packet.id);
    res.json(serializePacket(outcome.packet));
  },
);

router.patch(
  "/quotes/:id/manufacturer-packets/:packetId/manufacturer",
  async (req, res): Promise<void> => {
    const params = parseParams(SetManufacturerPacketManufacturerParams, req.params, res);
    if (!params) return;
    const body = SetManufacturerPacketManufacturerBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "A non-empty manufacturer is required." });
      return;
    }
    const manufacturer = body.data.manufacturer.trim().replace(/\s+/g, " ");
    if (!manufacturer) {
      res.status(400).json({ error: "A non-empty manufacturer is required." });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      const quote = await lockQuoteRow(tx, params.id);
      if (!quote) return { kind: "notFound" as const };
      if (quote.archivedAt) return { kind: "archived" as const };
      const [packet] = await tx
        .select()
        .from(manufacturerPacketsTable)
        .where(
          and(
            eq(manufacturerPacketsTable.id, params.packetId),
            eq(manufacturerPacketsTable.quoteId, params.id),
          ),
        )
        .for("update");
      if (!packet) return { kind: "notFound" as const };
      if (packet.status === "queued" || packet.status === "processing" || packet.status === "approved") {
        return { kind: "notEditable" as const };
      }
      await registerCheckpointManifest(tx, packet);
      const [updated] = await tx
        .update(manufacturerPacketsTable)
        .set(
          packet.status === "awaiting_upload"
            ? { manufacturer }
            : {
                manufacturer,
                status: "queued",
                processingState: null,
                manualRedactions: null,
                appliedRedactionTemplateId: null,
                appliedRedactionTemplateName: null,
                sanitizedPdfObjectPath: null,
                sanitizedPdfSha256: null,
                sanitizedPageObjectPaths: null,
                failureMessage: null,
                 attemptCount: 0,
              },
        )
        .where(eq(manufacturerPacketsTable.id, packet.id))
        .returning();
      return { kind: "ok" as const, packet: updated! };
    });
    if (outcome.kind === "notFound") {
      res.status(404).json({ error: "Packet not found." });
      return;
    }
    if (outcome.kind === "archived") {
      res.status(400).json({ error: "This quote is archived. Restore it to edit packet metadata." });
      return;
    }
    if (outcome.kind === "notEditable") {
      res.status(409).json({ error: "Manufacturer cannot be changed while processing or after approval." });
      return;
    }
    if (outcome.packet.status === "queued") kickPacketProcessing(outcome.packet.id);
    res.json(SetManufacturerPacketManufacturerResponse.parse(serializePacket(outcome.packet)));
  },
);

router.get("/quotes/:id/manufacturer-packet-manifest", async (req, res): Promise<void> => {
  const params = parseParams(GetManufacturerPacketManifestParams, req.params, res);
  if (!params) return;
  const query = GetManufacturerPacketManifestQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid document version." });
    return;
  }
  if (query.data.documentVersion) {
    const snapshot = await loadLockedSignoffSnapshot(params.id);
    if (!snapshot) {
      res.status(404).json({ error: "Quote not found" });
      return;
    }
    if (snapshot.version !== query.data.documentVersion) {
      res.status(409).json({ error: "This signoff document has changed. Refresh before loading attachments." });
      return;
    }
    res.json(
      GetManufacturerPacketManifestResponse.parse({
        entries: snapshot.manifest.map(({ packetId, pageNumber, pageOrder }) => ({
          packetId,
          pageNumber,
          pageOrder,
        })),
      }),
    );
    return;
  }
  const entries = await db
    .select({
      packetId: manufacturerPacketManifestTable.packetId,
      pageNumber: manufacturerPacketManifestTable.pageNumber,
      pageOrder: manufacturerPacketManifestTable.pageOrder,
    })
    .from(manufacturerPacketManifestTable)
    .innerJoin(
      manufacturerPacketsTable,
      eq(manufacturerPacketManifestTable.packetId, manufacturerPacketsTable.id),
    )
    .where(
      and(
        eq(manufacturerPacketManifestTable.quoteId, params.id),
        eq(manufacturerPacketsTable.status, "approved"),
      ),
    )
    .orderBy(manufacturerPacketManifestTable.pageOrder);
  res.json(GetManufacturerPacketManifestResponse.parse({ entries }));
});

router.put("/quotes/:id/manufacturer-packet-manifest", async (req: AuthedRequest, res): Promise<void> => {
  const params = parseParams(SetManufacturerPacketManifestParams, req.params, res);
  if (!params) return;
  const body = SetManufacturerPacketManifestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid packet manifest." });
    return;
  }
  const entries = body.data.entries;
  const seenPages = new Set<string>();
  const orders = new Set<number>();
  if (
    entries.some(
      (entry) =>
        seenPages.has(`${entry.packetId}:${entry.pageNumber}`) ||
        orders.has(entry.pageOrder) ||
        (seenPages.add(`${entry.packetId}:${entry.pageNumber}`),
        orders.add(entry.pageOrder),
        false),
    )
  ) {
    res.status(400).json({ error: "Manifest pages and page order values must be unique." });
    return;
  }
  const profile = await getUserProfile(req.userId!);
  const outcome = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.id);
    if (!quote) return "notFound" as const;
    if (quote.archivedAt) return "archived" as const;
    const packetIds = [...new Set(entries.map((entry) => entry.packetId))];
    const packets = packetIds.length
      ? await tx
          .select()
          .from(manufacturerPacketsTable)
          .where(
            and(
              eq(manufacturerPacketsTable.quoteId, params.id),
              inArray(manufacturerPacketsTable.id, packetIds),
            ),
          )
      : [];
    const byId = new Map(packets.map((packet) => [packet.id, packet]));
    const previousEntries = await tx
      .select({
        packetId: manufacturerPacketManifestTable.packetId,
        pageNumber: manufacturerPacketManifestTable.pageNumber,
        pageOrder: manufacturerPacketManifestTable.pageOrder,
        productType: manufacturerPacketsTable.productType,
      })
      .from(manufacturerPacketManifestTable)
      .innerJoin(manufacturerPacketsTable, eq(manufacturerPacketManifestTable.packetId, manufacturerPacketsTable.id))
      .where(eq(manufacturerPacketManifestTable.quoteId, params.id));
    if (entries.some((entry) => !byId.get(entry.packetId)?.productType)) {
      return "unclassifiedPackets" as const;
    }
    if (
      entries.some((entry) => {
        const packet = byId.get(entry.packetId);
        return (
          !packet ||
          !["ready_for_approval", "approved"].includes(packet.status) ||
          !packet.sanitizedPageObjectPaths?.[entry.pageNumber - 1]
        );
      })
    ) {
      return "invalidPackets" as const;
    }
    if (
      !(await manifestFitsDocumentBudget(
        entries.map(
          (entry) => byId.get(entry.packetId)?.sanitizedPdfObjectPath,
        ),
        entries.length,
      ))
    ) {
      return "overLimit" as const;
    }
    await tx
      .delete(manufacturerPacketManifestTable)
      .where(eq(manufacturerPacketManifestTable.quoteId, params.id));
    if (entries.length) {
      await tx.insert(manufacturerPacketManifestTable).values(
        entries.map((entry) => ({
          quoteId: params.id,
          packetId: entry.packetId,
          pageNumber: entry.pageNumber,
          pageOrder: entry.pageOrder,
        })),
      );
    }
    await tx
      .update(manufacturerPacketsTable)
      .set({ status: "ready_for_approval", approvedAt: null, approvedById: null, approvedByName: null })
      .where(
        and(
          eq(manufacturerPacketsTable.quoteId, params.id),
          eq(manufacturerPacketsTable.status, "approved"),
        ),
      );
    if (packetIds.length) {
      await tx
        .update(manufacturerPacketsTable)
        .set({
          status: "approved",
          approvedAt: new Date(),
          approvedById: req.userId!,
          approvedByName: profile.name,
        })
        .where(inArray(manufacturerPacketsTable.id, packetIds));
    }
    const changedTypes = changedManifestProductTypes(
      previousEntries,
      entries.map((entry) => ({ ...entry, productType: byId.get(entry.packetId)?.productType ?? null })),
    );
    const nextEntries = entries.map((entry) => ({ ...entry, productType: byId.get(entry.packetId)?.productType ?? null }));
    if (changedTypes.length) {
      await invalidateApprovalCoverage(tx, params.id, changedTypes, "Published manufacturer packet pages changed.");
    } else if (manifestChanged(previousEntries, nextEntries)) {
      // Legacy approval is whole-quote only; an unclassified page change is
      // relevant but must not be guessed into scoped coverage.
      await invalidateLegacyApproval(tx, params.id, "Published manufacturer packet pages changed.");
    }
    return "ok" as const;
  });
  if (outcome === "notFound") {
    res.status(404).json({ error: "Quote not found" });
    return;
  }
  if (outcome === "archived") {
    res.status(400).json({ error: "This quote is archived. Restore it to change the packet manifest." });
    return;
  }
  if (outcome === "invalidPackets") {
    res.status(409).json({ error: "Every manifest page must come from a sanitized packet ready for approval." });
    return;
  }
  if (outcome === "unclassifiedPackets") {
    res.status(400).json({ error: "Assign a product type to every packet before publishing it." });
    return;
  }
  if (outcome === "overLimit") {
    res.status(400).json({ error: "Approved manifest may contain at most 500 pages and 100 MiB of unique source PDFs." });
    return;
  }
  res.json(SetManufacturerPacketManifestResponse.parse({ entries }));
});

router.delete("/quotes/:id/manufacturer-packet-manifest", async (req, res): Promise<void> => {
  const params = parseParams(ClearManufacturerPacketManifestParams, req.params, res);
  if (!params) return;
  const outcome = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.id);
    if (!quote) return "notFound" as const;
    if (quote.archivedAt) return "archived" as const;
    const previousEntries = await tx
      .select({
        packetId: manufacturerPacketManifestTable.packetId,
        pageNumber: manufacturerPacketManifestTable.pageNumber,
        pageOrder: manufacturerPacketManifestTable.pageOrder,
        productType: manufacturerPacketsTable.productType,
      })
      .from(manufacturerPacketManifestTable)
      .innerJoin(manufacturerPacketsTable, eq(manufacturerPacketManifestTable.packetId, manufacturerPacketsTable.id))
      .where(eq(manufacturerPacketManifestTable.quoteId, params.id));
    await tx.delete(manufacturerPacketManifestTable).where(eq(manufacturerPacketManifestTable.quoteId, params.id));
    await tx
      .update(manufacturerPacketsTable)
      .set({ status: "ready_for_approval", approvedAt: null, approvedById: null, approvedByName: null })
      .where(and(eq(manufacturerPacketsTable.quoteId, params.id), eq(manufacturerPacketsTable.status, "approved")));
    const changedTypes = changedManifestProductTypes(previousEntries, []);
    if (changedTypes.length) {
      await invalidateApprovalCoverage(tx, params.id, changedTypes, "Published manufacturer packet pages were unpublished.");
    } else if (previousEntries.length) {
      await invalidateLegacyApproval(tx, params.id, "Published manufacturer packet pages were unpublished.");
    }
    return "ok" as const;
  });
  if (outcome === "notFound") {
    res.status(404).json({ error: "Quote not found" });
    return;
  }
  if (outcome === "archived") {
    res.status(400).json({ error: "This quote is archived. Restore it to change the packet manifest." });
    return;
  }
  res.sendStatus(204);
});

router.post(
  "/quotes/:id/manufacturer-packets",
  async (req, res): Promise<void> => {
    const params = parseParams(RequestManufacturerPacketUploadParams, req.params, res);
    if (!params) return;
    const body = RequestManufacturerPacketUploadBody.safeParse(req.body);
    if (
      !body.success ||
      !body.data.name.toLowerCase().endsWith(".pdf") ||
      !body.data.manufacturer.trim()
    ) {
      res.status(400).json({ error: "A PDF filename, PDF content type, and size up to 50 MiB are required." });
      return;
    }
    const createOutcome = await db.transaction(async (tx) => {
      const quote = await lockQuoteRow(tx, params.id);
      if (!quote) return { kind: "notFound" as const };
      if (quote.archivedAt) return { kind: "archived" as const };
      if (!quote.categories.includes(body.data.productType)) return { kind: "invalidProductType" as const };
      // The initial unique placeholder obtains a serial ID; the final staging
      // path is generated from that ID and is therefore quote/packet-bound.
      const placeholder = `/objects/manufacturer-packet-staging/pending/${randomUUID()}`;
      const [pending] = await tx
        .insert(manufacturerPacketsTable)
        .values({
          quoteId: quote.id,
          manufacturer: body.data.manufacturer?.trim() || null,
          productType: body.data.productType,
          originalName: body.data.name,
          declaredSize: body.data.size,
          uploadObjectPath: placeholder,
        })
        .returning();
      return { kind: "ok" as const, quoteId: quote.id, pending: pending! };
    });
    if (createOutcome.kind === "notFound") {
      res.status(404).json({ error: "Quote not found" });
      return;
    }
    if (createOutcome.kind === "archived") {
      res.status(400).json({ error: "This quote is archived. Restore it to add a packet." });
      return;
    }
    if (createOutcome.kind === "invalidProductType") {
      res.status(400).json({ error: "productType must be an active product type on this quote." });
      return;
    }
    const { pending } = createOutcome;
    const uploadObjectPath = packetUploadPath(createOutcome.quoteId, pending.id);
    const [packet] = await db
      .update(manufacturerPacketsTable)
      .set({ uploadObjectPath })
      .where(eq(manufacturerPacketsTable.id, pending.id))
      .returning();
    try {
      const uploadURL = await storage.getObjectEntityUploadURLForPath(uploadObjectPath);
      res.status(201).json(
        RequestManufacturerPacketUploadResponse.parse({
          packet: serializePacket(packet!),
          uploadURL,
        }),
      );
    } catch (error) {
      await db.delete(manufacturerPacketsTable).where(eq(manufacturerPacketsTable.id, pending.id));
      req.log.error({ err: error }, "Unable to sign packet upload URL");
      res.status(500).json({ error: "Unable to create the secure packet upload URL." });
    }
  },
);

router.get(
  "/quotes/:id/manufacturer-packets/:packetId",
  async (req, res): Promise<void> => {
    const params = parseParams(GetManufacturerPacketParams, req.params, res);
    if (!params) return;
    const packet = await getPacket(params.id, params.packetId);
    if (!packet) {
      res.status(404).json({ error: "Packet not found" });
      return;
    }
    res.json(GetManufacturerPacketResponse.parse(serializePacket(packet)));
  },
);

router.delete(
  "/quotes/:id/manufacturer-packets/:packetId",
  async (req, res): Promise<void> => {
    const params = parseParams(DeleteManufacturerPacketParams, req.params, res);
    if (!params) return;
    const deleted = await db.transaction(async (tx) => {
      const quote = await lockQuoteRow(tx, params.id);
      if (!quote || quote.archivedAt) return null;
      const priorManifest = await tx
        .select({ packetId: manufacturerPacketManifestTable.packetId })
        .from(manufacturerPacketManifestTable)
        .where(and(eq(manufacturerPacketManifestTable.quoteId, params.id), eq(manufacturerPacketManifestTable.packetId, params.packetId)))
        .limit(1);
      const [packet] = await tx
        .select().from(manufacturerPacketsTable)
        .where(
          and(
            eq(manufacturerPacketsTable.id, params.packetId),
            eq(manufacturerPacketsTable.quoteId, params.id),
          ),
        )
        .for("update");
      if (!packet) return null;
      await registerCheckpointManifest(tx, packet);
      await tx.delete(manufacturerPacketsTable).where(eq(manufacturerPacketsTable.id, packet.id));
       // Cascading manifest removal changes only this packet's category.
       if (priorManifest.length && packet.productType) {
         await invalidateApprovalCoverage(tx, params.id, [packet.productType], "A published manufacturer packet was deleted.");
       } else if (priorManifest.length) {
         await invalidateLegacyApproval(tx, params.id, "A published manufacturer packet was deleted.");
       }
      return packet;
    });
    if (!deleted) {
      res.status(404).json({ error: "Packet not found or quote is archived." });
      return;
    }
    res.sendStatus(204);
  },
);

// Original PDFs are deliberately available only to approved employees through
// this explicit private endpoint; storage paths are never returned to clients.
router.get(
  "/quotes/:id/manufacturer-packets/:packetId/source",
  async (req, res): Promise<void> => {
    const params = parseParams(GetManufacturerPacketParams, req.params, res);
    if (!params) return;
    const packet = await getPacket(params.id, params.packetId);
    if (!packet?.sourceObjectPath) {
      res.status(404).json({ error: "Original packet is not available." });
      return;
    }
    try {
      await streamPrivateObject(packet.sourceObjectPath, res);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Original packet is not available." });
        return;
      }
      req.log.error({ err: error }, "Unable to stream private packet source");
      res.status(500).json({ error: "Unable to load original packet." });
    }
  },
);

router.get(
  "/quotes/:id/manufacturer-packets/:packetId/source/pages/:pageNumber",
  async (req, res): Promise<void> => {
    const deadlineAt = Date.now() + ORIGINAL_PREVIEW_HTTP_BUDGET_MS;
    const requestController = new AbortController();
    const cancelRequest = () => requestController.abort();
    req.once("aborted", cancelRequest);
    res.once("close", cancelRequest);
    const params = parseParams(GetManufacturerPacketPageParams, req.params, res);
    if (!params) {
      req.off("aborted", cancelRequest);
      res.off("close", cancelRequest);
      return;
    }
    const packet = await getPacket(params.id, params.packetId);
    if (!packet?.sourceObjectPath) {
      req.off("aborted", cancelRequest);
      res.off("close", cancelRequest);
      res.status(404).json({ error: "Original packet is not available." });
      return;
    }
    const previewPath = `/objects/manufacturer-packets/${params.id}/${params.packetId}/original-previews/page-${params.pageNumber}.png`;
    try {
      try {
        await storage.getObjectEntityFile(previewPath);
      } catch {
        await originalPreviewJobs.subscribe(
          previewPath,
          ({ signal, deadlineAt: jobDeadline }) =>
            originalPreviewAdmission.run(
              () => withOptionalPacketPreview(async () => {
                const source = await storage.downloadObjectBytesBounded(
                  packet.sourceObjectPath!,
                  40 * 1024 * 1024,
                  { signal, deadlineAt: jobDeadline },
                );
                const png = Buffer.from(await runPacketEngineInWorker(
                  {
                    operation: "preview",
                    bytes: source,
                    pageNumber: params.pageNumber,
                  },
                  { signal, deadlineAt: jobDeadline },
                ) as Uint8Array);
                if (signal.aborted || Date.now() >= jobDeadline) {
                  throw new PacketWorkerAbortedError();
                }
                try {
                  await storage.saveObjectEntityImmutable(previewPath, png, "image/png");
                } catch {
                  // Another replica rendered this immutable private preview first.
                }
              }),
              "normal",
              { signal, deadlineAt: jobDeadline },
            ),
          { signal: requestController.signal, deadlineAt },
        );
      }
      if (requestController.signal.aborted) return;
      await streamPrivateObject(previewPath, res);
    } catch (error) {
      if (requestController.signal.aborted) return;
      if (error instanceof PacketWorkerAbortedError) {
        res.status(503).json({ error: "Packet preview was cancelled. Please retry." });
        return;
      }
      if (error instanceof PacketWorkerQueueFullError) {
        res.setHeader("Retry-After", "5");
        res.status(429).json({ error: "Rendering capacity is reserved for PDF processing. Saved previews remain available; retry this preview shortly." });
        return;
      }
      if (error instanceof PacketWorkerTimeoutError) {
        res.status(503).json({ error: "Packet preview took too long. Please retry." });
        return;
      }
      req.log.warn({ err: error }, "Unable to render private original packet page");
      res.status(404).json({ error: "Original packet page is not available." });
    } finally {
      req.off("aborted", cancelRequest);
      res.off("close", cancelRequest);
    }
  },
);

router.post(
  "/quotes/:id/manufacturer-packets/:packetId/complete-upload",
  async (req, res): Promise<void> => {
    const params = parseParams(CompleteManufacturerPacketUploadParams, req.params, res);
    if (!params) return;
    const outcome = await db.transaction(async (tx) => {
      const quote = await lockQuoteRow(tx, params.id);
      if (!quote) return { kind: "notFound" as const };
      if (quote.archivedAt) return { kind: "archived" as const };
      const [packet] = await tx
        .select()
        .from(manufacturerPacketsTable)
        .where(
          and(
            eq(manufacturerPacketsTable.id, params.packetId),
            eq(manufacturerPacketsTable.quoteId, params.id),
          ),
        )
        .for("update");
      if (!packet) return { kind: "packetNotFound" as const };
      if (packet.status !== "awaiting_upload") return { kind: "ok" as const, packet };

      // Copy before queuing. Processing reads only this immutable source,
      // never the staging key whose signed PUT could otherwise be overwritten.
      const sourceObjectPath = packetSourcePath(params.id, packet.id);
      try {
        const uploaded = await storage.getObjectEntityMetadata(packet.uploadObjectPath);
        if (
          uploaded.size < 1 ||
          uploaded.size > 40 * 1024 * 1024 ||
          uploaded.size !== packet.declaredSize
        ) {
          return { kind: "invalidSize" as const };
        }
        await storage.copyObjectEntityImmutable(
          packet.uploadObjectPath,
          sourceObjectPath,
          uploaded.generation,
        );
        const copied = await storage.getObjectEntityMetadata(sourceObjectPath);
        if (copied.size !== uploaded.size || copied.size > 40 * 1024 * 1024) {
          return { kind: "invalidSize" as const };
        }
      } catch (copyError) {
        // If an instance ended after the immutable copy but before its DB
        // transaction committed, safely recover without ever recopying over
        // that source generation. A nonexistent destination remains an error.
        try {
          await storage.getObjectEntityFile(sourceObjectPath);
        } catch {
          throw copyError;
        }
      }
      const [updated] = await tx
        .update(manufacturerPacketsTable)
        .set({ sourceObjectPath, status: "queued", failureMessage: null })
        .where(eq(manufacturerPacketsTable.id, packet.id))
        .returning();
      return { kind: "ok" as const, packet: updated! };
    }).catch((error: unknown) => ({ kind: "copyFailed" as const, error }));
    if (outcome.kind === "notFound" || outcome.kind === "packetNotFound") {
      res.status(404).json({ error: "Packet not found" });
      return;
    }
    if (outcome.kind === "archived") {
      res.status(400).json({ error: "This quote is archived. Restore it to process a packet." });
      return;
    }
    if (outcome.kind === "copyFailed") {
      req.log.warn({ err: outcome.error }, "Packet upload completion before valid upload");
      res.status(400).json({ error: "The uploaded PDF was not found. Finish the secure upload and try again." });
      return;
    }
    if (outcome.kind === "invalidSize") {
      res.status(400).json({ error: "Uploaded PDF size does not match its declaration or exceeds 40 MiB." });
      return;
    }
    if (outcome.packet.status === "queued") kickPacketProcessing(outcome.packet.id);
    res.status(202).json(CompleteManufacturerPacketUploadResponse.parse(serializePacket(outcome.packet)));
  },
);

router.patch(
  "/quotes/:id/manufacturer-packets/:packetId/redactions",
  async (req, res): Promise<void> => {
    const params = parseParams(SetManufacturerPacketRedactionsParams, req.params, res);
    if (!params) return;
    const body = SetManufacturerPacketRedactionsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid packet redaction coordinates." });
      return;
    }
    const outcome = await db.transaction(async (tx) => {
      const quote = await lockQuoteRow(tx, params.id);
      if (!quote) return { kind: "notFound" as const };
      if (quote.archivedAt) return { kind: "archived" as const };
      const [packet] = await tx.select().from(manufacturerPacketsTable).where(
        and(eq(manufacturerPacketsTable.id, params.packetId), eq(manufacturerPacketsTable.quoteId, params.id)),
      ).for("update");
      if (!packet) return { kind: "notFound" as const };
      if (packet.status !== "needs_review" && packet.status !== "ready_for_approval") return { kind: "notReady" as const };
      const dimensions = new Map((packet.analysis ?? []).map((page) => [String(page.pageNumber), page]));
      const invalid = Object.entries(body.data.redactionsByPage).some(([page, rectangles]) => {
        const dimensionsForPage = dimensions.get(page);
        return !dimensionsForPage || rectangles.some((rectangle) =>
          rectangle.x + rectangle.width > dimensionsForPage.width ||
          rectangle.y + rectangle.height > dimensionsForPage.height,
        );
      });
      if (invalid) return { kind: "invalid" as const };
      await registerCheckpointManifest(tx, packet);
      const [updated] = await tx.update(manufacturerPacketsTable).set({
        manualRedactions: body.data.redactionsByPage,
        status: "queued",
        processingState: resetRenderCheckpoints(packet.processingState),
        sanitizedPdfObjectPath: null,
        sanitizedPdfSha256: null,
        sanitizedPageObjectPaths: null,
        processingAttemptToken: null,
        processingStartedAt: null,
        attemptCount: 0,
        failureMessage: null,
      }).where(eq(manufacturerPacketsTable.id, packet.id)).returning();
      return { kind: "ok" as const, packet: updated! };
    });
    if (outcome.kind === "notFound") {
      res.status(404).json({ error: "Packet not found" });
      return;
    }
    if (outcome.kind === "archived") {
      res.status(400).json({ error: "This quote is archived. Restore it to review a packet." });
      return;
    }
    if (outcome.kind === "notReady") {
      res.status(409).json({ error: "This packet is not ready for manual review." });
      return;
    }
    if (outcome.kind === "invalid") {
      res.status(400).json({ error: "Redactions must refer to analyzed packet pages and stay within their bounds." });
      return;
    }
    const updated = outcome.packet;
    kickPacketProcessing(updated!.id);
    res.status(202).json(SetManufacturerPacketRedactionsResponse.parse(serializePacket(updated!)));
  },
);

router.post(
  "/quotes/:id/manufacturer-packets/:packetId/retry",
  async (req, res): Promise<void> => {
    const params = parseParams(RetryManufacturerPacketParams, req.params, res);
    if (!params) return;
    const result = await queuePacketRetryForQuote(params.id, params.packetId);
    if (result.kind === "notFound") {
      res.status(404).json({ error: "Packet not found" });
      return;
    }
    if (result.kind === "archived") {
      res.status(400).json({ error: "This quote is archived. Restore it to retry a packet." });
      return;
    }
    if (result.kind === "notRetryable") {
      res.status(409).json({ error: "Packet cannot be retried yet or has reached its retry limit." });
      return;
    }
    res.status(202).json(RetryManufacturerPacketResponse.parse(serializePacket(result.packet)));
  },
);

router.post(
  "/quotes/:id/manufacturer-packets/:packetId/approve",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = parseParams(ApproveManufacturerPacketParams, req.params, res);
    if (!params) return;
    const profile = await getUserProfile(req.userId!);
    const outcome = await db.transaction(async (tx) => {
      const quote = await lockQuoteRow(tx, params.id);
      if (!quote) return { kind: "notFound" as const };
      if (quote.archivedAt) return { kind: "archived" as const };
      const [packet] = await tx
        .select()
        .from(manufacturerPacketsTable)
        .where(
          and(
            eq(manufacturerPacketsTable.id, params.packetId),
            eq(manufacturerPacketsTable.quoteId, params.id),
          ),
        )
        .for("update");
      if (!packet) return { kind: "notFound" as const };
      if (packet.status === "approved") return { kind: "ok" as const, packet };
      if (!packet.productType) return { kind: "unclassified" as const };
      if (
        packet.status !== "ready_for_approval" ||
        !packet.sanitizedPdfObjectPath ||
        !packet.sanitizedPdfSha256 ||
        !packet.sanitizedPageObjectPaths?.length
      ) {
        return { kind: "notReady" as const };
      }
      const existingManifest = await loadApprovedManifest(tx, params.id);
      if (
        !(await manifestFitsDocumentBudget(
          [
            ...existingManifest.map((entry) => entry.sanitizedPdfObjectPath),
            packet.sanitizedPdfObjectPath,
          ],
          existingManifest.length + packet.sanitizedPageObjectPaths.length,
        ))
      ) {
        return { kind: "overLimit" as const };
      }
      // A packet being reprocessed must not retain old manifest rows. Keep
      // this defensive cleanup here as well so a retry/recovery race or a
      // legacy inconsistent row can never hit the page uniqueness constraint.
      const staleManifestRows = await tx
        .select({ id: manufacturerPacketManifestTable.id })
        .from(manufacturerPacketManifestTable)
        .where(
          and(
            eq(manufacturerPacketManifestTable.quoteId, params.id),
            eq(manufacturerPacketManifestTable.packetId, packet.id),
          ),
        );
      if (staleManifestRows.length) {
        await tx
          .delete(manufacturerPacketManifestTable)
          .where(
            and(
              eq(manufacturerPacketManifestTable.quoteId, params.id),
              eq(manufacturerPacketManifestTable.packetId, packet.id),
            ),
          );
        if (packet.productType) {
          await invalidateApprovalCoverage(
            tx,
            params.id,
            [packet.productType],
            "A manufacturer packet was reprocessed before approval.",
          );
        }
      }
      const [updated] = await tx
        .update(manufacturerPacketsTable)
        .set({
          status: "approved",
          approvedAt: new Date(),
          approvedById: req.userId!,
          approvedByName: profile.name,
        })
        .where(eq(manufacturerPacketsTable.id, packet.id))
        .returning();
      const manifest = await tx
        .select({ pageOrder: manufacturerPacketManifestTable.pageOrder })
        .from(manufacturerPacketManifestTable)
        .where(eq(manufacturerPacketManifestTable.quoteId, params.id))
        .orderBy(manufacturerPacketManifestTable.pageOrder);
      const startOrder = manifest.length
        ? Math.max(...manifest.map((entry) => entry.pageOrder)) + 1
        : 1;
      await tx.insert(manufacturerPacketManifestTable).values(
        packet.sanitizedPageObjectPaths.map((_, index) => ({
          quoteId: params.id,
          packetId: packet.id,
          pageNumber: index + 1,
          pageOrder: startOrder + index,
        })),
      );
      // The document version changes with the approved bytes; clear the old
      // signature under the same quote lock to force explicit re-review.
       if (packet.productType) await invalidateApprovalCoverage(tx, params.id, [packet.productType], "A manufacturer packet was published.");
      return { kind: "ok" as const, packet: updated! };
    });
    if (outcome.kind === "notFound") {
      res.status(404).json({ error: "Packet not found" });
      return;
    }
    if (outcome.kind === "archived") {
      res.status(400).json({ error: "This quote is archived. Restore it to approve a packet." });
      return;
    }
    if (outcome.kind === "notReady") {
      res.status(409).json({ error: "Packet must be sanitized and manually reviewed before approval." });
      return;
    }
    if (outcome.kind === "unclassified") {
      res.status(400).json({ error: "Assign a product type before approving this packet." });
      return;
    }
    if (outcome.kind === "overLimit") {
      res.status(400).json({ error: "Approved manifest may contain at most 500 pages and 100 MiB of unique source PDFs." });
      return;
    }
    res.json(ApproveManufacturerPacketResponse.parse(serializePacket(outcome.packet)));
  },
);

router.get(
  "/quotes/:id/manufacturer-packets/:packetId/pages/:pageNumber",
  async (req, res): Promise<void> => {
    const params = parseParams(GetManufacturerPacketPageParams, req.params, res);
    if (!params) return;
    const query = GetManufacturerPacketPageQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid document version." });
      return;
    }
    if (query.data.documentVersion) {
      const snapshot = await loadLockedSignoffSnapshot(params.id);
      if (!snapshot) {
        res.status(404).json({ error: "Quote not found" });
        return;
      }
      if (snapshot.version !== query.data.documentVersion) {
        res.status(409).json({ error: "This signoff document has changed. Refresh before loading attachments." });
        return;
      }
      const manifestPage = snapshot.manifest.find(
        (entry) => entry.packetId === params.packetId && entry.pageNumber === params.pageNumber,
      );
      const objectPath = manifestPage?.pagePath?.[manifestPage.pageNumber - 1] ?? null;
      if (!objectPath) {
        res.status(404).json({ error: "This page is not in the current approved signoff manifest." });
        return;
      }
      try {
        await streamPrivateObject(objectPath, res);
      } catch (error) {
        req.log.error({ err: error }, "Unable to stream versioned packet page");
        res.status(404).json({ error: "Sanitized packet page is not available." });
      }
      return;
    }
    const packet = await getPacket(params.id, params.packetId);
    const objectPath = packet?.sanitizedPageObjectPaths?.[params.pageNumber - 1];
    if (!objectPath || !["ready_for_approval", "approved"].includes(packet.status)) {
      res.status(404).json({ error: "Sanitized packet page is not available." });
      return;
    }
    try {
      await streamPrivateObject(objectPath, res);
    } catch (error) {
      req.log.error({ err: error }, "Unable to stream packet page");
      res.status(404).json({ error: "Sanitized packet page is not available." });
    }
  },
);

router.get("/quotes/:id/signoff/document", async (req, res): Promise<void> => {
  const params = parseParams(GetSignedSignoffDocumentParams, req.params, res);
  if (!params) return;
  let [signoff] = await db
    .select({
      id: signoffsTable.id,
      signedAt: signoffsTable.signedAt,
      path: signoffsTable.signedDocumentObjectPath,
    })
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, params.id));
  if (signoff && !signoff.path) {
    const backfilled = await ensureLegacySignedDocumentSnapshot(params.id, {
      id: signoff.id,
      signedAt: signoff.signedAt,
    });
    if (!backfilled?.signedDocumentObjectPath) {
      res.status(409).json({ error: "The signed document changed while its legacy snapshot was being created." });
      return;
    }
    signoff = {
      id: backfilled.id,
      signedAt: backfilled.signedAt,
      path: backfilled.signedDocumentObjectPath,
    };
  }
  if (!signoff?.path) {
    res.status(404).json({ error: "No current signed document is available." });
    return;
  }
  try {
    res.setHeader("Content-Disposition", `attachment; filename="quote-${params.id}-signed-packet.pdf"`);
    await streamPrivateObject(signoff.path, res);
  } catch (error) {
    if (error instanceof UnsignedDocumentBuildCapacityError) {
      res.status(429).json({ error: "Document generation is busy. Please retry shortly." });
      return;
    }
    req.log.error({ err: error }, "Unable to stream signed packet document");
    res.status(404).json({ error: "No current signed document is available." });
  }
});

router.get("/quotes/:id/scoped-approvals/:approvalId/document", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const approvalId = Number(req.params.approvalId);
  if (!Number.isInteger(id) || !Number.isInteger(approvalId)) {
    res.status(400).json({ error: "Invalid scoped approval id." }); return;
  }
  const [approval] = await db.select().from(scopedApprovalsTable).where(
    and(eq(scopedApprovalsTable.id, approvalId), eq(scopedApprovalsTable.quoteId, id)),
  );
  if (!approval) { res.status(404).json({ error: "Scoped approval not found." }); return; }
  try {
    res.setHeader("Content-Disposition", `attachment; filename="quote-${id}-scoped-approval-${approvalId}.pdf"`);
    await streamPrivateObject(approval.signedDocumentObjectPath, res);
  } catch (error) {
    req.log.error({ err: error, approvalId }, "Unable to stream immutable scoped approval");
    res.status(404).json({ error: "Scoped approval document is not available." });
  }
});

/**
 * Staff evidence view. The quote and revision fields below are read only from
 * the approval's stored snapshot. In particular, do not replace this with a
 * current quote lookup: the current quote may have been edited or the
 * approval's public link may have been revoked since it was signed.
 */
router.get("/quotes/:id/scoped-approvals/:approvalId/snapshot", async (req, res): Promise<void> => {
  const params = parseParams(GetScopedApprovalSignoffSnapshotParams, req.params, res);
  if (!params) return;

  const [approvalRecord] = await db
    .select()
    .from(scopedApprovalsTable)
    .where(
      and(
        eq(scopedApprovalsTable.id, params.approvalId),
        eq(scopedApprovalsTable.quoteId, params.id),
      ),
    );
  if (!approvalRecord) {
    res.status(404).json({ error: "Scoped approval not found." });
    return;
  }

  const [request] = await db
    .select()
    .from(scopedApprovalRequestsTable)
    .where(eq(scopedApprovalRequestsTable.id, approvalRecord.requestId));
  if (!request) {
    res.status(409).json({ error: "The immutable approval request snapshot is unavailable." });
    return;
  }

  const snapshot = approvalRecord.snapshot as {
    quote?: unknown;
    revisions?: unknown;
    productTypes?: unknown;
    notIncludedProductTypes?: unknown;
    preparedAt?: unknown;
    manifest?: unknown;
  };
  if (
    !snapshot ||
    !snapshot.quote ||
    !Array.isArray(snapshot.revisions) ||
    !Array.isArray(snapshot.productTypes) ||
    !Array.isArray(snapshot.notIncludedProductTypes) ||
    typeof snapshot.preparedAt !== "string" ||
    !Array.isArray(snapshot.manifest)
  ) {
    // Never silently substitute current mutable quote content for malformed
    // historical evidence.
    res.status(409).json({ error: "The immutable approval snapshot is unavailable." });
    return;
  }

  const coverage = await db
    .select()
    .from(scopedApprovalCoverageTable)
    .where(
      and(
        eq(scopedApprovalCoverageTable.quoteId, params.id),
        eq(scopedApprovalCoverageTable.approvalId, approvalRecord.id),
      ),
    );
  const invalidationReason =
    coverage.find((row) => row.invalidationReason)?.invalidationReason ?? null;
  const current =
    approvalRecord.productTypes.length > 0 &&
    approvalRecord.productTypes.every((productType) =>
      coverage.some(
        (row) =>
          row.productType === productType &&
          row.status === "signed" &&
          row.approvalId === approvalRecord.id,
      ),
    );
  const now = new Date();
  const linkStatus = request.revokedAt
    ? "revoked"
    : request.expiresAt && request.expiresAt <= now
      ? "expired"
      : "active";

  const packetPages = snapshot.manifest.flatMap((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== "object") return [];
    const entry = rawEntry as {
      packetId?: unknown;
      productType?: unknown;
      pageOrder?: unknown;
    };
    if (
      typeof entry.packetId !== "number" ||
      typeof entry.productType !== "string" ||
      typeof entry.pageOrder !== "number"
    ) {
      return [];
    }
    return [{
      pageNumber: index + 1,
      packetId: entry.packetId,
      productType: entry.productType,
      // Stored snapshots normalize page order to the scoped sequence.
      pageOrder: entry.pageOrder + 1,
    }];
  });

  const response = {
    approvalId: approvalRecord.id,
    quote: snapshot.quote,
    revisions: snapshot.revisions,
    signoff: {
      id: approvalRecord.id,
      quoteId: approvalRecord.quoteId,
      customerName: approvalRecord.customerName,
      stakeholderRole: approvalRecord.stakeholderRole,
      signatureType: approvalRecord.signatureType,
      signatureData: approvalRecord.signatureData,
      signedAt: approvalRecord.signedAt,
    },
    productTypes: snapshot.productTypes,
    notIncludedProductTypes: snapshot.notIncludedProductTypes,
    preparedAt: snapshot.preparedAt,
    documentVersion: approvalRecord.documentVersion,
    status: current ? "signed" : "needs_resigning",
    requestStatus: request.status,
    linkStatus,
    invalidationReason,
    packetPages,
  };
  res.json(GetScopedApprovalSignoffSnapshotResponse.parse(response));
});

/**
 * Streams a packet page selected by the immutable approval snapshot. This
 * endpoint intentionally does not consult the current packet row or public
 * token, so staff can inspect evidence after packet reprocessing or link
 * revocation.
 */
router.get("/quotes/:id/scoped-approvals/:approvalId/packet/pages/:pageNumber", async (req, res): Promise<void> => {
  const params = parseParams(GetScopedApprovalPacketPageParams, req.params, res);
  if (!params) return;
  const [approvalRecord] = await db
    .select()
    .from(scopedApprovalsTable)
    .where(
      and(
        eq(scopedApprovalsTable.id, params.approvalId),
        eq(scopedApprovalsTable.quoteId, params.id),
      ),
    );
  if (!approvalRecord) {
    res.status(404).json({ error: "Scoped approval not found." });
    return;
  }
  const snapshot = approvalRecord.snapshot as {
    manifest?: unknown;
  };
  if (!snapshot || !Array.isArray(snapshot.manifest)) {
    res.status(409).json({ error: "The immutable approval snapshot is unavailable." });
    return;
  }
  const rawEntry = snapshot.manifest[params.pageNumber - 1];
  if (!rawEntry || typeof rawEntry !== "object") {
    res.status(404).json({ error: "Signed packet page is not available." });
    return;
  }
  const entry = rawEntry as { pageNumber?: unknown; pagePath?: unknown };
  const pageNumber = typeof entry.pageNumber === "number" ? entry.pageNumber : 0;
  const pagePath = Array.isArray(entry.pagePath) && typeof entry.pagePath[pageNumber - 1] === "string"
    ? entry.pagePath[pageNumber - 1]
    : null;
  if (!pagePath) {
    res.status(404).json({ error: "Signed packet page is not available." });
    return;
  }
  try {
    await streamPrivateObject(pagePath, res);
  } catch (error) {
    req.log.error({ err: error, approvalId: params.approvalId, pageNumber: params.pageNumber }, "Unable to stream immutable scoped packet page");
    res.status(404).json({ error: "Signed packet page is not available." });
  }
});

router.get("/quotes/:id/signoff/document/unsigned", async (req, res): Promise<void> => {
  const params = parseParams(GetUnsignedSignoffDocumentParams, req.params, res);
  if (!params) return;
  const snapshot = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.id);
    if (!quote) return null;
    const revisions = await tx
      .select()
      .from(revisionsTable)
      .where(
        and(
          eq(revisionsTable.quoteId, quote.id),
          eq(revisionsTable.excludedFromSignoff, false),
        ),
      )
      .orderBy(revisionsTable.createdAt);
    const manifest = await loadApprovedManifest(tx, quote.id);
    return {
      quote,
      revisions,
      manifest,
      version: computeDocumentVersion(quote, revisions, manifest),
    };
  });
  if (!snapshot) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }
  try {
    const objectPath = await ensureUnsignedDocumentCached(
      snapshot.quote,
      snapshot.revisions,
      snapshot.manifest,
      snapshot.version,
    );
    res.setHeader("Content-Disposition", `attachment; filename="quote-${params.id}-packet-preview.pdf"`);
    await streamPrivateObject(objectPath, res);
  } catch (error) {
    req.log.error({ err: error }, "Unable to create unsigned packet document");
    res.status(500).json({ error: "Unable to create the current combined document." });
  }
});

export default router;