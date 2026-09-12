import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { and, eq } from "drizzle-orm";
import {
  db,
  manufacturerPacketManifestTable,
  manufacturerPacketsTable,
  quotesTable,
  revisionsTable,
  signoffsTable,
  scopedApprovalRequestsTable,
  scopedApprovalsTable,
  scopedApprovalCoverageTable,
} from "@workspace/db";
import {
  GetPublicManufacturerPacketPageParams,
  GetPublicManufacturerPacketPageQueryParams,
  GetPublicManufacturerPacketParams,
  GetPublicManufacturerPacketResponse,
  GetPublicSignoffDocumentParams,
  GetPublicSignoffParams,
  GetPublicSignoffResponse,
  GetPublicScopedSignoffResponse,
  SavePublicSignoffParams,
  SavePublicSignoffBody,
  SavePublicSignoffResponse,
} from "@workspace/api-zod";
import { publicSignoffWriteLimiter } from "../lib/rateLimiters";
import {
  quoteStats,
  serializeQuote,
  computeDocumentVersion,
  ensureUnsignedDocumentCached,
  ensureLegacySignedDocumentSnapshot,
  UnsignedDocumentBuildCapacityError,
  loadManifestPdfPages,
  loadIncludedRevisions,
  lockQuoteRow,
  validateSignoffSubmission,
  type SignoffSubmission,
} from "./quotes";
import { ObjectStorageService } from "../lib/objectStorage";
import { createSignedPacketDocument } from "../lib/packets/signoffDocument";
import { loadApprovedManifest } from "../lib/packets/service";
import { hashApprovedManifest } from "../lib/packets/manifestHash";
import {
  buildScopedSnapshot,
  loadScopedManifestPdfPages,
  productTypeLabel,
  scopedDocumentVersion,
  type ScopedSnapshot,
} from "../lib/scopedApprovals";
import { projectScopedPublicQuote } from "../lib/scopedPublicQuote";
import { legacyApprovalMetadata } from "../lib/legacyApproval";
import { canAccessScopedPublicToken, publicScopedRevisions } from "../lib/scopedApprovalModel";

// Public, token-gated routes. No login required — access is granted by
// knowing the unguessable share token attached to a quote.
const router: IRouter = Router();
const publicDocumentLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
});
const packetStorage = new ObjectStorageService();

async function loadQuoteByToken(token: string) {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.shareToken, token));
  return quote ?? null;
}

function asScopedSnapshot(value: unknown): ScopedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as ScopedSnapshot;
  if (!(Array.isArray(snapshot.productTypes) &&
    Array.isArray(snapshot.notIncludedProductTypes) &&
    Array.isArray(snapshot.revisions) &&
    Array.isArray(snapshot.manifest) &&
    !!snapshot.quote)) return null;
  const rawQuote = snapshot.quote as unknown as Record<string, unknown>;
  if (
    typeof rawQuote.id !== "number" ||
    typeof rawQuote.quoteNumber !== "string" ||
    typeof rawQuote.customerName !== "string" ||
    typeof rawQuote.projectName !== "string" ||
    typeof rawQuote.jobAddress !== "string" ||
    !Array.isArray(rawQuote.categories) ||
    !rawQuote.categories.every((category) => typeof category === "string") ||
    !rawQuote.specs ||
    typeof rawQuote.specs !== "object" ||
    (rawQuote.notes !== null && rawQuote.notes !== undefined && typeof rawQuote.notes !== "string")
  ) return null;
  // Old snapshots may contain a raw quote because early scoped issuance spread
  // the DB row. Project it at read time; storage is audit evidence and must
  // never be rewritten merely to remove now-private fields.
  snapshot.quote = projectScopedPublicQuote(
    rawQuote as unknown as Parameters<typeof projectScopedPublicQuote>[0],
    snapshot.productTypes,
  );
  // Rollout-era snapshots retained the full revision register. Public scoped
  // rendering must honor signoff exclusions without mutating stored evidence.
  snapshot.revisions = publicScopedRevisions(snapshot.revisions);
  // Requests created during the additive rollout are still immutable; give
  // their preview a deterministic fallback rather than current wall-clock time.
  if (typeof snapshot.preparedAt !== "string") snapshot.preparedAt = "1970-01-01T00:00:00.000Z";
  return snapshot;
}

