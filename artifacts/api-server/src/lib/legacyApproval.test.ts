import assert from "node:assert/strict";
import test from "node:test";
import { legacyApprovalMetadata } from "./legacyApproval";

test("legacy approval metadata exposes validity without signature HTML fields", () => {
  const value = legacyApprovalMetadata({
    legacyStatus: "needs_resigning",
    signedAt: new Date("2026-01-01T00:00:00Z"),
    signedDocumentObjectPath: null,
    legacyInvalidationReason: "Shared quote details changed.",
  });
  assert.deepEqual(value, {
    status: "legacy",
    validity: "needs_resigning",
    signedAt: new Date("2026-01-01T00:00:00Z"),
    documentAvailable: false,
    invalidationReason: "Shared quote details changed.",
  });
  assert.equal("signatureData" in value!, false);
});