import { createHash } from "node:crypto";

/** Fingerprint the exact ordered immutable packet selection covered by a signature. */
export function hashApprovedManifest(entries: ReadonlyArray<{
  packetId: number;
  pageNumber: number;
  pageOrder: number;
  sanitizedPdfSha256: string | null;
}>): string {
  return createHash("sha256").update(JSON.stringify(
    entries.map(({ packetId, pageNumber, pageOrder, sanitizedPdfSha256 }) => ({
      packetId, pageNumber, pageOrder, sanitizedPdfSha256,
    })),
  )).digest("hex");
}