async function scopedRequestByToken(token: string) {
  const [request] = await db.select().from(scopedApprovalRequestsTable)
    .where(eq(scopedApprovalRequestsTable.token, token));
  const snapshot = request ? asScopedSnapshot(request.snapshot) : null;
  // Revocation is an access-control boundary, not merely a UI status. Every
  // scoped public detail/document/page/sign route goes through this resolver.
  return request && canAccessScopedPublicToken(request.status) && snapshot ? { request, snapshot } : null;
}

function scopedSignoffRow(approval: typeof scopedApprovalsTable.$inferSelect | null) {
  return approval ? {
    id: approval.id,
    quoteId: approval.quoteId,
    customerName: approval.customerName,
    stakeholderRole: approval.stakeholderRole,
    signatureType: approval.signatureType,
    signatureData: approval.signatureData,
    signedAt: approval.signedAt,
  } : null;
}

// Scoped token paths deliberately use only request.snapshot for rendering and
// attachment access. A client never supplies (or can widen) productTypes.
router.get("/public/scoped-signoff/:token", async (req, res): Promise<void> => {
  const record = await scopedRequestByToken(String(req.params.token));
  if (!record) { res.status(404).json({ error: "Invalid or revoked scoped approval link" }); return; }
  const [approval] = await db.select().from(scopedApprovalsTable)
    .where(eq(scopedApprovalsTable.requestId, record.request.id));
  res.json(GetPublicScopedSignoffResponse.parse({
    quote: record.snapshot.quote,
    revisions: record.snapshot.revisions,
    signoff: scopedSignoffRow(approval ?? null),
    approval: scopedSignoffRow(approval ?? null),
    productTypes: record.snapshot.productTypes,
    notIncludedProductTypes: record.snapshot.notIncludedProductTypes,
    preparedAt: record.snapshot.preparedAt,
    documentVersion: record.request.documentVersion,
    status: approval ? "signed" : record.request.status === "open" ? "open" : "needs_resigning",
  }));
});

