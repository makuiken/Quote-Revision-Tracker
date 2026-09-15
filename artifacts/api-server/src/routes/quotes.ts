import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashApprovedManifest } from "../lib/packets/manifestHash";
import { Router, type IRouter, type Response } from "express";
import {
  and,
  arrayContains,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  quotesTable,
  revisionsTable,
  signoffsTable,
  revisionDraftsTable,
  attachmentsTable,
  attachmentUploadsTable,
  usersTable,
  fieldOptionsTable,
  manufacturerPacketsTable,
  unsignedDocumentBuildsTable,
  type Signoff,
  scopedApprovalRequestsTable,
  scopedApprovalsTable,
  scopedApprovalCoverageTable,
  shareLinkAuditTable,
} from "@workspace/db";
import {
  GetCurrentUserResponse,
  ListFieldOptionsResponse,
  ListTeamMembersResponse,
  GetShareInfoResponse,
  ListQuotesQueryParams,
  ListQuotesResponse,
  CreateQuoteBody,
  CreateQuoteResponse,
  GetQuoteParams,
  GetQuoteResponse,
  UpdateQuoteParams,
  UpdateQuoteBody,
  UpdateQuoteResponse,
  ArchiveQuoteParams,
  ArchiveQuoteBody,
  ArchiveQuoteResponse,
  UnarchiveQuoteParams,
  UnarchiveQuoteResponse,
  DeleteQuoteParams,
  ListRevisionsParams,
  ListRevisionsResponse,
  CreateRevisionParams,
  CreateRevisionBody,
  CreateRevisionResponse,
  GetRevisionDraftParams,
  GetRevisionDraftResponse,
  SaveRevisionDraftParams,
  SaveRevisionDraftBody,
  SaveRevisionDraftResponse,
  DiscardRevisionDraftParams,
  PublishRevisionDraftBody,
  PublishRevisionDraftParams,
  PublishRevisionDraftResponse,
  SetRevisionSignoffExclusionParams,
  SetRevisionSignoffExclusionBody,
  SetRevisionSignoffExclusionResponse,
  CreateShareLinkParams,
  CreateShareLinkResponse,
  UpdateShareLinkParams,
  UpdateShareLinkBody,
  UpdateShareLinkResponse,
  RotateShareLinkParams,
  RotateShareLinkResponse,
  GetSignoffParams,
  GetLegacySignatureParams,
  GetLegacySignatureResponse,
  SaveSignoffParams,
  SaveSignoffBody,
  SaveSignoffResponse,
  CreateScopedApprovalResponse,
  UpdateScopedApprovalLinkParams,
  UpdateScopedApprovalLinkBody,
  UpdateScopedApprovalLinkResponse,
  RotateScopedApprovalLinkParams,
  RotateScopedApprovalLinkResponse,
  ListScopedApprovalsResponse,
  ClearSignoffParams,
  ListAttachmentsParams,
  ListAttachmentsResponse,
  CreateAttachmentParams,
  CreateAttachmentBody,
  CreateAttachmentResponse,
  DeleteAttachmentParams,
  GetDashboardSummaryResponse,
  GetRecentActivityQueryParams,
  GetRecentActivityResponse,
} from "@workspace/api-zod";
import {
  requireAuth,
  requireApproved,
  getUserProfile,
  type AuthedRequest,
} from "../middlewares/requireAuth";
import { hasMeaningfulSignatureInk } from "../lib/validateSignaturePng";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { createSignedPacketDocument } from "../lib/packets/signoffDocument";
import { loadApprovedManifest } from "../lib/packets/service";
import {
  manifestBudgetAllows,
  MAX_SIGNOFF_PACKET_SOURCE_BYTES,
} from "../lib/packets/documentBudget";
import {
  approvalCoverage,
  buildScopedSnapshot,
  invalidateApprovalCoverage,
  invalidateLegacyApproval,
  normalizedScope,
  scopedDocumentVersion,
} from "../lib/scopedApprovals";
import { quoteApprovalImpact } from "../lib/quoteApprovalImpact";
import { legacyApprovalMetadata } from "../lib/legacyApproval";
import {
  cleanupAttachmentUpload,
  markAttachmentUploadForCleanup,
  MAX_ATTACHMENT_BYTES,
  normalizeAttachmentContentType,
  validateAttachmentBytes,
} from "../lib/attachmentUploads";

const router: IRouter = Router();
const packetStorage = new ObjectStorageService();
const unsignedDocumentBuilds = new Map<string, Promise<void>>();
let activeUnsignedDocumentBuilds = 0;
const MAX_UNSIGNED_DOCUMENT_BUILDS = 2;
const UNSIGNED_BUILD_LEASE_MS = 180_000;
const UNSIGNED_BUILD_WAIT_MS = 8_000;
const UNSIGNED_BUILD_POLL_MS = 100;
export class UnsignedDocumentBuildCapacityError extends Error {}

// Process-local counters are intentionally cheap and additive to the
// database lease. They make cache stampedes and capacity pressure visible in
// each replica's structured logs without making metrics a correctness
// dependency.
export const unsignedDocumentMetrics = {
  cacheHits: 0,
  claims: 0,
  claimConflicts: 0,
  waits: 0,
  builds: 0,
  failures: 0,
};

function logUnsignedDocumentMetric(event: string, fields: Record<string, unknown> = {}) {
  console.info("unsigned_document_cache", { event, ...fields });
}

router.use(requireAuth);

// /me must stay reachable for pending users so the app can show them an
// "awaiting approval" screen; everything below requireApproved is gated.
router.get("/me", async (req: AuthedRequest, res): Promise<void> => {
  const profile = await getUserProfile(req.userId!);
  res.json(
    GetCurrentUserResponse.parse({
      id: req.userId,
      name: req.appUser?.name ?? profile.name,
      email: req.appUser?.email ?? profile.email,
      role: req.appUser?.role ?? "member",
      status: req.emailRejected
        ? "rejected"
        : (req.appUser?.status ?? "pending"),
    }),
  );
});

router.use(requireApproved);

router.get("/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      userId: usersTable.clerkUserId,
      name: usersTable.name,
    })
    .from(usersTable)
    .where(eq(usersTable.status, "approved"))
    .orderBy(usersTable.name);
  res.json(ListTeamMembersResponse.parse(rows));
});

// Readable by any approved user so the quote forms can render dropdowns;
// writes are admin-only and live on the /admin router.
router.get("/field-options", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      category: fieldOptionsTable.category,
      field: fieldOptionsTable.field,
      parentField: fieldOptionsTable.parentField,
      parentValue: fieldOptionsTable.parentValue,
      grandField: fieldOptionsTable.grandField,
      grandValue: fieldOptionsTable.grandValue,
      values: fieldOptionsTable.values,
    })
    .from(fieldOptionsTable)
    .orderBy(
      fieldOptionsTable.category,
      fieldOptionsTable.field,
      fieldOptionsTable.grandValue,
      fieldOptionsTable.parentValue,
    );
  res.json(ListFieldOptionsResponse.parse(rows));
});

type QuoteRow = typeof quotesTable.$inferSelect;

export async function quoteStats(quoteIds: number[]) {
  if (quoteIds.length === 0)
    return new Map<
      number,
      {
        revisionCount: number;
        lastActivityAt: Date | null;
        signed: boolean;
        legacyStatus: "signed" | "needs_resigning" | null;
        approvalCoverage: Array<{
          productType: string;
          status: "open" | "signed" | "needs_resigning";
          approvalId: number | null;
          invalidationReason: string | null;
        }>;
      }
    >();

  const revStats = await db
    .select({
      quoteId: revisionsTable.quoteId,
      count: sql<number>`count(*)::int`,
      last: sql<Date>`max(${revisionsTable.createdAt})`,
    })
    .from(revisionsTable)
    .where(inArray(revisionsTable.quoteId, quoteIds))
    .groupBy(revisionsTable.quoteId);

  const legacySignoffs = await db
    .select({ quoteId: signoffsTable.quoteId, legacyStatus: signoffsTable.legacyStatus })
    .from(signoffsTable)
    .where(inArray(signoffsTable.quoteId, quoteIds));
  const coverageRows = await db
    .select()
    .from(scopedApprovalCoverageTable)
    .where(inArray(scopedApprovalCoverageTable.quoteId, quoteIds));

  const map = new Map<
    number,
    {
      revisionCount: number;
      lastActivityAt: Date | null;
      signed: boolean;
      legacyStatus: "signed" | "needs_resigning" | null;
      approvalCoverage: Array<{
        productType: string;
        status: "open" | "signed" | "needs_resigning";
        approvalId: number | null;
        invalidationReason: string | null;
      }>;
    }
  >();
  for (const id of quoteIds)
    map.set(id, { revisionCount: 0, lastActivityAt: null, signed: false, legacyStatus: null, approvalCoverage: [] });
  for (const r of revStats) {
    const entry = map.get(r.quoteId);
    if (entry) {
      entry.revisionCount = r.count;
      entry.lastActivityAt = r.last ? new Date(r.last) : null;
    }
  }
  for (const s of legacySignoffs) {
    const entry = map.get(s.quoteId);
    if (entry) {
      entry.signed = s.legacyStatus === "signed";
      entry.legacyStatus = s.legacyStatus;
    }
  }
  for (const row of coverageRows) {
    const entry = map.get(row.quoteId);
    if (entry) entry.approvalCoverage.push({
      productType: row.productType,
      status: row.status,
      approvalId: row.approvalId,
      invalidationReason: row.invalidationReason,
    });
  }
  return map;
}

export function serializeQuote(
  quote: QuoteRow,
  stats?: {
    revisionCount: number;
    lastActivityAt: Date | null;
    signed: boolean;
    legacyStatus?: "signed" | "needs_resigning" | null;
    approvalCoverage?: Array<{
      productType: string;
      status: "open" | "signed" | "needs_resigning";
      approvalId: number | null;
      invalidationReason: string | null;
    }>;
  },
) {
  const approvalCoverage = quote.categories.map((productType) => {
    const row = stats?.approvalCoverage?.find((entry) => entry.productType === productType);
    return {
      productType,
      status: row?.status ?? "open",
      approvalId: row?.approvalId ?? null,
      invalidationReason: row?.invalidationReason ?? null,
    };
  });
  const fullyScopedSigned =
    approvalCoverage.length > 0 &&
    approvalCoverage.every((entry) => entry.status === "signed");
  const scopedNeedsResigning = approvalCoverage.some((entry) => entry.status === "needs_resigning");
  const hasPartialScopedCoverage = approvalCoverage.some((entry) => entry.status === "signed");
  // `signed` and `approvalStatus` share this single current-coverage
  // predicate. Legacy whole-quote validity is explicit; it is never expanded
  // into per-product-type rows. A full current scoped set supersedes an old
  // legacy needs-resigning state.
  const approvalStatus =
    fullyScopedSigned
      ? "signed"
      : scopedNeedsResigning || stats?.legacyStatus === "needs_resigning"
        ? "needs_resigning"
        : stats?.legacyStatus === "signed" || stats?.signed
          ? "signed"
          : hasPartialScopedCoverage
            ? "partial"
            : "open";
  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    customerName: quote.customerName,
    projectName: quote.projectName,
    jobAddress: quote.jobAddress,
    displayName: quote.projectName
      ? `${quote.customerName} - ${quote.projectName}`
      : quote.customerName,
    categories: quote.categories,
    specs: quote.specs ?? {},
    notes: quote.notes,
    createdById: quote.createdById,
    createdByName: quote.createdByName,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    revisionCount: stats?.revisionCount ?? 0,
    lastActivityAt: stats?.lastActivityAt ?? null,
    signed: approvalStatus === "signed",
    approvalCoverage,
    approvalStatus,
    archived: quote.archivedAt !== null,
    archivedAt: quote.archivedAt,
    archiveReason: quote.archiveReason,
    archivedByName: quote.archivedByName,
  };
}

