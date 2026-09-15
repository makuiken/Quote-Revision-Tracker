import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  manufacturerPacketsTable,
  manufacturerPacketManifestTable,
  quotesTable,
  revisionsTable,
  scopedApprovalCoverageTable,
  scopedApprovalRequestsTable,
  signoffsTable,
  type Quote,
  type Revision,
} from "@workspace/db";
import { loadManifestPdfPages } from "../routes/quotes";
import { hashLockedScopedContent, normalizeProductScope, publicScopedRevisions } from "./scopedApprovalModel";
import { projectScopedPublicQuote, type ScopedPublicQuote } from "./scopedPublicQuote";

// Bump alongside changes to signoffDocument terms/layout. Scoped documents use
// an independently locked render date, so these values must participate in the
// token's content fingerprint as well.
export const SCOPED_APPROVAL_CONTENT_VERSION = 3;
export const SCOPED_APPROVAL_DOCUMENT_FORMAT_VERSION = 2;

export type ScopedSnapshot = {
  quote: ScopedPublicQuote;
  revisions: Revision[];
  manifest: Array<{
    packetId: number;
    pageNumber: number;
    pageOrder: number;
    productType: string;
    sanitizedPdfObjectPath: string;
    sanitizedPdfSha256: string | null;
    pagePath: string[] | null;
    approvedAt: Date | null;
  }>;
  productTypes: string[];
  notIncludedProductTypes: string[];
  preparedAt: string;
};

export const productTypeLabel = (type: string) =>
  ({
    windows: "Windows",
    doors: "Doors (Legacy)",
    interiorDoors: "Interior Doors",
    exteriorDoors: "Exterior Doors",
    trim: "Moulding",
    millwork: "Millwork",
  })[type] ?? type;

export function normalizedScope(input: unknown, quote: Pick<Quote, "categories">): string[] | null {
  return normalizeProductScope(input, quote.categories);
}


function stableSnapshotJson(snapshot: ScopedSnapshot): string {
  return JSON.stringify({
    productTypes: snapshot.productTypes,
    notIncludedProductTypes: snapshot.notIncludedProductTypes,
    preparedAt: snapshot.preparedAt,
    quote: {
      quoteNumber: snapshot.quote.quoteNumber,
      customerName: snapshot.quote.customerName,
      projectName: snapshot.quote.projectName,
      jobAddress: snapshot.quote.jobAddress,
      categories: snapshot.quote.categories,
      specs: snapshot.quote.specs,
      notes: snapshot.quote.notes,
    },
    revisions: snapshot.revisions.map((r) => ({
      id: r.id,
      note: r.note,
      categories: r.categories,
      excludedFromSignoff: r.excludedFromSignoff,
      createdAt: r.createdAt.toISOString(),
    })),
    // Snapshot manifests are normalized by selected product-type order and
    // then each type's relative page order. Absolute quote-wide positions
    // would make moving Doors around Windows invalidate a Windows-only link.
    manifest: snapshot.manifest.map((m, scopedOrder) => ({
      packetId: m.packetId,
      pageNumber: m.pageNumber,
      pageOrder: scopedOrder,
      productType: m.productType,
      sha256: m.sanitizedPdfSha256,
      // The immutable path is included in the hash so a rerender/replacement
      // with equal metadata cannot be mistaken for reviewed bytes.
      path: m.sanitizedPdfObjectPath,
    })),
    contentVersion: SCOPED_APPROVAL_CONTENT_VERSION,
    documentFormatVersion: SCOPED_APPROVAL_DOCUMENT_FORMAT_VERSION,
  });
}

export function scopedDocumentVersion(snapshot: ScopedSnapshot): string {
  return hashLockedScopedContent(JSON.parse(stableSnapshotJson(snapshot)));
}