router.put("/public/scoped-signoff/:token", publicSignoffWriteLimiter, async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body.documentVersion !== "string" || !body.documentVersion) {
    res.status(400).json({ error: "A documentVersion is required." }); return;
  }
  const parsed = {
    customerName: typeof body.customerName === "string" ? body.customerName : "",
    stakeholderRole: body.stakeholderRole,
    signatureType: body.signatureType,
    signatureData: typeof body.signatureData === "string" ? body.signatureData : "",
  };
  if (!["Homeowner", "Contractor", "Architect/Designer", "Other"].includes(String(parsed.stakeholderRole)) ||
      !["typed", "drawn"].includes(String(parsed.signatureType))) {
    res.status(400).json({ error: "A valid signer role and signature type are required." }); return;
  }
  const validated = validateSignoffSubmission(parsed as SignoffSubmission);
  if ("error" in validated) { res.status(400).json({ error: validated.error }); return; }
  // Identify the parent quote before the transaction, then use the shared
  // quote -> request lock order inside it. This avoids deadlocking with quote
  // mutations that invalidate scoped requests under that same order.
  const [requestIdentity] = await db
    .select({ quoteId: scopedApprovalRequestsTable.quoteId })
    .from(scopedApprovalRequestsTable)
    .where(eq(scopedApprovalRequestsTable.token, String(req.params.token)));
  if (!requestIdentity) {
    res.status(404).json({ error: "Invalid or revoked scoped approval link" });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, requestIdentity.quoteId);
    if (!quote || quote.archivedAt) return { kind: "stale" as const };
    const [request] = await tx.select().from(scopedApprovalRequestsTable)
      .where(and(
        eq(scopedApprovalRequestsTable.token, String(req.params.token)),
        eq(scopedApprovalRequestsTable.quoteId, quote.id),
      )).for("update");
    if (!request || request.status === "revoked") return { kind: "notFound" as const };
    if (request.status !== "open" || request.documentVersion !== body.documentVersion) return { kind: "stale" as const };
    const snapshot = asScopedSnapshot(request.snapshot);
    if (!snapshot) return { kind: "stale" as const };
    // The request's preparation time is part of its locked PDF/version. Do
    // not mint a fresh render date while checking a submitted signature.
    const current = await buildScopedSnapshot(
      tx,
      quote,
      request.productTypes,
      snapshot.preparedAt,
    );
    if (current.unclassifiedPacket || scopedDocumentVersion(current.snapshot) !== request.documentVersion) {
      await tx.update(scopedApprovalRequestsTable).set({ status: "stale" })
        .where(eq(scopedApprovalRequestsTable.id, request.id));
      return { kind: "stale" as const };
    }
    const signedAt = new Date();
    const document = await createSignedPacketDocument({
      quote: snapshot.quote,
      revisions: snapshot.revisions as typeof revisionsTable.$inferSelect[],
      approvedPacketPages: await loadScopedManifestPdfPages(snapshot),
      scope: {
        included: snapshot.productTypes.map(productTypeLabel),
        notIncluded: snapshot.notIncludedProductTypes.map(productTypeLabel),
      },
      documentDate: new Date(snapshot.preparedAt),
      signoff: {
        customerName: validated.customerName,
        stakeholderRole: parsed.stakeholderRole as "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
        signatureType: parsed.signatureType as "typed" | "drawn",
        signatureData: validated.signatureData,
        signedAt,
      },
    });
    const path = `/objects/scoped-signoff-documents/${request.quoteId}/${request.id}-${randomUUID()}.pdf`;
    await packetStorage.saveObjectEntityImmutable(path, document.bytes, "application/pdf");
    const [approval] = await tx.insert(scopedApprovalsTable).values({
      requestId: request.id, quoteId: request.quoteId, productTypes: request.productTypes,
      snapshot, documentVersion: request.documentVersion, customerName: validated.customerName,
      stakeholderRole: String(parsed.stakeholderRole), signatureType: String(parsed.signatureType),
      signatureData: validated.signatureData, signedDocumentObjectPath: path,
      signedDocumentSha256: document.sha256, signedAt,
    }).returning();
    await tx.update(scopedApprovalRequestsTable).set({ status: "signed", signedAt })
      .where(eq(scopedApprovalRequestsTable.id, request.id));
    // Upsert each type independently; a combined approval becomes current
    // coverage for each selected type without touching unrelated types.
    for (const productType of request.productTypes) {
      await tx.insert(scopedApprovalCoverageTable).values({
        quoteId: request.quoteId, productType, approvalId: approval!.id, status: "signed",
        invalidatedAt: null, invalidationReason: null, updatedAt: signedAt,
      }).onConflictDoUpdate({
        target: [scopedApprovalCoverageTable.quoteId, scopedApprovalCoverageTable.productType],
        set: { approvalId: approval!.id, status: "signed", invalidatedAt: null, invalidationReason: null, updatedAt: signedAt },
      });
    }
    return { kind: "ok" as const, approval: approval! };
  });
  if (outcome.kind === "notFound") { res.status(404).json({ error: "Invalid or revoked scoped approval link" }); return; }
  if (outcome.kind === "stale") { res.status(409).json({ error: "This scoped approval has changed or is no longer current. Ask your sales representative for a new link." }); return; }
  res.json(scopedSignoffRow(outcome.approval));
});

router.get("/public/scoped-signoff/:token/packet", async (req, res): Promise<void> => {
  const record = await scopedRequestByToken(String(req.params.token));
  if (!record) { res.status(404).json({ error: "Invalid or revoked scoped approval link" }); return; }
  res.json({
    id: record.request.id,
    manufacturer: null,
    pageCount: record.snapshot.manifest.length,
    productTypes: record.snapshot.productTypes,
    // A locked request records the approved packet's timestamp. Older
    // snapshots issued during rollout have no field, so use request creation
    // rather than exposing a mutable packet row.
    approvedAt: record.snapshot.manifest[0]?.approvedAt ?? record.request.createdAt,
  });
});