/**
 * Version of the static signoff document content (terms & conditions,
 * approval disclaimer, etc.). Bump whenever that boilerplate text changes so
 * already-open documents become stale and must be reloaded before signing.
 */
export const SIGNOFF_CONTENT_VERSION = 3;
/**
 * The bytes of unsigned documents are cached under their document version.
 * Bump this independently when the PDF layout/typography changes so a
 * previously cached plain-text document can never be served for the new
 * renderer. Existing issued signed snapshots remain immutable and continue to
 * use their original object path.
 */
export const SIGNOFF_DOCUMENT_FORMAT_VERSION = 3;

export type SignoffSubmission = {
  customerName: string;
  stakeholderRole: "Homeowner" | "Contractor" | "Architect/Designer" | "Other";
  signatureType: "typed" | "drawn";
  signatureData: string;
};

export function validateSignoffSubmission(
  input: SignoffSubmission,
): { customerName: string; signatureData: string } | { error: string } {
  const customerName = input.customerName.trim();
  if (!customerName) return { error: "Signer name is required." };

  const signatureData = input.signatureData.trim();
  if (input.signatureType === "typed") {
    if (!signatureData) return { error: "A typed signature is required." };
    if (signatureData !== customerName) {
      return { error: "The typed signature must match the signer name." };
    }
  } else if (!hasMeaningfulSignatureInk(signatureData)) {
    return { error: "A drawn signature is required." };
  }
  return { customerName, signatureData };
}

/**
 * Opaque fingerprint of the signoff document content: the quote's last edit
 * plus the exact set of revisions shown to the signer, plus the static
 * content version. Signing requires the client to echo this back, so a
 * stale, already-open document can never be signed after the content changes.
 */
export function computeDocumentVersion(
  quote: Pick<QuoteRow, "updatedAt">,
  includedRevisions: Array<{ id: number }>,
  approvedPacket?: {
    id: number;
    sanitizedPdfSha256: string | null;
  } | Array<{
    packetId: number;
    pageNumber: number;
    pageOrder: number;
    sanitizedPdfSha256: string | null;
  }> | null,
): string {
  const packetFingerprint = Array.isArray(approvedPacket)
    ? approvedPacket
        .map(
          (entry) =>
            `${entry.pageOrder}:${entry.packetId}:${entry.pageNumber}:${entry.sanitizedPdfSha256 ?? "none"}`,
        )
        .join("|")
    : `${approvedPacket?.id ?? "none"}:${approvedPacket?.sanitizedPdfSha256 ?? "none"}`;
  return createHash("sha1")
    .update(
      `content-v${SIGNOFF_CONTENT_VERSION}|format-v${SIGNOFF_DOCUMENT_FORMAT_VERSION}|${quote.updatedAt.getTime()}|${includedRevisions.map((r) => r.id).join(",")}|packet:${packetFingerprint}`,
    )
    .digest("hex");
}

/**
 * Locks the quote row (SELECT ... FOR UPDATE) inside a transaction and returns
 * the current row. Every signoff-affecting mutation and both sign routes take
 * this lock, so version checks and content changes are fully serialized: a
 * signer can never race a concurrent edit/revision/exclusion.
 */
export async function lockQuoteRow(
  tx: Pick<typeof db, "select">,
  quoteId: number,
): Promise<QuoteRow | null> {
  const [quote] = await tx
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.id, quoteId))
    .for("update");
  return quote ?? null;
}

/** Loads the revisions currently shown on the signoff document (excluded ones omitted). */
export async function loadIncludedRevisions(
  tx: Pick<typeof db, "select">,
  quoteId: number,
) {
  return tx
    .select({ id: revisionsTable.id })
    .from(revisionsTable)
    .where(
      and(
        eq(revisionsTable.quoteId, quoteId),
        eq(revisionsTable.excludedFromSignoff, false),
      ),
    )
    .orderBy(revisionsTable.createdAt);
}

/** The one packet currently eligible for public signoff, if this quote has one. */
export async function loadApprovedPacket(
  tx: Pick<typeof db, "select">,
  quoteId: number,
) {
  const [packet] = await tx
    .select({
      id: manufacturerPacketsTable.id,
      sanitizedPdfObjectPath: manufacturerPacketsTable.sanitizedPdfObjectPath,
      sanitizedPdfSha256: manufacturerPacketsTable.sanitizedPdfSha256,
    })
    .from(manufacturerPacketsTable)
    .where(
      and(
        eq(manufacturerPacketsTable.quoteId, quoteId),
        eq(manufacturerPacketsTable.status, "approved"),
      ),
    );
  return packet ?? null;
}

export async function loadManifestPdfPages(
  manifest: Awaited<ReturnType<typeof loadApprovedManifest>>,
) {
  const maxSourceBytes = MAX_SIGNOFF_PACKET_SOURCE_BYTES;
  const uniquePaths = [
    ...new Set(
      manifest.map((entry) => {
        if (!entry.sanitizedPdfObjectPath) {
          throw new Error("Approved packet manifest has no sanitized PDF.");
        }
        return entry.sanitizedPdfObjectPath;
      }),
    ),
  ];
  let totalBytes = 0;
  const sizes = new Map<string, number>();
  for (const path of uniquePaths) {
    const { size } = await packetStorage.getObjectEntityMetadata(path);
    totalBytes += size;
    if (totalBytes > maxSourceBytes) {
      throw new Error("Approved packet sources exceed the 100 MiB document limit.");
    }
    sizes.set(path, size);
  }
  const bytesByPath = new Map<string, Buffer>();
  for (const entry of manifest) {
    const path = entry.sanitizedPdfObjectPath!;
    if (!bytesByPath.has(path)) {
      bytesByPath.set(
        path,
        await packetStorage.downloadObjectBytesBounded(path, sizes.get(path)!),
      );
    }
  }
  return manifest.map((entry) => ({
    pdfBytes: bytesByPath.get(entry.sanitizedPdfObjectPath!)!,
    pageNumber: entry.pageNumber,
  }));
}

export async function manifestFitsDocumentBudget(
  paths: Array<string | null | undefined>,
  pageCount: number,
): Promise<boolean> {
  if (paths.some((path) => !path)) return false;
  const uniquePaths = [...new Set(paths.filter((path): path is string => !!path))];
  const sizes: number[] = [];
  for (const path of uniquePaths) {
    const metadata = await packetStorage.getObjectEntityMetadata(path);
    sizes.push(metadata.size);
  }
  return manifestBudgetAllows(pageCount, sizes);
}

export async function createUnsignedSignoffDocument(
  quote: QuoteRow,
  revisions: Array<typeof revisionsTable.$inferSelect>,
  manifest?: Awaited<ReturnType<typeof loadApprovedManifest>>,
) {
  const approvedManifest = manifest ?? (await loadApprovedManifest(db, quote.id));
  return createSignedPacketDocument({
    quote,
    revisions,
    approvedPacketPages: await loadManifestPdfPages(approvedManifest),
  });
}

