export type LegacyApprovalMetadata = {
  status: "legacy";
  validity: "signed" | "needs_resigning";
  signedAt: Date;
  documentAvailable: boolean;
  invalidationReason: string | null;
};

/** Legacy signatures are PDF-only evidence, never current mutable HTML data. */
export function legacyApprovalMetadata(signoff: {
  legacyStatus: "signed" | "needs_resigning";
  signedAt: Date;
  signedDocumentObjectPath: string | null;
  legacyInvalidationReason: string | null;
} | null): LegacyApprovalMetadata | null {
  if (!signoff) return null;
  return {
    status: "legacy",
    validity: signoff.legacyStatus,
    signedAt: signoff.signedAt,
    documentAvailable: Boolean(signoff.signedDocumentObjectPath),
    invalidationReason: signoff.legacyInvalidationReason,
  };
}