router.get("/public/scoped-signoff/:token/packet/pages/:pageNumber", async (req, res): Promise<void> => {
  const pageNumber = Number(req.params.pageNumber);
  const documentVersion = typeof req.query.documentVersion === "string" ? req.query.documentVersion : "";
  const record = await scopedRequestByToken(String(req.params.token));
  if (!record) { res.status(404).json({ error: "Invalid or revoked scoped approval link" }); return; }
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || documentVersion !== record.request.documentVersion) {
    res.status(409).json({ error: "This scoped signoff document has changed. Refresh before viewing pages." }); return;
  }
  const page = record.snapshot.manifest[pageNumber - 1];
  const objectPath = page?.pagePath?.[page.pageNumber - 1];
  if (!objectPath) { res.status(404).json({ error: "Approved scoped packet page not found." }); return; }
  try {
    const file = await packetStorage.getObjectEntityFile(objectPath);
    const response = await packetStorage.downloadObject(file, 0);
    res.status(response.status).setHeader("Content-Type", "image/png");
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res); else res.end();
  } catch {
    res.status(404).json({ error: "Approved scoped packet page not found." });
  }
});

router.get("/public/scoped-signoff/:token/document", publicDocumentLimiter, async (req, res): Promise<void> => {
  const record = await scopedRequestByToken(String(req.params.token));
  if (!record) { res.status(404).json({ error: "Invalid or revoked scoped approval link" }); return; }
  const [approval] = await db.select().from(scopedApprovalsTable)
    .where(eq(scopedApprovalsTable.requestId, record.request.id));
  try {
    if (approval) {
      const file = await packetStorage.getObjectEntityFile(approval.signedDocumentObjectPath);
      const response = await packetStorage.downloadObject(file, 0);
      res.status(response.status).setHeader("Content-Disposition", 'inline; filename="scoped-customer-signoff.pdf"');
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res); else res.end();
      return;
    }
    const document = await createSignedPacketDocument({
      quote: record.snapshot.quote,
      revisions: record.snapshot.revisions as typeof revisionsTable.$inferSelect[],
      approvedPacketPages: await loadScopedManifestPdfPages(record.snapshot),
      documentDate: new Date(record.snapshot.preparedAt),
      scope: {
        included: record.snapshot.productTypes.map(productTypeLabel),
        notIncluded: record.snapshot.notIncludedProductTypes.map(productTypeLabel),
      },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="scoped-customer-signoff-preview.pdf"');
    res.send(Buffer.from(document.bytes));
  } catch (error) {
    req.log.error({ err: error, requestId: record.request.id }, "Unable to create scoped signoff document");
    res.status(500).json({ error: "The scoped signoff document could not be generated." });
  }
});

router.get("/public/signoff/:token", async (req, res): Promise<void> => {
  const params = GetPublicSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuoteByToken(params.data.token);
  if (!quote) {
    res.status(404).json({ error: "Invalid or revoked link" });
    return;
  }

  // Customers only see revisions the internal team hasn't excluded from
  // the signoff sheet (exclusion never touches the real revision log).
  const revisions = await db
    .select()
    .from(revisionsTable)
    .where(
      and(
        eq(revisionsTable.quoteId, quote.id),
        eq(revisionsTable.excludedFromSignoff, false),
      ),
    )
    .orderBy(revisionsTable.createdAt);

  const [signoff] = await db
    .select()
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, quote.id));

  const stats = await quoteStats([quote.id]);
  const approvedPacket = await loadApprovedManifest(db, quote.id);
  res.json(
    GetPublicSignoffResponse.parse({
      quote: serializeQuote(quote, stats.get(quote.id)),
      revisions,
      // Do not render an old whole-quote signature against mutable current
      // content. Public legacy links remain usable for review; only their
      // original immutable PDF, when present, is signed evidence.
      signoff: null,
      legacyApproval: legacyApprovalMetadata(signoff ?? null),
      documentVersion: computeDocumentVersion(quote, revisions, approvedPacket),
    }),
  );
});

// Archived quotes cannot be signed, even through an already-issued link.
function rejectIfArchived(
  quote: { archivedAt: Date | null },
  res: Parameters<Parameters<IRouter["put"]>[1]>[1],
): boolean {
  if (quote.archivedAt) {
    res.status(400).json({
      error: "This quote is no longer active and cannot be signed.",
    });
    return true;
  }
  return false;
}