export async function ensureUnsignedDocumentCached(
  quote: QuoteRow,
  revisions: Array<typeof revisionsTable.$inferSelect>,
  manifest: Awaited<ReturnType<typeof loadApprovedManifest>>,
  version: string,
): Promise<string> {
  const path = `/objects/signoff-documents/${quote.id}/unsigned/${version}.pdf`;
  try {
    await packetStorage.getObjectEntityFile(path);
    unsignedDocumentMetrics.cacheHits += 1;
    logUnsignedDocumentMetric("hit", { quoteId: quote.id, version });
    return path;
  } catch (error) {
    if (!(error instanceof ObjectNotFoundError)) throw error;
  }
  const key = `${quote.id}:${version}`;
  let build = unsignedDocumentBuilds.get(key);
  if (!build) {
    build = (async () => {
      // The claim is durable and replica-safe. A process-local capacity check
      // is made only after a cache miss and before doing expensive work.
      const claimToken = randomUUID();
      let ownsClaim = false;
      const claimDeadline = Date.now() + UNSIGNED_BUILD_WAIT_MS;
      const claim = async (): Promise<boolean> => {
        const leaseUntil = new Date(Date.now() + UNSIGNED_BUILD_LEASE_MS);
        const claimed = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(unsignedDocumentBuildsTable)
            .values({
              quoteId: quote.id,
              documentVersion: version,
              objectPath: path,
              claimToken,
              leaseUntil,
            })
            .onConflictDoNothing({
              target: [
                unsignedDocumentBuildsTable.quoteId,
                unsignedDocumentBuildsTable.documentVersion,
              ],
            })
            .returning({ id: unsignedDocumentBuildsTable.id });
          if (inserted) return true;
          const [expired] = await tx
            .update(unsignedDocumentBuildsTable)
            .set({ claimToken, objectPath: path, leaseUntil, updatedAt: new Date() })
            .where(
              and(
                eq(unsignedDocumentBuildsTable.quoteId, quote.id),
                eq(unsignedDocumentBuildsTable.documentVersion, version),
                sql`${unsignedDocumentBuildsTable.leaseUntil} < now()`,
              ),
            )
            .returning({ id: unsignedDocumentBuildsTable.id });
          return Boolean(expired);
        });
        if (claimed) {
          unsignedDocumentMetrics.claims += 1;
          logUnsignedDocumentMetric("claim", { quoteId: quote.id, version });
        } else {
          unsignedDocumentMetrics.claimConflicts += 1;
          logUnsignedDocumentMetric("claim_conflict", { quoteId: quote.id, version });
        }
        return claimed;
      };

      while (!ownsClaim && Date.now() < claimDeadline) {
        ownsClaim = await claim();
        if (ownsClaim) break;
        unsignedDocumentMetrics.waits += 1;
        logUnsignedDocumentMetric("wait", { quoteId: quote.id, version });
        try {
          await packetStorage.getObjectEntityFile(path);
          return;
        } catch (error) {
          if (!(error instanceof ObjectNotFoundError)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, UNSIGNED_BUILD_POLL_MS));
      }
      if (!ownsClaim) {
        throw new UnsignedDocumentBuildCapacityError(
          "Another replica is still building this document; retry shortly.",
        );
      }
      if (activeUnsignedDocumentBuilds >= MAX_UNSIGNED_DOCUMENT_BUILDS) {
        // Do not retain a claim while waiting for local build capacity.
        await db.delete(unsignedDocumentBuildsTable).where(
          and(
            eq(unsignedDocumentBuildsTable.quoteId, quote.id),
            eq(unsignedDocumentBuildsTable.documentVersion, version),
            eq(unsignedDocumentBuildsTable.claimToken, claimToken),
          ),
        );
        throw new UnsignedDocumentBuildCapacityError(
          "Too many combined document builds are currently in progress.",
        );
      }
      activeUnsignedDocumentBuilds += 1;
      unsignedDocumentMetrics.builds += 1;
      logUnsignedDocumentMetric("build_start", { quoteId: quote.id, version });
      try {
        const document = await createUnsignedSignoffDocument(
          quote,
          revisions,
          manifest,
        );
        try {
          await packetStorage.saveObjectEntityImmutable(
            path,
            document.bytes,
            "application/pdf",
          );
        } catch (error) {
          if ((error as { code?: number }).code !== 412) throw error;
        }
        logUnsignedDocumentMetric("build_complete", { quoteId: quote.id, version });
      } catch (error) {
        unsignedDocumentMetrics.failures += 1;
        logUnsignedDocumentMetric("build_failed", { quoteId: quote.id, version });
        throw error;
      } finally {
        activeUnsignedDocumentBuilds -= 1;
        try {
          await db.delete(unsignedDocumentBuildsTable).where(
            and(
              eq(unsignedDocumentBuildsTable.quoteId, quote.id),
              eq(unsignedDocumentBuildsTable.documentVersion, version),
              eq(unsignedDocumentBuildsTable.claimToken, claimToken),
            ),
          );
        } catch (error) {
          // The immutable object is already usable; a stale claim is safely
          // recoverable after its lease expires.
          logUnsignedDocumentMetric("claim_release_failed", {
            quoteId: quote.id,
            version,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    unsignedDocumentBuilds.set(key, build);
    void build.then(
      () => {
        unsignedDocumentBuilds.delete(key);
      },
      () => {
        unsignedDocumentBuilds.delete(key);
      },
    );
  }
  await build;
  return path;
}

/**
 * Backfills an immutable PDF for signatures created before signed document
 * snapshots existed. It never changes the legal signature fields.
 */
export async function ensureLegacySignedDocumentSnapshot(
  quoteId: number,
  expected?: { id: number; signedAt: Date },
): Promise<Signoff | null> {
  // A pre-snapshot signature has no immutable proof of the quote/revisions it
  // reviewed. Rendering today's mutable quote and storing it as yesterday's
  // signed document would fabricate evidence, so legacy rows remain readable
  // but are never backfilled from current content.
  void quoteId;
  void expected;
  return null;
}

/**
 * An uploaded signed PDF is deliberately cleaned up only after the final
 * approval transaction has failed or rejected the prepared snapshot. The
 * generated path is random and the exact-path checks below cover every
 * approval table, so a committed evidence row is never removed.
 */
export async function cleanupUploadedDocumentIfUnreferenced(
  objectPath: string,
): Promise<void> {
  const [legacy] = await db
    .select({ id: signoffsTable.id })
    .from(signoffsTable)
    .where(eq(signoffsTable.signedDocumentObjectPath, objectPath))
    .limit(1);
  if (legacy) return;
  const [scoped] = await db
    .select({ id: scopedApprovalsTable.id })
    .from(scopedApprovalsTable)
    .where(eq(scopedApprovalsTable.signedDocumentObjectPath, objectPath))
    .limit(1);
  if (scoped) return;
  try {
    await packetStorage.deleteObjectEntity(objectPath);
  } catch (error) {
    // Cleanup is best effort and must never turn a correctly reported stale
    // or concurrent approval into a 500. The object remains unreferenced and
    // can be removed by storage lifecycle tooling.
    console.warn("unreferenced_signoff_object_cleanup_failed", {
      objectPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

router.get("/share-info", async (_req, res): Promise<void> => {
  // Determine the app's publicly reachable origin for share links.
  // In production, REPLIT_DOMAINS holds the deployed domain(s);
  // in development it (or REPLIT_DEV_DOMAIN) holds the public dev domain.
  const domain =
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN;
  if (!domain) {
    res.status(500).json({ error: "Public domain is not configured" });
    return;
  }
  res.json(GetShareInfoResponse.parse({ publicOrigin: `https://${domain}` }));
});

router.get("/quotes", async (req, res): Promise<void> => {
  const query = ListQuotesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { search, status, category, createdById, offset, limit } = query.data;

  const conditions: SQL[] = [];

  if (search) {
    conditions.push(
      or(
        ilike(quotesTable.quoteNumber, `%${search}%`),
        ilike(quotesTable.customerName, `%${search}%`),
        ilike(quotesTable.projectName, `%${search}%`),
        ilike(quotesTable.jobAddress, `%${search}%`),
      )!,
    );
  }
  if (category) conditions.push(arrayContains(quotesTable.categories, [category]));
  if (createdById) conditions.push(eq(quotesTable.createdById, createdById));

  if (status === "archived") {
    conditions.push(isNotNull(quotesTable.archivedAt));
  } else if (status) {
    conditions.push(isNull(quotesTable.archivedAt));
  }
  // A legacy whole-quote record counts as signed only while its separately
  // tracked validity is current; scoped rows must cover every active type.
  const signedExists = exists(
    db
      .select({ one: sql`1` })
      .from(signoffsTable)
    .where(and(eq(signoffsTable.quoteId, quotesTable.id), eq(signoffsTable.legacyStatus, "signed"))),
  );
  const scopedSignedExists = exists(
    db.select({ one: sql`1` }).from(scopedApprovalCoverageTable).where(
      and(
        eq(scopedApprovalCoverageTable.quoteId, quotesTable.id),
        eq(scopedApprovalCoverageTable.status, "signed"),
      ),
    ),
  );
  const needsResigningExists = exists(
    db.select({ one: sql`1` }).from(scopedApprovalCoverageTable).where(
      and(
        eq(scopedApprovalCoverageTable.quoteId, quotesTable.id),
        eq(scopedApprovalCoverageTable.status, "needs_resigning"),
      ),
    ),
  );
  const legacyNeedsResigningExists = exists(
    db.select({ one: sql`1` }).from(signoffsTable).where(
      and(eq(signoffsTable.quoteId, quotesTable.id), eq(signoffsTable.legacyStatus, "needs_resigning")),
    ),
  );
  // Every active category needs a current coverage row. Legacy whole-quote
  // records remain readable but are not silently reclassified as scoped
  // coverage.
  const fullyScopedSigned = sql`NOT EXISTS (
    SELECT 1 FROM unnest(${quotesTable.categories}) AS required_type
    LEFT JOIN scoped_approval_coverage coverage
      ON coverage.quote_id = ${quotesTable.id}
      AND coverage.product_type = required_type
      AND coverage.status = 'signed'
    WHERE coverage.id IS NULL
  )`;
  // Keep filtering aligned with serializeQuote's precedence: a valid legacy
  // whole-quote approval or complete current scoped coverage is signed;
  // otherwise stale coverage wins over partial coverage.
  const currentlySigned = or(signedExists, fullyScopedSigned)!;
  const hasNeedsResigning = or(needsResigningExists, legacyNeedsResigningExists)!;
  if (status === "signed") conditions.push(currentlySigned);
  if (status === "partial") {
    conditions.push(and(not(currentlySigned), not(hasNeedsResigning), scopedSignedExists)!);
  }
  if (status === "needs_resigning") conditions.push(and(not(currentlySigned), hasNeedsResigning)!);
  if (status === "awaiting") conditions.push(
    and(not(currentlySigned), not(hasNeedsResigning), not(scopedSignedExists))!,
  );

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(quotesTable)
    .where(where);

  const rows = await db
    .select()
    .from(quotesTable)
    .where(where)
    .orderBy(desc(quotesTable.createdAt), desc(quotesTable.id))
    .limit(limit)
    .offset(offset);

  const stats = await quoteStats(rows.map((r) => r.id));
  res.json(
    ListQuotesResponse.parse({
      items: rows.map((r) => serializeQuote(r, stats.get(r.id))),
      total: countRow?.total ?? 0,
    }),
  );
});

router.post("/quotes", async (req: AuthedRequest, res): Promise<void> => {
  const parsed = CreateQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const profile = await getUserProfile(req.userId!);
  const [quote] = await db
    .insert(quotesTable)
    .values({
      quoteNumber: parsed.data.quoteNumber,
      customerName: parsed.data.customerName,
      projectName: parsed.data.projectName,
      jobAddress: parsed.data.jobAddress,
      categories: parsed.data.categories,
      specs: parsed.data.specs ?? {},
      notes: parsed.data.notes ?? null,
      createdById: req.userId!,
      createdByName: profile.name,
    })
    .returning();

  res.status(201).json(CreateQuoteResponse.parse(serializeQuote(quote!)));
});

/**
 * Normalizes revision category tags: dedupes and keeps only tags that are
 * among the quote's own categories. Empty/absent becomes null ("general/all").
 */
function sanitizeRevisionCategories(
  input: string[] | null | undefined,
  quote: Pick<QuoteRow, "categories">,
): string[] | null {
  if (!input || input.length === 0) return null;
  const allowed = new Set(quote.categories);
  const tags = [...new Set(input)].filter((t) => allowed.has(t));
  return tags.length > 0 ? tags : null;
}

/**
 * Archived quotes are read-only: no edits, revisions, attachments, share
 * links, or signatures until they are restored. Returns false (and responds
 * 400) when the quote is archived.
 */
function guardNotArchived(quote: QuoteRow, res: Response): boolean {
  if (quote.archivedAt) {
    res.status(400).json({
      error: "This quote is archived. Restore it to make changes.",
    });
    return false;
  }
  return true;
}

async function loadQuote(id: number, res: Response): Promise<QuoteRow | null> {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.id, id));
  if (!quote) {
    res.status(404).json({ error: "Quote not found" });
    return null;
  }
  return quote;
}

router.get("/quotes/:id", async (req, res): Promise<void> => {
  const params = GetQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;

  const revisions = await db
    .select()
    .from(revisionsTable)
    .where(eq(revisionsTable.quoteId, quote.id))
    .orderBy(revisionsTable.createdAt);

  const [signoff] = await db
    .select()
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, quote.id));

  const stats = await quoteStats([quote.id]);
  const approvedPacket = await loadApprovedManifest(db, quote.id);
  const coverage = await approvalCoverage(db, quote);
  res.json(
    GetQuoteResponse.parse({
      quote: serializeQuote(quote, stats.get(quote.id)),
      revisions,
      // Whole-quote records predate structured immutable content snapshots.
      // Never put their signature into today's mutable quote/revision HTML.
      // The stored immutable PDF remains downloadable as legacy evidence.
      signoff: null,
      legacyApproval: legacyApprovalMetadata(signoff ?? null),
      documentVersion: computeDocumentVersion(
        quote,
        revisions.filter((r) => !r.excludedFromSignoff),
        approvedPacket,
      ),
      approvalCoverage: coverage,
      receipt: null,
    }),
  );
});

router.patch("/quotes/:id", async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdateQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<QuoteRow> = {};
  const changed: string[] = [];
  // This is assigned only after SELECT ... FOR UPDATE. Never compute the
  // change register from a pre-transaction row: a concurrent save otherwise
  // could escape invalidation or receive an incorrect automatic revision.
  let diffBase: QuoteRow | null = null;
  // Category tags derived from which spec sections changed, used to
  // auto-tag the generated revision entry.
  const changedSpecCategories = new Set<string>();
  const SPEC_KEY_TO_CATEGORY: Record<string, string> = {
    window: "windows",
    door: "doors",
    interiorDoor: "interiorDoors",
    exteriorDoor: "exteriorDoors",
    trimDescription: "trim",
    millworkDescription: "millwork",
  };
  const SPEC_LABELS: Record<string, string> = {
    window: "Windows",
    door: "Doors",
    interiorDoor: "Interior doors",
    exteriorDoor: "Exterior doors",
    trimDescription: "Trim description",
    millworkDescription: "Millwork description",
  };
  const FIELD_LABELS: Record<string, string> = {
    windowJambDepth: "Jamb depth",
    jambDepth: "Jamb depth",
    brand: "Brand",
    series: "Series",
    material: "Material",
    color: "Color",
    style: "Style",
    glass: "Glass",
    hardware: "Hardware",
  };

  const normalizeDiffValue = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.trim() === "" ? null : value.trim();
    if (Array.isArray(value)) {
      const normalized = value.map(normalizeDiffValue).filter((item) => item !== null);
      return normalized.length ? normalized : null;
    }
    return value;
  };

  const fmtValue = (value: unknown): string => {
    const normalized = normalizeDiffValue(value);
    if (normalized === null) return "not specified";
    if (Array.isArray(normalized)) {
      return normalized
        .map((item) => SPEC_LABELS[String(item)] ?? String(item))
        .join(", ");
    }
    const s = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  };

  const humanizeField = (value: string): string => {
    if (FIELD_LABELS[value]) return FIELD_LABELS[value]!;
    const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  };

  const describeChange = (label: string, before: unknown, after: unknown): string => {
    const normalizedBefore = normalizeDiffValue(before);
    const normalizedAfter = normalizeDiffValue(after);
    if (normalizedBefore === null) return `${label} added: ${fmtValue(after)}.`;
    if (normalizedAfter === null) return `${label} removed (previously ${fmtValue(before)}).`;
    return `${label} changed from ${fmtValue(before)} to ${fmtValue(after)}.`;
  };

  const track = (label: string, key: keyof QuoteRow, value: unknown) => {
    if (value === undefined) return;
    (updates as Record<string, unknown>)[key] = value;
    if (
      JSON.stringify(normalizeDiffValue(value)) !==
      JSON.stringify(normalizeDiffValue(diffBase?.[key]))
    ) {
      changed.push(describeChange(humanizeField(label), diffBase?.[key], value));
    }
  };

  // Specs are nested (category → fields), so diff them field by field for a
  // readable log entry instead of dumping the whole object.
  const trackSpecs = (value: unknown) => {
    if (value === undefined) return;
    (updates as Record<string, unknown>).specs = value;
    const prev = (diffBase?.specs ?? {}) as Record<string, Record<string, unknown> | null | undefined>;
    const next = (value ?? {}) as Record<string, Record<string, unknown> | null | undefined>;
    for (const category of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const prevValue = prev[category];
      const nextValue = next[category];
      // Scalar spec fields (trim/millwork descriptions) diff as a whole.
      const isScalar =
        (prevValue !== undefined && prevValue !== null && typeof prevValue !== "object") ||
        (nextValue !== undefined && nextValue !== null && typeof nextValue !== "object");
      if (isScalar) {
        if (
          JSON.stringify(normalizeDiffValue(prevValue)) !==
          JSON.stringify(normalizeDiffValue(nextValue))
        ) {
          changed.push(
            describeChange(SPEC_LABELS[category] ?? humanizeField(category), prevValue, nextValue),
          );
          const tag = SPEC_KEY_TO_CATEGORY[category];
          if (tag) changedSpecCategories.add(tag);
        }
        continue;
      }
      const prevFields = prevValue ?? {};
      const nextFields = nextValue ?? {};
      for (const field of new Set([...Object.keys(prevFields), ...Object.keys(nextFields)])) {
        const a = (prevFields as Record<string, unknown>)[field];
        const b = (nextFields as Record<string, unknown>)[field];
        if (
          JSON.stringify(normalizeDiffValue(a)) !==
          JSON.stringify(normalizeDiffValue(b))
        ) {
          const sectionLabel = SPEC_LABELS[category] ?? humanizeField(category);
          changed.push(describeChange(`${sectionLabel} — ${humanizeField(field)}`, a, b));
          const tag = SPEC_KEY_TO_CATEGORY[category];
          if (tag) changedSpecCategories.add(tag);
        }
      }
    }
  };

  const profile = await getUserProfile(req.userId!);

  // Update, signoff invalidation, and the auto revision entry are atomic so
  // the register always matches the saved edit.
  const quote = await db.transaction(async (tx) => {
    // Take the quote-row lock first (shared discipline with the sign routes)
    // and re-validate state under the lock rather than trusting the
    // pre-transaction read.
    const current = await lockQuoteRow(tx, params.data.id);
    if (!current || current.archivedAt) return null;
    diffBase = current;
    // Rebuild both the mutation and auto-revision content from the locked
    // row. This also makes a true no-op leave updatedAt/documentVersion alone.
    for (const key of Object.keys(updates)) delete (updates as Record<string, unknown>)[key];
    changed.length = 0;
    changedSpecCategories.clear();
    track("quote number", "quoteNumber", parsed.data.quoteNumber);
    track("customer name", "customerName", parsed.data.customerName);
    track("project name", "projectName", parsed.data.projectName);
    track("job address", "jobAddress", parsed.data.jobAddress);
    track("categories", "categories", parsed.data.categories);
    trackSpecs(parsed.data.specs);
    track("notes", "notes", parsed.data.notes);
    if (!changed.length) return current;
    const [updated] = await tx
      .update(quotesTable)
      .set(updates)
      .where(eq(quotesTable.id, params.data.id))
      .returning();
    if (!updated) return null;

    // Immutable legacy signoffs and scoped approval evidence are never
    // deleted. Only the changed product types lose current coverage. Shared
    // quote fields/category topology affect every active type.
    const categoryTopologyChanged =
      parsed.data.categories !== undefined &&
      JSON.stringify(current.categories) !== JSON.stringify(updated.categories);
    // Removed types remain as invalidated coverage rows instead of silently
    // disappearing with their approval; newly added types are open until
    // signed. A category topology change is shared approval content.
    const sharedQuoteChanged =
      current.quoteNumber !== updated.quoteNumber ||
      current.customerName !== updated.customerName ||
      current.projectName !== updated.projectName ||
      current.jobAddress !== updated.jobAddress ||
      current.notes !== updated.notes;
    // Compute this once from the locked current row and reuse it below. An
    // edit to a schema-valid but inactive spec section has no active type tag,
    // so its auto revision is general and must invalidate every active scope.
    const effectiveAutoRevisionCategories =
      sharedQuoteChanged || categoryTopologyChanged
        ? null
        : sanitizeRevisionCategories([...changedSpecCategories], updated);
    const invalidatedSpecCategories =
      changedSpecCategories.size > 0 && !effectiveAutoRevisionCategories
        ? [...new Set([...current.categories, ...updated.categories])]
        : effectiveAutoRevisionCategories ?? [];
    if (changed.length) {
      const affected = quoteApprovalImpact({
        beforeCategories: current.categories,
        afterCategories: updated.categories,
        changedSpecTypes: invalidatedSpecCategories,
        sharedChanged: sharedQuoteChanged,
        hasChanges: changed.length > 0,
      });
      await invalidateApprovalCoverage(
        tx,
        updated.id,
        affected,
        categoryTopologyChanged
          ? "Quote product types changed."
          : sharedQuoteChanged
            ? "Shared quote details changed."
            : "Approved specifications changed.",
      );
    }

    // Log the edit in the revision register automatically.
    if (changed.length > 0) {
      await tx.insert(revisionsTable).values({
        quoteId: updated.id,
        authorId: req.userId!,
        authorName: profile.name,
        note: `Quote details updated:\n${changed.join("\n")}`,
        // A combined note containing shared/header/category changes applies
        // to every scope, even when it also describes type-specific specs.
        categories: effectiveAutoRevisionCategories,
      });
    }
    return updated;
  });

  if (!quote) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }

  const stats = await quoteStats([quote.id]);
  res.json(UpdateQuoteResponse.parse(serializeQuote(quote, stats.get(quote.id))));
});

router.post(
  "/quotes/:id/archive",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = ArchiveQuoteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ArchiveQuoteBody.safeParse(req.body);
    const reason = parsed.success ? parsed.data.reason.trim() : "";
    if (!reason) {
      res.status(400).json({ error: "A reason for archiving is required" });
      return;
    }

    const before = await loadQuote(params.data.id, res);
    if (!before) return;
    if (before.archivedAt) {
      res.status(400).json({ error: "Quote is already archived" });
      return;
    }

    const profile = await getUserProfile(req.userId!);

    // Archive + register entry are atomic so the log always matches. The
    // update is conditional on the quote still being active, so concurrent
    // archive requests cannot double-archive or double-log.
    const quote = await db.transaction(async (tx) => {
      await lockQuoteRow(tx, params.data.id);
      const [updated] = await tx
        .update(quotesTable)
        .set({
          archivedAt: new Date(),
          archiveReason: reason,
          archivedById: req.userId!,
          archivedByName: profile.name,
        })
        .where(
          and(eq(quotesTable.id, params.data.id), isNull(quotesTable.archivedAt)),
        )
        .returning();
      if (!updated) return null;

      // The archive entry appears in the revision log, so any existing
      // signature no longer covers what the signer reviewed — invalidate it.
      await invalidateApprovalCoverage(tx, updated.id, updated.categories, "Quote archived.");
      await tx.insert(revisionsTable).values({
        quoteId: updated.id,
        authorId: req.userId!,
        authorName: profile.name,
        note: `Archived quote. Reason: ${reason}`,
      });
      return updated;
    });

    if (!quote) {
      res.status(400).json({ error: "Quote is already archived" });
      return;
    }

    const stats = await quoteStats([quote.id]);
    res.json(
      ArchiveQuoteResponse.parse(serializeQuote(quote, stats.get(quote.id))),
    );
  },
);

