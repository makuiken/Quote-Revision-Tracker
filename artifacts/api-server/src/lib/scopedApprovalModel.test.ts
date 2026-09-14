import assert from "node:assert/strict";
import test from "node:test";
import {
  canAccessScopedPublicToken,
  hashLockedScopedContent,
  normalizeProductScope,
  publicScopedRevisions,
  scopedApprovalFinalizationDecision,
} from "./scopedApprovalModel";

test("scoped product type validation rejects duplicates and unrelated types", () => {
  assert.deepEqual(normalizeProductScope(["windows", "interiorDoors"], ["windows", "interiorDoors"]), ["windows", "interiorDoors"]);
  assert.equal(normalizeProductScope([], ["windows"]), null);
  assert.equal(normalizeProductScope(["windows", "windows"], ["windows"]), null);
  assert.equal(normalizeProductScope(["windows"], ["interiorDoors"]), null);
});

test("locked scope hashes distinguish selected pages and revisions", () => {
  const base = { types: ["windows"], revisions: [1], pages: [{ packetId: 7, pageNumber: 1, sha: "a" }] };
  assert.equal(hashLockedScopedContent(base), hashLockedScopedContent({ ...base }));
  assert.notEqual(hashLockedScopedContent(base), hashLockedScopedContent({ ...base, pages: [{ packetId: 7, pageNumber: 2, sha: "a" }] }));
  assert.notEqual(hashLockedScopedContent(base), hashLockedScopedContent({ ...base, revisions: [2] }));
});

test("a scoped request pins its prepared date for stale-signature comparison", () => {
  const locked = {
    preparedAt: "2026-01-01T12:00:00.000Z",
    types: ["windows"],
    pages: [],
  };
  // Rebuilding current relevant content with the request's preparedAt gives
  // the same version; minting a new render date correctly does not.
  assert.equal(hashLockedScopedContent(locked), hashLockedScopedContent({ ...locked }));
  assert.notEqual(
    hashLockedScopedContent(locked),
    hashLockedScopedContent({ ...locked, preparedAt: "2026-01-01T12:00:01.000Z" }),
  );
});

test("revoked scoped tokens cannot access any public scoped route", () => {
  assert.equal(canAccessScopedPublicToken("open"), true);
  assert.equal(canAccessScopedPublicToken("stale"), true);
  assert.equal(canAccessScopedPublicToken("revoked"), false);
});

test("excluded revisions never enter scoped public snapshots", () => {
  assert.deepEqual(
    publicScopedRevisions([
      { note: "include", excludedFromSignoff: false },
      { note: "do not disclose", excludedFromSignoff: true },
    ]),
    [{ note: "include", excludedFromSignoff: false }],
  );
});

test("a stale scoped render is rejected after its upload, while a concurrent second approval is idempotent", () => {
  const base = {
    existingApproval: false,
    submittedVersion: "v1",
    currentVersion: "v1",
    preparedSnapshotFingerprint: "snapshot-a",
    currentSnapshotFingerprint: "snapshot-a",
  };
  assert.equal(
    scopedApprovalFinalizationDecision({
      ...base,
      currentVersion: "v2",
    }),
    "stale",
  );
  assert.equal(
    scopedApprovalFinalizationDecision({
      ...base,
      existingApproval: true,
    }),
    "alreadySigned",
  );
  assert.equal(
    scopedApprovalFinalizationDecision({
      ...base,
      existingApproval: false,
    }),
    "ready",
  );
});