// The 500 KB JSON body limit for this route is enforced in app.ts by mounting
// a tighter parser before the global 2 MB one. Route-level middleware here
// applies only the per-IP rate limit.
router.put(
  "/public/signoff/:token",
  publicSignoffWriteLimiter,
  async (req, res): Promise<void> => {
    const params = SavePublicSignoffParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SavePublicSignoffBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const validated = validateSignoffSubmission(parsed.data);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }

    const quote = await loadQuoteByToken(params.data.token);
    if (!quote) {
      res.status(404).json({ error: "Invalid or revoked link" });
      return;
    }
    if (rejectIfArchived(quote, res)) return;

    // Reject stale submissions: if the document changed (new revision, edit,
    // or exclusion) after the customer loaded it, they must review the latest
    // version before signing. The quote row is locked and re-read inside the
    // transaction so the version check cannot race a concurrent mutation.
    const signoff = await db.transaction(async (tx) => {
      const current = await lockQuoteRow(tx, quote.id);
      if (!current || current.archivedAt) return null;
      const [existing] = await tx
        .select({ id: signoffsTable.id })
        .from(signoffsTable)
        .where(eq(signoffsTable.quoteId, quote.id))
        .for("update");
      if (existing) return "alreadySigned" as const;
      const included = await loadIncludedRevisions(tx, quote.id);
      const approvedPacket = await loadApprovedManifest(tx, quote.id);
      if (
        computeDocumentVersion(current, included, approvedPacket) !==
        parsed.data.documentVersion
      )
        return null;
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
      const signedAt = new Date();
      const approvedPacketPages = await loadManifestPdfPages(approvedPacket);
      const signedDocument = await createSignedPacketDocument({
        quote: current,
        revisions,
        signoff: {
          customerName: validated.customerName,
          stakeholderRole: parsed.data.stakeholderRole,
          signatureType: parsed.data.signatureType,
          signatureData: validated.signatureData,
          signedAt,
        },
        approvedPacketPages,
      });
      const signedDocumentObjectPath = `/objects/signoff-documents/${quote.id}/${randomUUID()}.pdf`;
      await packetStorage.saveObjectEntityImmutable(
        signedDocumentObjectPath,
        signedDocument.bytes,
        "application/pdf",
      );
      const [row] = await tx
        .insert(signoffsTable)
        .values({
          quoteId: quote.id,
          customerName: validated.customerName,
          stakeholderRole: parsed.data.stakeholderRole,
          signatureType: parsed.data.signatureType,
          signatureData: validated.signatureData,
          signedPacketId: approvedPacket[0]?.packetId ?? null,
          signedPacketSha256: hashApprovedManifest(approvedPacket),
          signedDocumentObjectPath,
          signedDocumentSha256: signedDocument.sha256,
          signedAt,
        })
        .returning();
      return row;
    });

    if (signoff === "alreadySigned") {
      res.status(409).json({
        error: "This legacy signoff link is read-only after signing. Request a new scoped approval link for any replacement approval.",
      });
      return;
    }
    if (!signoff) {
      res.status(409).json({
        error:
          "This document has changed since it was loaded. Please refresh and review the latest version before signing.",
      });
      return;
    }

    res.json(SavePublicSignoffResponse.parse(signoff));
  },
);

router.get("/public/signoff/:token/packet", async (req, res): Promise<void> => {
  const params = GetPublicManufacturerPacketParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const quote = await loadQuoteByToken(params.data.token);
  if (!quote) {
    res.status(404).json({ error: "Invalid or revoked link" });
    return;
  }
  const entries = await db
    .select({
      packetId: manufacturerPacketManifestTable.packetId,
      manufacturer: manufacturerPacketsTable.manufacturer,
      approvedAt: manufacturerPacketsTable.approvedAt,
      pageOrder: manufacturerPacketManifestTable.pageOrder,
    })
    .from(manufacturerPacketManifestTable)
    .innerJoin(
      manufacturerPacketsTable,
      eq(manufacturerPacketManifestTable.packetId, manufacturerPacketsTable.id),
    )
    .where(
      and(
        eq(manufacturerPacketManifestTable.quoteId, quote.id),
        eq(manufacturerPacketsTable.status, "approved"),
      ),
    )
    .orderBy(manufacturerPacketManifestTable.pageOrder);
  if (!entries.length || !entries[0]?.approvedAt) {
    res.status(404).json({ error: "No approved manufacturer packet is available." });
    return;
  }
  // No paths, original filename, analyzer output, or review metadata escapes.
  res.json(GetPublicManufacturerPacketResponse.parse({
    id: entries[0]!.packetId,
    manufacturer: entries.length === 1 ? entries[0]!.manufacturer : null,
    pageCount: entries.length,
    approvedAt: entries[0]!.approvedAt,
  }));
});