router.post(
  "/quotes/:id/unarchive",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = UnarchiveQuoteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const before = await loadQuote(params.data.id, res);
    if (!before) return;
    if (!before.archivedAt) {
      res.status(400).json({ error: "Quote is not archived" });
      return;
    }

    const profile = await getUserProfile(req.userId!);

    const quote = await db.transaction(async (tx) => {
      await lockQuoteRow(tx, params.data.id);
      const [updated] = await tx
        .update(quotesTable)
        .set({
          archivedAt: null,
          archiveReason: null,
          archivedById: null,
          archivedByName: null,
        })
        .where(
          and(
            eq(quotesTable.id, params.data.id),
            isNotNull(quotesTable.archivedAt),
          ),
        )
        .returning();
      if (!updated) return null;

      // The restore entry appears in the revision log, so any existing
      // signature no longer covers what the signer reviewed — invalidate it.
      await invalidateApprovalCoverage(tx, updated.id, updated.categories, "Quote restored.");
      await tx.insert(revisionsTable).values({
        quoteId: updated.id,
        authorId: req.userId!,
        authorName: profile.name,
        note: "Restored quote from archive",
      });
      return updated;
    });

    if (!quote) {
      res.status(400).json({ error: "Quote is not archived" });
      return;
    }

    const stats = await quoteStats([quote.id]);
    res.json(
      UnarchiveQuoteResponse.parse(serializeQuote(quote, stats.get(quote.id))),
    );
  },
);