/** Must be called while the parent quote row is locked. */
export async function buildScopedSnapshot(
  tx: Pick<typeof db, "select">,
  quote: Quote,
  productTypes: string[],
  preparedAt = new Date().toISOString(),
): Promise<{ snapshot: ScopedSnapshot; unclassifiedPacket: boolean }> {
  const packets = await tx
    .select({
      id: manufacturerPacketsTable.id,
      productType: manufacturerPacketsTable.productType,
      status: manufacturerPacketsTable.status,
    })
    .from(manufacturerPacketsTable)
    .where(eq(manufacturerPacketsTable.quoteId, quote.id));
  // An approved legacy packet is potentially relevant but cannot be safely
  // placed in a scope. Refuse issuance rather than disclose or omit it by
  // guessing.
  const unclassifiedPacket = packets.some(
    (packet) => packet.status === "approved" && !packet.productType,
  );
  const manifest = await tx
    .select({
      packetId: manufacturerPacketManifestTable.packetId,
      pageNumber: manufacturerPacketManifestTable.pageNumber,
      pageOrder: manufacturerPacketManifestTable.pageOrder,
      productType: manufacturerPacketsTable.productType,
      sanitizedPdfObjectPath: manufacturerPacketsTable.sanitizedPdfObjectPath,
      sanitizedPdfSha256: manufacturerPacketsTable.sanitizedPdfSha256,
      pagePath: manufacturerPacketsTable.sanitizedPageObjectPaths,
      approvedAt: manufacturerPacketsTable.approvedAt,
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
        inArray(manufacturerPacketsTable.productType, productTypes),
      ),
    )
    .orderBy(manufacturerPacketManifestTable.pageOrder);
  const revisions = await tx
    .select()
    .from(revisionsTable)
    .where(eq(revisionsTable.quoteId, quote.id))
    .orderBy(revisionsTable.createdAt);
  return {
    unclassifiedPacket,
    snapshot: {
      quote: projectScopedPublicQuote(quote, productTypes),
      revisions: publicScopedRevisions(revisions).filter(
        (revision) =>
          !revision.excludedFromSignoff &&
          (!revision.categories?.length ||
            revision.categories.some((category) => productTypes.includes(category))),
      ),
      manifest: productTypes.flatMap((productType) =>
        manifest.filter(
          (entry): entry is typeof entry & { productType: string; sanitizedPdfObjectPath: string } =>
            entry.productType === productType && !!entry.sanitizedPdfObjectPath,
        ),
      ).map((entry, scopedOrder) => ({
        ...entry,
        // Rendering uses this normalized order as well as hashing it.
        pageOrder: scopedOrder,
      })),
      productTypes,
      notIncludedProductTypes: quote.categories.filter((type) => !productTypes.includes(type)),
      preparedAt,
    },
  };
}

export async function loadScopedManifestPdfPages(snapshot: ScopedSnapshot) {
  // Same bounded, private-object reader as the legacy document path. It only
  // receives manifest entries captured by the request's immutable snapshot.
  return loadManifestPdfPages(snapshot.manifest);
}

export async function invalidateApprovalCoverage(
  tx: Pick<typeof db, "select" | "update">,
  quoteId: number,
  productTypes: string[],
  reason: string,
): Promise<void> {
  if (!productTypes.length) return;
  await invalidateLegacyApproval(tx, quoteId, reason);
  // A request has a locked snapshot. Mark only requests touching the mutation
  const openRequests = await tx.select({
    id: scopedApprovalRequestsTable.id,
    productTypes: scopedApprovalRequestsTable.productTypes,
  }).from(scopedApprovalRequestsTable).where(
    and(
      eq(scopedApprovalRequestsTable.quoteId, quoteId),
      eq(scopedApprovalRequestsTable.status, "open"),
    ),
  );
  const staleIds = openRequests
    .filter((request) => request.productTypes.some((type) => productTypes.includes(type)))
    .map((request) => request.id);
  if (staleIds.length) {
    await tx.update(scopedApprovalRequestsTable).set({ status: "stale" })
      .where(inArray(scopedApprovalRequestsTable.id, staleIds));
  }
  await tx
    .update(scopedApprovalCoverageTable)
    .set({
      status: "needs_resigning",
      invalidatedAt: new Date(),
      invalidationReason: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scopedApprovalCoverageTable.quoteId, quoteId),
        inArray(scopedApprovalCoverageTable.productType, productTypes),
        eq(scopedApprovalCoverageTable.status, "signed"),
      ),
    );
}

/** Invalidates whole-quote legacy current status without inventing a type scope. */
export async function invalidateLegacyApproval(
  tx: Pick<typeof db, "update">,
  quoteId: number,
  reason: string,
): Promise<void> {
  // A historical whole-quote approval has no trustworthy type decomposition.
  // Any relevant published change invalidates its *current* legacy coverage,
  // while preserving its signature and immutable document fields intact.
  await tx
    .update(signoffsTable)
    .set({
      legacyStatus: "needs_resigning",
      legacyInvalidatedAt: new Date(),
      legacyInvalidationReason: reason,
    })
    .where(
      and(
        eq(signoffsTable.quoteId, quoteId),
        eq(signoffsTable.legacyStatus, "signed"),
      ),
    );
}

export async function approvalCoverage(tx: Pick<typeof db, "select">, quote: Quote) {
  const existing = await tx
    .select()
    .from(scopedApprovalCoverageTable)
    .where(eq(scopedApprovalCoverageTable.quoteId, quote.id));
  const byType = new Map(existing.map((row) => [row.productType, row]));
  return quote.categories.map((productType) => {
    const row = byType.get(productType);
    return {
      productType,
      status: row?.status ?? "open",
      approvalId: row?.approvalId ?? null,
      invalidationReason: row?.invalidationReason ?? null,
      invalidatedAt: row?.invalidatedAt ?? null,
    };
  });
}