router.get(
  "/public/signoff/:token/packet/pages/:pageNumber",
  async (req, res): Promise<void> => {
    const params = GetPublicManufacturerPacketPageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const query = GetPublicManufacturerPacketPageQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "A documentVersion is required to load packet pages." });
      return;
    }
    const snapshot = await db.transaction(async (tx) => {
      const [unlockedQuote] = await tx
        .select()
        .from(quotesTable)
        .where(eq(quotesTable.shareToken, params.data.token));
      if (!unlockedQuote) return null;
      const quote = await lockQuoteRow(tx, unlockedQuote.id);
      if (!quote || quote.shareToken !== params.data.token) return null;
      const revisions = await loadIncludedRevisions(tx, quote.id);
      const manifest = await loadApprovedManifest(tx, quote.id);
      const version = computeDocumentVersion(quote, revisions, manifest);
      const manifestPage = manifest[params.data.pageNumber - 1];
      return {
        version,
        objectPath: manifestPage?.pagePath?.[manifestPage.pageNumber - 1] ?? null,
      };
    });
    if (!snapshot) {
      res.status(404).json({ error: "Invalid or revoked link" });
      return;
    }
    if (snapshot.version !== query.data.documentVersion) {
      res.status(409).json({
        error: "This signoff document has changed. Refresh before viewing the current packet pages.",
      });
      return;
    }
    const objectPath = snapshot.objectPath;
    if (!objectPath) {
      res.status(404).json({ error: "Approved packet page not found." });
      return;
    }
    try {
      const file = await packetStorage.getObjectEntityFile(objectPath);
      const response = await packetStorage.downloadObject(file, 0);
      res.status(response.status);
      res.setHeader("Content-Type", "image/png");
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch {
      // Avoid source/object details on a public token route.
      res.status(404).json({ error: "Approved packet page not found." });
    }
  },
);

router.get("/public/signoff/:token/document", publicDocumentLimiter, async (req, res): Promise<void> => {
  const params = GetPublicSignoffDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const snapshot = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.shareToken, params.data.token));
    if (!candidate) return null;
    const quote = await lockQuoteRow(tx, candidate.id);
    if (!quote || quote.shareToken !== params.data.token) return null;
    const [signoff] = await tx
      .select()
      .from(signoffsTable)
      .where(eq(signoffsTable.quoteId, quote.id));
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
      signoff: signoff ?? null,
      revisions,
      manifest,
      version: computeDocumentVersion(quote, revisions, manifest),
    };
  });
  if (!snapshot) {
    res.status(404).json({ error: "Invalid or revoked link" });
    return;
  }
  try {
    let objectPath = snapshot.signoff?.signedDocumentObjectPath ?? null;
    if (snapshot.signoff && !objectPath) {
      const backfilled = await ensureLegacySignedDocumentSnapshot(
        snapshot.quote.id,
        {
          id: snapshot.signoff.id,
          signedAt: snapshot.signoff.signedAt,
        },
      );
      if (!backfilled?.signedDocumentObjectPath) {
        res.status(409).json({
          error: "This signed approval changed while its legacy PDF snapshot was being created.",
        });
        return;
      }
      objectPath = backfilled.signedDocumentObjectPath;
    }
    if (!objectPath) {
      objectPath = await ensureUnsignedDocumentCached(
        snapshot.quote,
        snapshot.revisions,
        snapshot.manifest,
        snapshot.version,
      );
    }
    const file = await packetStorage.getObjectEntityFile(objectPath);
    const response = await packetStorage.downloadObject(file, 0);
    res.status(response.status);
    res.setHeader("Content-Disposition", 'inline; filename="customer-signoff-packet.pdf"');
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof UnsignedDocumentBuildCapacityError) {
      res.status(429).json({ error: "Document generation is busy. Please retry shortly." });
      return;
    }
    req.log.error(
      { err: error, quoteId: snapshot.quote.id },
      "Unable to create or stream public signoff document",
    );
    res.status(500).json({ error: "The current signoff document could not be generated." });
  }
});

export default router;