// Quote deletion is intentionally allowed for archived quotes: archiving
// makes a quote's *content* read-only, while deletion is a record-lifecycle
// action and the only way to permanently remove a record.
router.delete("/quotes/:id", async (req, res): Promise<void> => {
  const params = DeleteQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const attachmentRows = await tx
      .select({
        objectPath: attachmentsTable.objectPath,
        uploadSessionId: attachmentsTable.uploadSessionId,
        name: attachmentsTable.name,
        size: attachmentsTable.size,
        contentType: attachmentsTable.contentType,
        uploadedById: attachmentsTable.uploadedById,
      })
      .from(attachmentsTable)
      .where(eq(attachmentsTable.quoteId, params.data.id));
    const uploadRows = await tx
      .select({ id: attachmentUploadsTable.id })
      .from(attachmentUploadsTable)
      .where(eq(attachmentUploadsTable.quoteId, params.data.id));
    const uploadIds = uploadRows.map((upload) => upload.id);
    const now = new Date();
    for (const attachment of attachmentRows) {
      if (!attachment.uploadSessionId && attachment.objectPath.startsWith("/objects/uploads/")) {
        const [created] = await tx
          .insert(attachmentUploadsTable)
          .values({
            id: randomUUID(),
            quoteId: params.data.id,
            objectPath: attachment.objectPath,
            finalObjectPath: attachment.objectPath,
            originalName: attachment.name,
            declaredSize: attachment.size ?? 1,
            declaredContentType: attachment.contentType ?? "application/octet-stream",
            createdById: attachment.uploadedById,
            status: "delete_pending",
            expiresAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: attachmentUploadsTable.id });
        if (created) uploadIds.push(created.id);
      }
    }
    if (uploadIds.length) {
      await tx
        .update(attachmentUploadsTable)
        .set({ status: "delete_pending", updatedAt: new Date() })
        .where(inArray(attachmentUploadsTable.id, uploadIds));
    }
    const [quote] = await tx
      .delete(quotesTable)
      .where(eq(quotesTable.id, params.data.id))
      .returning();
    return { quote, attachmentRows, uploadIds };
  });

  if (!outcome.quote) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }
  for (const uploadId of outcome.uploadIds) {
    void cleanupAttachmentUpload(uploadId).catch((error) => {
        req.log.warn(
          { err: error, uploadId },
          "Deleted quote attachment cleanup deferred",
        );
    });
  }
  res.sendStatus(204);
});

// ---------- Revision drafts ----------
// Private, per-user drafts of revision notes. Drafts live entirely outside
// the published revisions flow: they never appear in the revision log,
// signoff document, public share view, print log, or the document version
// hash, and saving/discarding one never touches signoff state.

router.get(
  "/quotes/:id/revision-draft",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = GetRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;

    const [draft] = await db
      .select()
      .from(revisionDraftsTable)
      .where(
        and(
          eq(revisionDraftsTable.quoteId, quote.id),
          eq(revisionDraftsTable.authorId, req.userId!),
        ),
      );

    res.json(GetRevisionDraftResponse.parse({ draft: draft ?? null }));
  },
);

router.put(
  "/quotes/:id/revision-draft",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = SaveRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SaveRevisionDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!parsed.data.note.trim()) {
      res.status(400).json({ error: "Draft cannot be empty." });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;
    if (!guardNotArchived(quote, res)) return;

    // Upsert: one resumable draft per user per quote.
    const [draft] = await db
      .insert(revisionDraftsTable)
      .values({
        quoteId: quote.id,
        authorId: req.userId!,
        note: parsed.data.note,
        categories: sanitizeRevisionCategories(parsed.data.categories, quote),
      })
      .onConflictDoUpdate({
        target: [revisionDraftsTable.quoteId, revisionDraftsTable.authorId],
        set: {
          note: parsed.data.note,
          categories: sanitizeRevisionCategories(parsed.data.categories, quote),
          updatedAt: new Date(),
        },
      })
      .returning();

    res.json(SaveRevisionDraftResponse.parse(draft));
  },
);

router.delete(
  "/quotes/:id/revision-draft",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = DiscardRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;

    await db
      .delete(revisionDraftsTable)
      .where(
        and(
          eq(revisionDraftsTable.quoteId, quote.id),
          eq(revisionDraftsTable.authorId, req.userId!),
        ),
      );

    res.sendStatus(204);
  },
);

router.post(
  "/quotes/:id/revision-draft/publish",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = PublishRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // Optional body: the latest composer text. When provided it supersedes
    // the stored draft, making publish a single atomic request — an
    // in-flight auto-save can never overtake it with older text.
    let providedNote: string | undefined;
    let providedCategories: string[] | null | undefined;
    if (req.body && typeof req.body === "object" && "note" in req.body) {
      const body = PublishRevisionDraftBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.message });
        return;
      }
      if (!body.data.note.trim()) {
        res.status(400).json({ error: "Update note cannot be empty." });
        return;
      }
      providedNote = body.data.note;
      // Distinguish "field omitted" (fall back to the draft's tags) from an
      // explicit empty selection (publish untagged).
      if ("categories" in body.data)
        providedCategories = body.data.categories ?? null;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;
    if (!guardNotArchived(quote, res)) return;

    const profile = await getUserProfile(req.userId!);
    // Publishing behaves identically to posting a fresh revision: it
    // invalidates any existing customer signoff and stamps the author.
    // The draft is deleted in the same transaction (atomic publish).
    const result = await db.transaction(async (tx) => {
      // Re-validate archive state under the lock: an archive may have
      // committed between the pre-transaction check and lock acquisition.
      const current = await lockQuoteRow(tx, quote.id);
      if (!current || current.archivedAt) return { archived: true as const };

      // Validate BEFORE deleting anything, so an invalid (missing or
      // blank) draft is never destroyed by a failed publish.
      const [draft] = await tx
        .select()
        .from(revisionDraftsTable)
        .where(
          and(
            eq(revisionDraftsTable.quoteId, quote.id),
            eq(revisionDraftsTable.authorId, req.userId!),
          ),
        );
      const note = providedNote ?? draft?.note;
      if (!note || !note.trim()) return { noDraft: true as const };
      const categories = sanitizeRevisionCategories(
        providedCategories !== undefined
          ? providedCategories
          : draft?.categories,
        current,
      );

      if (draft) {
        await tx
          .delete(revisionDraftsTable)
          .where(eq(revisionDraftsTable.id, draft.id));
      }
      // A tagged revision only invalidates matching coverage. General/empty
      // tags are explicitly shared and invalidate every type.
      await invalidateApprovalCoverage(
        tx,
        quote.id,
        categories ?? current.categories,
        "A revision included in this approval changed.",
      );
      const [rev] = await tx
        .insert(revisionsTable)
        .values({
          quoteId: quote.id,
          authorId: req.userId!,
          authorName: profile.name,
          note,
          categories,
        })
        .returning();
      return { revision: rev };
    });

    if ("archived" in result) {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }
    if ("noDraft" in result) {
      res.status(400).json({ error: "There is no draft to publish." });
      return;
    }

    res.status(201).json(PublishRevisionDraftResponse.parse(result.revision));
  },
);

router.get("/quotes/:id/revisions", async (req, res): Promise<void> => {
  const params = ListRevisionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const revisions = await db
    .select()
    .from(revisionsTable)
    .where(eq(revisionsTable.quoteId, params.data.id))
    .orderBy(revisionsTable.createdAt);

  res.json(ListRevisionsResponse.parse(revisions));
});

router.post(
  "/quotes/:id/revisions",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = CreateRevisionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateRevisionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;
    if (!guardNotArchived(quote, res)) return;

    const profile = await getUserProfile(req.userId!);
    // Adding a revision invalidates any existing customer signoff: the
    // signed document no longer reflects the latest revision history.
    // Lock the quote row to serialize with concurrent sign attempts.
    const revision = await db.transaction(async (tx) => {
      // Re-validate archive state under the lock: an archive may have
      // committed between the pre-transaction check and lock acquisition.
      const current = await lockQuoteRow(tx, quote.id);
      if (!current || current.archivedAt) return null;
      await invalidateApprovalCoverage(
        tx,
        quote.id,
        sanitizeRevisionCategories(parsed.data.categories, current) ?? current.categories,
        "A revision included in this approval changed.",
      );
      const [rev] = await tx
        .insert(revisionsTable)
        .values({
          quoteId: quote.id,
          authorId: req.userId!,
          authorName: profile.name,
          note: parsed.data.note,
          categories: sanitizeRevisionCategories(
            parsed.data.categories,
            current,
          ),
        })
        .returning();
      return rev;
    });

    if (!revision) {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }

    res.status(201).json(CreateRevisionResponse.parse(revision));
  },
);

router.patch(
  "/quotes/:id/revisions/:revisionId/signoff-exclusion",
  async (req, res): Promise<void> => {
    const params = SetRevisionSignoffExclusionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SetRevisionSignoffExclusionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // Only affects signoff-document visibility; the revision log is immutable.
    // Changing what the signoff sheet shows alters the document the customer
    // approved, so any existing signature is cleared atomically — the quote
    // must be re-signed. Lock the quote row to serialize with sign attempts,
    // and enforce the read-only archive policy under that lock.
    const revision = await db.transaction(async (tx) => {
      const current = await lockQuoteRow(tx, params.data.id);
      if (!current) return { kind: "notFound" as const };
      if (current.archivedAt) return { kind: "archived" as const };
      const [rev] = await tx
        .update(revisionsTable)
        .set({ excludedFromSignoff: parsed.data.excludedFromSignoff })
        .where(
          and(
            eq(revisionsTable.id, params.data.revisionId),
            eq(revisionsTable.quoteId, params.data.id),
          ),
        )
        .returning();
      if (!rev) return { kind: "notFound" as const };
      await invalidateApprovalCoverage(
        tx,
        params.data.id,
        rev.categories?.length ? rev.categories : current.categories,
        "Revision signoff inclusion changed.",
      );
      return { kind: "ok" as const, rev };
    });

    if (revision.kind === "archived") {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }
    if (revision.kind === "notFound") {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(SetRevisionSignoffExclusionResponse.parse(revision.rev));
  },
);

router.get("/quotes/:id/attachments", async (req, res): Promise<void> => {
  const params = ListAttachmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;

  const attachments = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.quoteId, quote.id))
    .orderBy(desc(attachmentsTable.createdAt));

  res.json(ListAttachmentsResponse.parse(attachments));
});

