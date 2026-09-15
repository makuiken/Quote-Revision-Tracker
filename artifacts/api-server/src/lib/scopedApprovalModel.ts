import { createHash } from "node:crypto";

/** Pure scope validation shared by routes and focused unit coverage. */
export function normalizeProductScope(input: unknown, categories: readonly string[]): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.some((type) => typeof type !== "string")) return null;
  const types = [...new Set(input)];
  return types.length === input.length && types.every((type) => categories.includes(type)) ? types : null;
}

/** Hash the locked, relevant content; unrelated quote timestamps are excluded. */
export function hashLockedScopedContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Revoked/expired scoped links must not disclose any locked detail/documents,
 * including after the request has been signed. */
export function canAccessScopedPublicToken(
  status: string,
  expiresAt: Date | string | null = null,
  now = new Date(),
  revokedAt: Date | string | null = null,
): boolean {
  return status !== "revoked" &&
    !revokedAt &&
    (!expiresAt || new Date(expiresAt).getTime() > now.getTime());
}

export type ApprovalReceiptInput = {
  signerName: string;
  signerRole: string;
  signedAt: Date;
  quoteId: number;
  quoteNumber: string;
  signedDocumentPath: string | null;
  approvalScope: string[];
  current: boolean;
  reason?: string | null;
};

export function buildApprovalReceipt(input: ApprovalReceiptInput) {
  return {
    signerName: input.signerName,
    signerRole: input.signerRole,
    signedAt: input.signedAt,
    quoteId: input.quoteId,
    quoteNumber: input.quoteNumber,
    signedDocumentAvailable: Boolean(input.signedDocumentPath),
    signedDocumentPath: input.signedDocumentPath,
    approvalScope: input.approvalScope,
    status: input.current ? "current" as const : "outdated" as const,
    reason: input.reason ?? null,
  };
}

/**
 * Pure finalization gate used after an expensive render/upload. The database
 * transaction still owns the row locks; this keeps the exact stale and
 * idempotent decisions easy to exercise without object storage in unit tests.
 */
export function scopedApprovalFinalizationDecision(input: {
  existingApproval: boolean;
  submittedVersion: string;
  currentVersion: string;
  preparedSnapshotFingerprint: string;
  currentSnapshotFingerprint: string;
}): "ready" | "stale" | "alreadySigned" {
  if (input.existingApproval) return "alreadySigned";
  if (
    input.submittedVersion !== input.currentVersion ||
    input.preparedSnapshotFingerprint !== input.currentSnapshotFingerprint
  ) {
    return "stale";
  }
  return "ready";
}

/** Both new snapshots and historical public reads omit excluded revisions. */
export function publicScopedRevisions<T extends { excludedFromSignoff: boolean }>(revisions: T[]): T[] {
  return revisions.filter((revision) => !revision.excludedFromSignoff);
}