router.post(
  "/quotes/:id/attachments",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = CreateAttachmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateAttachmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [pendingUpload] = await db
      .select()
      .from(attachmentUploadsTable)
      .where(
        and(
          eq(attachmentUploadsTable.id, parsed.data.uploadId),
          eq(attachmentUploadsTable.quoteId, params.data.id),
          eq(attachmentUploadsTable.createdById, req.userId!),
        ),
      );
    if (
      !pendingUpload ||
      pendingUpload.status !== "pending" ||
      pendingUpload.expiresAt.getTime() <= Date.now()
    ) {
      res.status(409).json({ error: "This upload is invalid, expired, or already used." });
      return;
    }

    let metadata: Awaited<ReturnType<ObjectStorageService["getObjectEntityMetadata"]>>;
    try {
      metadata = await packetStorage.getObjectEntityMetadata(pendingUpload.objectPath);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(409).json({ error: "The file upload has not completed." });
        return;
      }
      throw error;
    }
    const actualContentType = normalizeAttachmentContentType(
      metadata.contentType ?? "application/octet-stream",
    );
    const declaredContentType = normalizeAttachmentContentType(
      pendingUpload.declaredContentType,
    );
    if (
      !metadata.generation ||
      metadata.size !== pendingUpload.declaredSize ||
      actualContentType !== declaredContentType
    ) {
      const claimedForCleanup = await markAttachmentUploadForCleanup(pendingUpload.id);
      if (claimedForCleanup) {
        void cleanupAttachmentUpload(pendingUpload.id).catch((error) => {
          req.log.warn({ err: error, uploadId: pendingUpload.id }, "Rejected attachment cleanup failed");
        });
      }
      res.status(422).json({ error: "The uploaded file does not match its approved size or type." });
      return;
    }
    try {
      await packetStorage.copyObjectEntityImmutable(
        pendingUpload.objectPath,
        pendingUpload.finalObjectPath,
        metadata.generation,
      );
    } catch {
      res.status(409).json({
        error: "The uploaded file changed during verification. Upload it again.",
      });
      return;
    }

    let immutableMetadata: Awaited<
      ReturnType<ObjectStorageService["getObjectEntityMetadata"]>
    >;
    let immutableBytes: Buffer;
    try {
      immutableMetadata = await packetStorage.getObjectEntityMetadata(
        pendingUpload.finalObjectPath,
      );
      immutableBytes = await packetStorage.downloadObjectBytesBounded(
        pendingUpload.finalObjectPath,
        MAX_ATTACHMENT_BYTES,
      );
    } catch (error) {
      req.log.warn(
        { err: error, uploadId: pendingUpload.id },
        "Immutable attachment validation read failed",
      );
      res.status(409).json({
        error: "The uploaded file could not be verified. Upload it again.",
      });
      return;
    }

    const immutableContentType = normalizeAttachmentContentType(
      immutableMetadata.contentType ?? "application/octet-stream",
    );
    if (
      !immutableMetadata.generation ||
      immutableMetadata.size !== pendingUpload.declaredSize ||
      immutableBytes.length !== immutableMetadata.size ||
      immutableContentType !== declaredContentType
    ) {
      const claimedForCleanup = await markAttachmentUploadForCleanup(
        pendingUpload.id,
      );
      if (claimedForCleanup) {
        void cleanupAttachmentUpload(pendingUpload.id).catch((error) => {
          req.log.warn(
            { err: error, uploadId: pendingUpload.id },
            "Rejected attachment cleanup failed",
          );
        });
      }
      res.status(422).json({
        error: "The uploaded file does not match its approved size or type.",
      });
      return;
    }

    const contentValidationError = await validateAttachmentBytes(
      pendingUpload.originalName,
      declaredContentType,
      immutableBytes,
    );
    if (contentValidationError) {
      const claimedForCleanup = await markAttachmentUploadForCleanup(
        pendingUpload.id,
      );
      if (claimedForCleanup) {
        void cleanupAttachmentUpload(pendingUpload.id).catch((error) => {
          req.log.warn(
            { err: error, uploadId: pendingUpload.id },
            "Rejected malformed attachment cleanup failed",
          );
        });
      }
      res.status(422).json({ error: contentValidationError });
      return;
    }

    const profile = await getUserProfile(req.userId!);
    const outcome = await db.transaction(async (tx) => {
      const current = await lockQuoteRow(tx, params.data.id);
      if (!current) return { kind: "notFound" as const };
      if (current.archivedAt) return { kind: "archived" as const };
      const [upload] = await tx
        .select()
        .from(attachmentUploadsTable)
        .where(
          and(
            eq(attachmentUploadsTable.id, pendingUpload.id),
            eq(attachmentUploadsTable.quoteId, current.id),
            eq(attachmentUploadsTable.createdById, req.userId!),
          ),
        )
        .for("update");
      if (
        !upload ||
        upload.status !== "pending" ||
        upload.expiresAt.getTime() <= Date.now()
      ) {
        return { kind: "invalidUpload" as const };
      }
      const [attachment] = await tx
        .insert(attachmentsTable)
        .values({
          quoteId: current.id,
          name: upload.originalName,
          objectPath: upload.finalObjectPath,
          uploadSessionId: upload.id,
          contentType: actualContentType,
          size: metadata.size,
          uploadedById: req.userId!,
          uploadedByName: profile.name,
        })
        .returning();
      await tx
        .update(attachmentUploadsTable)
        .set({ status: "source_cleanup_pending", updatedAt: new Date() })
        .where(eq(attachmentUploadsTable.id, upload.id));
      return { kind: "created" as const, attachment };
    });

    if (outcome.kind === "notFound") {
      res.status(404).json({ error: "Quote not found" });
      return;
    }
    if (outcome.kind === "archived") {
      res.status(400).json({ error: "Restore this quote before adding files." });
      return;
    }
    if (outcome.kind === "invalidUpload") {
      res.status(409).json({ error: "This upload expired or was already used." });
      return;
    }
    res.status(201).json(CreateAttachmentResponse.parse(outcome.attachment));
  },
);

router.delete(
  "/quotes/:id/attachments/:attachmentId",
  async (req, res): Promise<void> => {
    const params = DeleteAttachmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // Archived quotes are read-only: re-validate under the quote-row lock so
    // deletion cannot race an archive.
    const outcome = await db.transaction(async (tx) => {
      const current = await lockQuoteRow(tx, params.data.id);
      if (!current) return { kind: "notFound" as const };
      if (current.archivedAt) return { kind: "archived" as const };
      const [attachment] = await tx
        .delete(attachmentsTable)
        .where(
          and(
            eq(attachmentsTable.id, params.data.attachmentId),
            eq(attachmentsTable.quoteId, params.data.id),
          ),
        )
        .returning();
      if (!attachment) return { kind: "notFound" as const };
      if (attachment.uploadSessionId) {
        await tx
          .update(attachmentUploadsTable)
          .set({ status: "delete_pending", updatedAt: new Date() })
          .where(eq(attachmentUploadsTable.id, attachment.uploadSessionId));
      }
      let cleanupUploadId = attachment.uploadSessionId;
      if (!cleanupUploadId && attachment.objectPath.startsWith("/objects/uploads/")) {
        const [stillReferenced] = await tx
          .select({ id: attachmentsTable.id })
          .from(attachmentsTable)
          .where(eq(attachmentsTable.objectPath, attachment.objectPath))
          .limit(1);
        if (!stillReferenced) {
          const now = new Date();
          const tombstoneId = randomUUID();
          const [tombstone] = await tx
            .insert(attachmentUploadsTable)
            .values({
              id: tombstoneId,
              quoteId: current.id,
              objectPath: attachment.objectPath,
              finalObjectPath: attachment.objectPath,
              originalName: attachment.name,
              declaredSize: attachment.size ?? 1,
              declaredContentType: attachment.contentType ?? "application/octet-stream",
              createdById: attachment.uploadedById,
              status: "delete_pending",
              expiresAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing()
            .returning({ id: attachmentUploadsTable.id });
          cleanupUploadId = tombstone?.id;
        }
      }
      return { kind: "deleted" as const, attachment, cleanupUploadId };
    });

    if (outcome.kind === "archived") {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }
    if (outcome.kind === "notFound") {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    if (outcome.cleanupUploadId) {
      void cleanupAttachmentUpload(outcome.cleanupUploadId).catch((error) => {
        req.log.warn(
          { err: error, uploadId: outcome.cleanupUploadId },
          "Deleted attachment cleanup deferred",
        );
      });
    }
    res.sendStatus(204);
  },
);

function legacyShareLinkResponse(quote: {
  id: number;
  shareToken: string | null;
  shareTokenCreatedAt: Date | null;
  shareTokenExpiresAt: Date | null;
  shareTokenRevokedAt: Date | null;
  shareTokenRotatedFrom: string | null;
}) {
  const now = new Date();
  const status = quote.shareTokenRevokedAt
    ? "revoked" as const
    : quote.shareTokenExpiresAt && quote.shareTokenExpiresAt <= now
      ? "expired" as const
      : "active" as const;
  return {
    token: quote.shareToken ?? "",
    status,
    createdAt: quote.shareTokenCreatedAt ?? new Date(0),
    expiresAt: quote.shareTokenExpiresAt,
    revokedAt: quote.shareTokenRevokedAt,
    rotatedFrom: quote.shareTokenRotatedFrom,
    publicPath: `/public/signoff/${quote.shareToken ?? ""}`,
  };
}

function scopedApprovalResponse(
  request: typeof scopedApprovalRequestsTable.$inferSelect,
  approval: typeof scopedApprovalsTable.$inferSelect | undefined,
  snapshot: { notIncludedProductTypes?: string[] },
  invalidationReason: string | null = null,
) {
  const expired = request.expiresAt !== null && request.expiresAt <= new Date();
  const lifecycleReason = request.revocationReason ??
    (expired ? "Approval link expired." : null);
  return {
    id: request.id,
    approvalId: approval?.id ?? null,
    token: request.token,
    productTypes: request.productTypes,
    notIncludedProductTypes: snapshot.notIncludedProductTypes ?? [],
    documentVersion: request.documentVersion,
    publicPath: `/public/scoped-signoff/${request.token}`,
    status: approval && !invalidationReason
      ? "signed" as const
      : !approval && request.status === "signed"
        ? "signed" as const
      : !approval && request.status === "open" && !expired
        ? "open" as const
        : "needs_resigning" as const,
    signedAt: approval?.signedAt ?? null,
    createdAt: request.createdAt,
    createdById: request.createdById,
    expiresAt: request.expiresAt,
    revokedAt: request.revokedAt,
    revokedById: request.revokedById,
    revocationReason: request.revocationReason,
    replacedFromRequestId: request.replacedFromRequestId,
    replacementRequestId: request.replacementRequestId,
    invalidationReason: invalidationReason ?? lifecycleReason,
  };
}

router.post("/quotes/:id/share-link", async (req: AuthedRequest, res): Promise<void> => {
  const params = CreateShareLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;
  if (!guardNotArchived(quote, res)) return;

  // Atomic: SELECT FOR UPDATE prevents two simultaneous requests from each
  // generating a different token and overwriting each other.
  const token = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ shareToken: quotesTable.shareToken })
      .from(quotesTable)
      .where(eq(quotesTable.id, quote.id))
      .for("update");
    if (!locked) return null;
    if (locked.shareToken) return locked.shareToken;
    const newToken = randomBytes(24).toString("base64url");
    await tx
      .update(quotesTable)
      .set({ shareToken: newToken, shareTokenCreatedAt: new Date(), shareTokenRevokedAt: null, shareTokenRevocationReason: null })
      .where(eq(quotesTable.id, quote.id));
    await tx.insert(shareLinkAuditTable).values({
      quoteId: quote.id, token: newToken, action: "created", actorId: req.userId!,
    });
    return newToken;
  });

  if (!token) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }

  const [updated] = await db.select().from(quotesTable).where(eq(quotesTable.id, quote.id));
  res.json(CreateShareLinkResponse.parse(legacyShareLinkResponse(updated ?? quote)));
});

router.patch("/quotes/:id/share-link", async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdateShareLinkParams.safeParse(req.params);
  const body = UpdateShareLinkBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid body." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.data.id);
    if (!quote || !quote.shareToken) return null;
    if (quote.shareTokenRevokedAt) return "revoked" as const;
    await tx.update(quotesTable).set({ shareTokenExpiresAt: body.data.expiresAt })
      .where(eq(quotesTable.id, quote.id));
    return { ...quote, shareTokenExpiresAt: body.data.expiresAt };
  });
  if (!result) { res.status(404).json({ error: "Share link not found." }); return; }
  if (result === "revoked") { res.status(409).json({ error: "A revoked share link cannot be edited." }); return; }
  res.json(UpdateShareLinkResponse.parse(legacyShareLinkResponse(result)));
});

router.delete("/quotes/:id/share-link", async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdateShareLinkParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.data.id);
    if (!quote || !quote.shareToken) return "notFound" as const;
    if (quote.shareTokenRevokedAt) return "alreadyRevoked" as const;
    const now = new Date();
    await tx.update(quotesTable).set({
      shareTokenRevokedAt: now,
      shareTokenRevokedById: req.userId!,
      shareTokenRevocationReason: "Revoked by staff",
    }).where(eq(quotesTable.id, quote.id));
    await tx.insert(shareLinkAuditTable).values({
      quoteId: quote.id, token: quote.shareToken, action: "revoked",
      actorId: req.userId!, reason: "Revoked by staff", expiresAt: quote.shareTokenExpiresAt,
    });
    return "ok" as const;
  });
  if (result === "notFound") { res.status(404).json({ error: "Share link not found." }); return; }
  if (result === "alreadyRevoked") { res.status(409).json({ error: "Share link is already revoked." }); return; }
  res.sendStatus(204);
});

router.post("/quotes/:id/share-link/rotate", async (req: AuthedRequest, res): Promise<void> => {
  const params = RotateShareLinkParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.data.id);
    if (!quote || !quote.shareToken) return null;
    const oldToken = quote.shareToken;
    const token = randomBytes(24).toString("base64url");
    const now = new Date();
    await tx.update(quotesTable).set({
      shareToken: token, shareTokenCreatedAt: now, shareTokenExpiresAt: null,
      shareTokenRevokedAt: null, shareTokenRevokedById: null,
      shareTokenRevocationReason: null, shareTokenRotatedFrom: oldToken,
    }).where(eq(quotesTable.id, quote.id));
    await tx.insert(shareLinkAuditTable).values({
      quoteId: quote.id, token: oldToken, action: "rotated",
      replacementToken: token, actorId: req.userId!, expiresAt: quote.shareTokenExpiresAt,
    });
    await tx.insert(shareLinkAuditTable).values({
      quoteId: quote.id, token, action: "created", actorId: req.userId!,
    });
    return {
      ...quote, shareToken: token, shareTokenCreatedAt: now, shareTokenExpiresAt: null,
      shareTokenRevokedAt: null, shareTokenRotatedFrom: oldToken,
    };
  });
  if (!result) { res.status(404).json({ error: "Share link not found." }); return; }
  res.status(201).json(RotateShareLinkResponse.parse(legacyShareLinkResponse(result)));
});

router.get("/quotes/:id/signoff", async (req, res): Promise<void> => {
  const params = GetSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [signoff] = await db
    .select()
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, params.data.id));

  res.json(signoff ?? null);
});

/**
 * Legacy signature evidence is intentionally a separate, authenticated
 * read-only resource. It contains only fields stored on the signoff row and
 * the original quote identifiers; it never loads or serializes mutable quote
 * specifications, revisions, or a reconstructed PDF.
 */
router.get("/quotes/:id/legacy-signature", async (req, res): Promise<void> => {
  const params = GetLegacySignatureParams.safeParse(req.params);
  if (!params.success || params.data.id < 1) {
    res.status(400).json({ error: "Invalid quote id." });
    return;
  }

  const [quote] = await db
    .select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber })
    .from(quotesTable)
    .where(eq(quotesTable.id, params.data.id));
  if (!quote) {
    res.status(404).json({ error: "Quote not found." });
    return;
  }

  const [signoff] = await db
    .select()
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, quote.id));
  if (!signoff) {
    res.status(404).json({ error: "Legacy signature record not found." });
    return;
  }

  res.json(
    GetLegacySignatureResponse.parse({
      recordType: "legacy_signature_record",
      id: signoff.id,
      quoteId: signoff.quoteId,
      quoteNumber: quote.quoteNumber,
      signerName: signoff.customerName,
      signerRole: signoff.stakeholderRole,
      signatureType: signoff.signatureType,
      signatureData: signoff.signatureData,
      signatureDataValid:
        signoff.signatureType === "typed" ||
        hasMeaningfulSignatureInk(signoff.signatureData),
      signedAt: signoff.signedAt,
      validity: signoff.legacyStatus,
      invalidationReason: signoff.legacyInvalidationReason,
      signedDocumentAvailable: Boolean(signoff.signedDocumentObjectPath),
      signedDocumentPath: signoff.signedDocumentObjectPath
        ? `/api/quotes/${quote.id}/signoff/document`
        : null,
    }),
  );
});

// ---------- Scoped product-type approvals ----------
// These endpoints are intentionally hand-validated during the additive
// transition. Their OpenAPI contract is the source for generated client types;
// legacy whole-quote signoff endpoints above remain unchanged.
router.get("/quotes/:id/scoped-approvals", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid quote id." });
    return;
  }
  const quote = await loadQuote(id, res);
  if (!quote) return;
  const [requests, approvals, coverage] = await Promise.all([
    db.select().from(scopedApprovalRequestsTable).where(eq(scopedApprovalRequestsTable.quoteId, id)).orderBy(desc(scopedApprovalRequestsTable.createdAt)),
    db.select().from(scopedApprovalsTable).where(eq(scopedApprovalsTable.quoteId, id)).orderBy(desc(scopedApprovalsTable.signedAt)),
    approvalCoverage(db, quote),
  ]);
  const approvalByRequest = new Map(approvals.map((approval) => [approval.requestId, approval]));
  res.json(ListScopedApprovalsResponse.parse({
    approvals: requests.map((request) => {
      const approval = approvalByRequest.get(request.id);
      const snapshot = request.snapshot as { notIncludedProductTypes?: string[] };
      const affectedCoverage = coverage.find((row) =>
        row.approvalId === approval?.id && row.invalidationReason,
      );
      return scopedApprovalResponse(request, approval, snapshot, affectedCoverage?.invalidationReason ?? null);
    }),
    coverage,
  }));
});

router.delete("/quotes/:id/scoped-approvals/:requestId", async (req: AuthedRequest, res): Promise<void> => {
  const quoteId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  if (!Number.isInteger(quoteId) || quoteId < 1 || !Number.isInteger(requestId) || requestId < 1) {
    res.status(400).json({ error: "Invalid quote or scoped approval request id." });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, quoteId);
    if (!quote) return "notFound" as const;
    const [request] = await tx
      .select({
        id: scopedApprovalRequestsTable.id,
        status: scopedApprovalRequestsTable.status,
        revokedAt: scopedApprovalRequestsTable.revokedAt,
      })
      .from(scopedApprovalRequestsTable)
      .where(and(eq(scopedApprovalRequestsTable.id, requestId), eq(scopedApprovalRequestsTable.quoteId, quoteId)))
      .for("update");
    if (!request) return "notFound" as const;
    if (request.revokedAt || !["open", "signed"].includes(request.status)) return "notOpen" as const;
    const revokedAt = new Date();
    await tx.update(scopedApprovalRequestsTable).set({
      // Signed status is immutable evidence state. Revoking only closes public
      // access; it never changes or deletes the signed approval/PDF.
      status: request.status === "signed" ? "signed" : "revoked",
      revokedAt,
      revokedById: req.userId!,
      revocationReason: "Revoked by staff",
    })
      .where(eq(scopedApprovalRequestsTable.id, request.id));
    return "ok" as const;
  });
  if (outcome === "notFound") { res.status(404).json({ error: "Scoped approval request not found." }); return; }
  if (outcome === "notOpen") { res.status(409).json({ error: "Only an open or signed scoped approval request can be revoked." }); return; }
  res.sendStatus(204);
});

router.patch("/quotes/:id/scoped-approvals/:requestId", async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdateScopedApprovalLinkParams.safeParse(req.params);
  const body = UpdateScopedApprovalLinkBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid body." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.data.id);
    if (!quote) return { kind: "notFound" as const };
    const [request] = await tx.select().from(scopedApprovalRequestsTable)
      .where(and(eq(scopedApprovalRequestsTable.id, params.data.requestId), eq(scopedApprovalRequestsTable.quoteId, quote.id)))
      .for("update");
    if (!request) return { kind: "notFound" as const };
    if (!["open", "signed"].includes(request.status) || request.revokedAt) return { kind: "closed" as const };
    const [updated] = await tx.update(scopedApprovalRequestsTable)
      .set({ expiresAt: body.data.expiresAt })
      .where(eq(scopedApprovalRequestsTable.id, request.id))
      .returning();
    const [approval] = await tx.select().from(scopedApprovalsTable)
      .where(eq(scopedApprovalsTable.requestId, request.id));
    return {
      kind: "ok" as const,
      request: updated!,
      approval,
      snapshot: request.snapshot as { notIncludedProductTypes?: string[] },
    };
  });
  if (result.kind === "notFound") { res.status(404).json({ error: "Scoped approval request not found." }); return; }
  if (result.kind === "closed") { res.status(409).json({ error: "Only an open or signed scoped approval link can be edited." }); return; }
  res.json(UpdateScopedApprovalLinkResponse.parse(scopedApprovalResponse(result.request, result.approval, result.snapshot)));
});

router.post("/quotes/:id/scoped-approvals/:requestId/rotate", async (req: AuthedRequest, res): Promise<void> => {
  const params = RotateScopedApprovalLinkParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.data.id);
    if (!quote) return { kind: "notFound" as const };
    const [request] = await tx.select().from(scopedApprovalRequestsTable)
      .where(and(eq(scopedApprovalRequestsTable.id, params.data.requestId), eq(scopedApprovalRequestsTable.quoteId, quote.id)))
      .for("update");
    if (!request) return { kind: "notFound" as const };
    if (request.status !== "open") return { kind: "closed" as const };
    const now = new Date();
    const token = randomBytes(24).toString("base64url");
    const replacementExpiry = request.expiresAt && request.expiresAt > now ? request.expiresAt : null;
    await tx.update(scopedApprovalRequestsTable).set({
      status: "revoked", revokedAt: now, revokedById: req.userId!,
      revocationReason: "Rotated by staff",
    }).where(eq(scopedApprovalRequestsTable.id, request.id));
    const [replacement] = await tx.insert(scopedApprovalRequestsTable).values({
      quoteId: request.quoteId,
      token,
      productTypes: request.productTypes,
      snapshot: request.snapshot,
      documentVersion: request.documentVersion,
      status: "open",
      createdById: req.userId!,
      expiresAt: replacementExpiry,
      replacedFromRequestId: request.id,
    }).returning();
    await tx.update(scopedApprovalRequestsTable).set({ replacementRequestId: replacement!.id })
      .where(eq(scopedApprovalRequestsTable.id, request.id));
    return {
      kind: "ok" as const,
      request: { ...replacement!, replacementRequestId: null },
      snapshot: replacement!.snapshot as { notIncludedProductTypes?: string[] },
    };
  });
  if (result.kind === "notFound") { res.status(404).json({ error: "Scoped approval request not found." }); return; }
  if (result.kind === "closed") { res.status(409).json({ error: "Only an open scoped approval link can be rotated." }); return; }
  res.status(201).json(RotateScopedApprovalLinkResponse.parse(scopedApprovalResponse(result.request, undefined, result.snapshot)));
});

router.post("/quotes/:id/scoped-approvals", async (req: AuthedRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const rawScope = (req.body as { productTypes?: unknown } | undefined)?.productTypes;
  if (!Number.isInteger(id) || id < 1 || !Array.isArray(rawScope)) {
    res.status(400).json({ error: "A non-empty productTypes array is required." });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, id);
    if (!quote) return { kind: "notFound" as const };
    if (quote.archivedAt) return { kind: "archived" as const };
    const productTypes = normalizedScope(rawScope, quote);
    if (!productTypes) return { kind: "invalid" as const };
    const open = await tx.select({ productTypes: scopedApprovalRequestsTable.productTypes })
      .from(scopedApprovalRequestsTable)
      .where(and(
        eq(scopedApprovalRequestsTable.quoteId, id),
        eq(scopedApprovalRequestsTable.status, "open"),
        isNull(scopedApprovalRequestsTable.revokedAt),
        or(
          isNull(scopedApprovalRequestsTable.expiresAt),
          gt(scopedApprovalRequestsTable.expiresAt, new Date()),
        ),
      ));
    if (open.some((request) => request.productTypes.some((type) => productTypes.includes(type)))) {
      return { kind: "overlap" as const };
    }
    const built = await buildScopedSnapshot(tx, quote, productTypes);
    if (built.unclassifiedPacket) return { kind: "unclassified" as const };
    const documentVersion = scopedDocumentVersion(built.snapshot);
    const token = randomBytes(24).toString("base64url");
    const [request] = await tx.insert(scopedApprovalRequestsTable).values({
      quoteId: id, token, productTypes, snapshot: built.snapshot, documentVersion,
      createdById: req.userId!,
    }).returning();
    return { kind: "ok" as const, request: request!, snapshot: built.snapshot };
  });
  if (outcome.kind === "notFound") { res.status(404).json({ error: "Quote not found" }); return; }
  if (outcome.kind === "archived") { res.status(400).json({ error: "This quote is archived. Restore it to request approval." }); return; }
  if (outcome.kind === "invalid") { res.status(400).json({ error: "productTypes must be a unique non-empty subset of this quote's product types." }); return; }
  if (outcome.kind === "unclassified") { res.status(400).json({ error: "Assign a product type to every approved manufacturer packet before creating a scoped approval." }); return; }
  if (outcome.kind === "overlap") { res.status(409).json({ error: "An open scoped approval already overlaps one or more selected product types." }); return; }
  res.status(201).json(CreateScopedApprovalResponse.parse(
    scopedApprovalResponse(outcome.request, undefined, outcome.snapshot),
  ));
});

router.put("/quotes/:id/signoff", async (req, res): Promise<void> => {
  const params = SaveSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SaveSignoffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const validated = validateSignoffSubmission(parsed.data);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;
  if (!guardNotArchived(quote, res)) return;

  // Reject stale submissions: the document the signer loaded must still
  // match the current content (quote edits, new revisions, exclusions).
  // The quote row is locked and re-read inside the transaction so the
  // version check cannot race a concurrent mutation.
  const prepared = await db.transaction(async (tx) => {
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
    return { current, revisions, approvedPacket, signedAt: new Date(), version: parsed.data.documentVersion };
  });

  if (prepared === "alreadySigned") {
    res.status(409).json({
      error: "This legacy signoff is immutable. Create a new scoped approval for a replacement signature.",
    });
    return;
  }
  if (!prepared) {
    res.status(409).json({
      error:
        "This document has changed since it was loaded. Please refresh and review the latest version before signing.",
    });
    return;
  }

  const signedDocumentObjectPath = `/objects/signoff-documents/${quote.id}/${randomUUID()}.pdf`;
  try {
    const signedDocument = await createSignedPacketDocument({
      quote: prepared.current,
      revisions: prepared.revisions,
      signoff: {
        customerName: validated.customerName,
        stakeholderRole: parsed.data.stakeholderRole,
        signatureType: parsed.data.signatureType,
        signatureData: validated.signatureData,
        signedAt: prepared.signedAt,
      },
      approvedPacketPages: await loadManifestPdfPages(prepared.approvedPacket),
    });
    await packetStorage.saveObjectEntityImmutable(
      signedDocumentObjectPath,
      signedDocument.bytes,
      "application/pdf",
    );
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
      if (computeDocumentVersion(current, included, approvedPacket) !== prepared.version) return null;
      const [row] = await tx.insert(signoffsTable).values({
        quoteId: quote.id,
        customerName: validated.customerName,
        stakeholderRole: parsed.data.stakeholderRole,
        signatureType: parsed.data.signatureType,
        signatureData: validated.signatureData,
        signedPacketId: approvedPacket[0]?.packetId ?? null,
        signedPacketSha256: hashApprovedManifest(approvedPacket),
        signedDocumentObjectPath,
        signedDocumentSha256: signedDocument.sha256,
        signedAt: prepared.signedAt,
      }).returning();
      return row;
    });
    if (signoff === "alreadySigned") {
      await cleanupUploadedDocumentIfUnreferenced(signedDocumentObjectPath);
      res.status(409).json({
        error: "This legacy signoff is immutable. Create a new scoped approval for a replacement signature.",
      });
      return;
    }
    if (!signoff) {
      await cleanupUploadedDocumentIfUnreferenced(signedDocumentObjectPath);
      res.status(409).json({
        error: "This document has changed since it was loaded. Please refresh and review the latest version before signing.",
      });
      return;
    }
    res.json(SaveSignoffResponse.parse(signoff));
  } catch (error) {
    try { await cleanupUploadedDocumentIfUnreferenced(signedDocumentObjectPath); } catch (cleanupError) {
      req.log.warn({ err: cleanupError, path: signedDocumentObjectPath }, "Unable to clean up unreferenced legacy signoff PDF");
    }
    throw error;
  }
});

router.delete("/quotes/:id/signoff", async (req, res): Promise<void> => {
  const params = ClearSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.transaction(async (tx) => {
    const quote = await lockQuoteRow(tx, params.data.id);
    if (!quote) return;
    await invalidateLegacyApproval(tx, quote.id, "Legacy approval was withdrawn; original evidence is retained.");
  });

  res.sendStatus(204);
});

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const [quoteCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(quotesTable);
  const [revisionCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(revisionsTable);
  // A current scoped approval is complete only when every active quote type
  // has signed coverage. Keep historical whole-quote signoffs in this summary
  // as explicit legacy coverage; do not require or infer per-type rows for
  // them. This is deliberately a quote count, not an approval-row count, so a
  // combined approval (or replacement approval) cannot inflate the dashboard.
  const [signedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(quotesTable)
    .where(
      or(
        exists(
          db
            .select({ one: sql`1` })
            .from(signoffsTable)
            .where(and(eq(signoffsTable.quoteId, quotesTable.id), eq(signoffsTable.legacyStatus, "signed"))),
        ),
        sql`NOT EXISTS (
          SELECT 1 FROM unnest(${quotesTable.categories}) AS required_type
          LEFT JOIN scoped_approval_coverage coverage
            ON coverage.quote_id = ${quotesTable.id}
            AND coverage.product_type = required_type
            AND coverage.status = 'signed'
          WHERE coverage.id IS NULL
        )`,
      )!,
    );

  const totalQuotes = quoteCount?.count ?? 0;
  const signedQuotes = signedCount?.count ?? 0;

  res.json(
    GetDashboardSummaryResponse.parse({
      totalQuotes,
      totalRevisions: revisionCount?.count ?? 0,
      signedQuotes,
      quotesAwaitingSignoff: totalQuotes - signedQuotes,
    }),
  );
});

router.get("/activity/recent", async (req: AuthedRequest, res): Promise<void> => {
  const query = GetRecentActivityQueryParams.safeParse(req.query);
  const limit = Math.min(query.success ? (query.data.limit ?? 10) : 10, 50);
  const mine = query.success ? query.data.mine === true : false;

  const rows = await db
    .select({
      id: revisionsTable.id,
      quoteId: revisionsTable.quoteId,
      quoteNumber: quotesTable.quoteNumber,
      customerName: quotesTable.customerName,
      projectName: quotesTable.projectName,
      authorName: revisionsTable.authorName,
      note: revisionsTable.note,
      createdAt: revisionsTable.createdAt,
    })
    .from(revisionsTable)
    .innerJoin(quotesTable, eq(revisionsTable.quoteId, quotesTable.id))
    .where(mine ? eq(quotesTable.createdById, req.userId!) : undefined)
    .orderBy(desc(revisionsTable.createdAt))
    .limit(limit);

  res.json(GetRecentActivityResponse.parse(rows));
});

export default router;
