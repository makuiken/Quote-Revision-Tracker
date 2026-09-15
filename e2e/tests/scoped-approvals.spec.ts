import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "../../artifacts/api-server/node_modules/pdf-lib/cjs/index.js";
import pg from "pg";
import { TEST_USER_EMAIL } from "../test-user";

/**
 * Task 29 API regression coverage.
 *
 * The browser is used only to establish the Clerk ticket session. Requests
 * below use that authenticated browser-context API client, except where an
 * intentionally anonymous public-link request is required.
 */

type ProductType = "windows" | "interiorDoors" | "exteriorDoors";
type ApprovalStatus = "open" | "signed" | "needs_resigning";

type QuoteDetail = {
  quote: { id: number; categories: ProductType[] };
  documentVersion: string;
  approvalCoverage: ApprovalCoverage[];
  revisions: Array<{
    note: string;
    categories: ProductType[] | null;
  }>;
};

type ScopedApproval = {
  /** Mutable customer-request row ID. */
  id: number;
  /** Immutable signed snapshot ID; null until the request is signed. */
  approvalId: number | null;
  token: string;
  productTypes: ProductType[];
  notIncludedProductTypes: ProductType[];
  documentVersion: string;
  publicPath: string;
  status: ApprovalStatus;
  revokedAt: string | null;
};

type ScopedApprovalList = {
  approvals: ScopedApproval[];
  coverage: ApprovalCoverage[];
};

type ApprovalCoverage = {
  productType: ProductType;
  status: ApprovalStatus;
  approvalId: number | null;
  invalidationReason: string | null;
};

type ScopedPublicDetail = {
  quote: {
    categories: ProductType[];
    specs: Record<string, unknown>;
  };
  revisions: Array<{
    note: string;
    categories: ProductType[] | null;
  }>;
  productTypes: ProductType[];
  notIncludedProductTypes: ProductType[];
  documentVersion: string;
  status: ApprovalStatus;
  signoff: unknown;
};

type Packet = {
  id: number;
  status: "awaiting_upload" | "queued" | "processing" | "needs_review" | "ready_for_approval" | "approved" | "failed";
  productType?: ProductType | null;
};

const apiPath = (path: string): string => `/api${path}`;
const createdQuoteIds = new Set<number>();

test.describe.serial("scoped approval API contract", () => {
  // Public scoped signing is intentionally limited to 10 attempts per minute
  // per IP. A shared full-suite IP can legitimately make a valid test submit
  // wait for one server-advertised window.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await authenticateApiContext(page);
  });

  test.afterEach(async ({ page }) => {
    const quoteIds = [...createdQuoteIds];
    createdQuoteIds.clear();
    for (const quoteId of quoteIds) {
      const deleted = await page.context().request.delete(
        apiPath(`/quotes/${quoteId}`),
      );
      expect(deleted.status()).toBe(204);
    }
  });

  test("signs one type, signs the combined remainder, and refreshes dashboard coverage and snapshots", async ({
    page,
  }) => {
    const api = page.context().request;
    const beforeCreate = await getDashboardSummary(api);
    const quoteId = await createScopedQuote(api);
    const afterCreate = await getDashboardSummary(api);
    expect(afterCreate.totalQuotes).toBe(beforeCreate.totalQuotes + 1);
    expect(afterCreate.quotesAwaitingSignoff).toBe(
      beforeCreate.quotesAwaitingSignoff + 1,
    );

    // Scope validation is server-side; a client cannot manufacture a type not
    // on the quote or inflate a scope with duplicate entries.
    for (const productTypes of [
      [],
      ["windows", "windows"],
      ["trim"],
    ]) {
      const invalid = await api.post(apiPath(`/quotes/${quoteId}/scoped-approvals`), {
        data: { productTypes },
      });
      expect(invalid.status()).toBe(400);
    }

    const windows = await createScopedApproval(api, quoteId, ["windows"]);
    expect(windows.notIncludedProductTypes).toEqual([
      "interiorDoors",
      "exteriorDoors",
    ]);
    expect(windows.publicPath).toBe(
      `/public/scoped-signoff/${windows.token}`,
    );

    const windowsPublic = await getScopedPublicDetail(api, windows.token);
    expect(windowsPublic.productTypes).toEqual(["windows"]);
    expect(windowsPublic.notIncludedProductTypes).toEqual([
      "interiorDoors",
      "exteriorDoors",
    ]);
    expect(windowsPublic.signoff).toBeNull();
    await signScopedApproval(api, windows.token, windowsPublic.documentVersion);

    let detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "signed",
      interiorDoors: "open",
      exteriorDoors: "open",
    });
    await expectQuoteInDashboardStatus(api, "partial", quoteId);

    // The remaining categories can be intentionally presented as one combined
    // customer approval without re-requesting the completed Windows scope.
    const remaining = await createScopedApproval(api, quoteId, [
      "interiorDoors",
      "exteriorDoors",
    ]);
    const remainingPublic = await getScopedPublicDetail(api, remaining.token);
    expect(remainingPublic.productTypes).toEqual([
      "interiorDoors",
      "exteriorDoors",
    ]);
    expect(remainingPublic.notIncludedProductTypes).toEqual(["windows"]);
    await signScopedApproval(api, remaining.token, remainingPublic.documentVersion);

    detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "signed",
      interiorDoors: "signed",
      exteriorDoors: "signed",
    });
    await expectQuoteInDashboardStatus(api, "signed", quoteId);

    // A dashboard refresh reports a quote as signed only once every active
    // product type is covered. The API count is the reliable assertion behind
    // the dashboard's refresh UI.
    const afterSigning = await getDashboardSummary(api);
    expect(afterSigning.signedQuotes).toBe(beforeCreate.signedQuotes + 1);
    expect(afterSigning.quotesAwaitingSignoff).toBe(
      beforeCreate.quotesAwaitingSignoff,
    );

    // Both customer and employee download routes must return the same
    // immutable signed snapshot, and the employee route is keyed by approval
    // ID rather than a caller-selected product-type query.
    const signedRemaining = await approvalForToken(api, quoteId, remaining.token);
    expect(signedRemaining.status).toBe("signed");
    const signedRemainingId = signedSnapshotId(signedRemaining);
    const internalSnapshot = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${signedRemainingId}/document`),
    );
    const publicSnapshot = await api.get(
      apiPath(`/public/scoped-signoff/${remaining.token}/document`),
    );
    expect(internalSnapshot.status()).toBe(200);
    expect(publicSnapshot.status()).toBe(200);
    expect(await internalSnapshot.body()).toEqual(await publicSnapshot.body());

    // Revoking a signed customer URL closes every public route without
    // changing the signed evidence state or removing the staff PDF.
    const revokeSigned = await api.delete(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${signedRemaining.id}`),
    );
    expect(revokeSigned.status()).toBe(204);
    expect((await api.get(apiPath(`/public/scoped-signoff/${remaining.token}`))).status()).toBe(404);
    expect((await api.get(apiPath(`/public/scoped-signoff/${remaining.token}/document`))).status()).toBe(404);
    const retainedHistory = await approvalForToken(api, quoteId, remaining.token);
    expect(retainedHistory.status).toBe("signed");
    expect(retainedHistory.revokedAt).not.toBeNull();
    const retainedInternalSnapshot = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${signedRemainingId}/document`),
    );
    expect(retainedInternalSnapshot.status()).toBe(200);
    expect(await retainedInternalSnapshot.body()).toEqual(await internalSnapshot.body());
  });

  test("expires and rotates scoped and legacy links without reviving old URLs", async ({ page }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const expiredAt = new Date(Date.now() - 1_000).toISOString();

    const scoped = await createScopedApproval(api, quoteId, ["windows"]);
    const expireScoped = await api.patch(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${scoped.id}`),
      { data: { expiresAt: expiredAt } },
    );
    expect(expireScoped.status()).toBe(200);
    expect((await api.get(apiPath(`/public/scoped-signoff/${scoped.token}`))).status()).toBe(404);

    const rotateScoped = await api.post(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${scoped.id}/rotate`),
    );
    expect(rotateScoped.status()).toBe(201);
    const scopedReplacement = (await rotateScoped.json()) as ScopedApproval;
    expect(scopedReplacement.token).not.toBe(scoped.token);
    expect((await api.get(apiPath(`/public/scoped-signoff/${scoped.token}`))).status()).toBe(404);
    expect((await api.get(apiPath(`/public/scoped-signoff/${scopedReplacement.token}`))).status()).toBe(200);

    const legacy = await api.post(apiPath(`/quotes/${quoteId}/share-link`));
    expect(legacy.status()).toBe(200);
    const legacyLink = (await legacy.json()) as { token: string };
    const expireLegacy = await api.patch(apiPath(`/quotes/${quoteId}/share-link`), {
      data: { expiresAt: expiredAt },
    });
    expect(expireLegacy.status()).toBe(200);
    expect((await api.get(apiPath(`/public/signoff/${legacyLink.token}`))).status()).toBe(404);

    const rotateLegacy = await api.post(apiPath(`/quotes/${quoteId}/share-link/rotate`));
    expect(rotateLegacy.status()).toBe(201);
    const legacyReplacement = (await rotateLegacy.json()) as { token: string };
    expect(legacyReplacement.token).not.toBe(legacyLink.token);
    expect((await api.get(apiPath(`/public/signoff/${legacyLink.token}`))).status()).toBe(404);
    expect((await api.get(apiPath(`/public/signoff/${legacyReplacement.token}`))).status()).toBe(200);
  });

  test("does not expose a legacy share token or raw snapshot fields through a scoped detail", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    // The legacy link has to exist before the scoped snapshot is prepared:
    // this was the path where the quote-row spread persisted shareToken.
    const legacyShareLink = await api.post(apiPath(`/quotes/${quoteId}/share-link`));
    expect(legacyShareLink.status()).toBe(200);
    const { token: legacyShareToken } = (await legacyShareLink.json()) as { token: string };
    const windows = await createScopedApproval(api, quoteId, ["windows"]);

    const freshDetail = await getScopedPublicDetail(api, windows.token);
    expectScopedDetailIsPublicSafe(freshDetail, legacyShareToken);

    // Historical requests are immutable audit evidence, so simulate an
    // already-stored rollout-era raw quote rather than rewriting it through
    // current issuance. The public reader must still project its allowlist.
    await addLegacyRawFieldsToScopedSnapshot(windows.id, legacyShareToken);
    const legacyRawDetail = await getScopedPublicDetail(api, windows.token);
    expectScopedDetailIsPublicSafe(legacyRawDetail, legacyShareToken);
  });

  test("omits excluded revisions from fresh and historical scoped public snapshots", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const freshExcludedRevisionId = await createRevision(
      api,
      quoteId,
      "fresh excluded revision must never be public",
      ["windows"],
    );
    await setRevisionSignoffExclusion(api, quoteId, freshExcludedRevisionId, true);
    const windows = await createScopedApproval(api, quoteId, ["windows"]);

    const freshDetail = await getScopedPublicDetail(api, windows.token);
    expect(JSON.stringify(freshDetail)).not.toContain(
      "fresh excluded revision must never be public",
    );

    // A stored snapshot from before exclusion-aware public serialization may
    // retain the revision. It remains immutable in storage but cannot be sent
    // through the scoped customer endpoint.
    await addExcludedRevisionToScopedSnapshot(windows.id);
    const historicalDetail = await getScopedPublicDetail(api, windows.token);
    expect(JSON.stringify(historicalDetail)).not.toContain(
      "historical excluded revision must never be public",
    );
  });

  test("invalidates only affected scopes for tagged revisions and all scopes for a general revision", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const windows = await createScopedApproval(api, quoteId, ["windows"]);
    await signCurrentScopedApproval(api, windows.token);
    const doors = await createScopedApproval(api, quoteId, [
      "interiorDoors",
      "exteriorDoors",
    ]);
    await signCurrentScopedApproval(api, doors.token);
    const signedDoors = await approvalForToken(api, quoteId, doors.token);
    const signedDoorsId = signedSnapshotId(signedDoors);
    const signedDoorsDocument = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${signedDoorsId}/document`),
    );
    expect(signedDoorsDocument.status()).toBe(200);
    const immutableDoorsBytes = await signedDoorsDocument.body();

    const signedWindows = await approvalForToken(api, quoteId, windows.token);
    const signedWindowsId = signedSnapshotId(signedWindows);
    const signedWindowsDocument = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${signedWindowsId}/document`),
    );
    expect(signedWindowsDocument.status()).toBe(200);
    const immutableWindowsBytes = await signedWindowsDocument.body();

    // A Windows-only revision is unrelated to the Doors approval. It makes
    // only the affected approval require review and leaves its old snapshot
    // downloadable as evidence of what was signed.
    await createRevision(api, quoteId, "Windows-only scoped revision", [
      "windows",
    ]);
    let detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "needs_resigning",
      interiorDoors: "signed",
      exteriorDoors: "signed",
    });
    await expectQuoteInDashboardStatus(api, "needs_resigning", quoteId);
    await expectQuoteNotInDashboardStatus(api, "partial", quoteId);
    await expectQuoteNotInDashboardStatus(api, "awaiting", quoteId);
    expectInvalidationReasons(detail.approvalCoverage, ["windows"]);
    expect((await approvalForToken(api, quoteId, doors.token)).status).toBe(
      "signed",
    );
    const preservedWindowsDocument = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${signedWindowsId}/document`),
    );
    expect(preservedWindowsDocument.status()).toBe(200);
    expect(await preservedWindowsDocument.body()).toEqual(immutableWindowsBytes);

    // Stale links cannot be re-signed. The server permits a replacement
    // request for the now-stale scope instead.
    const replacementWindows = await createScopedApproval(api, quoteId, [
      "windows",
    ]);
    await signCurrentScopedApproval(api, replacementWindows.token);
    detail = await getQuoteDetail(api, quoteId);
    expect(coverageByProduct(detail.approvalCoverage).windows).toBe("signed");

    // Coverage is product-type-specific even when the customer signed two
    // types together. An Exterior Doors revision must retain Interior Doors'
    // signed coverage; the original combined artifact remains historical
    // evidence of precisely the original two-type scope.
    await createRevision(api, quoteId, "Exterior-door scoped revision", [
      "exteriorDoors",
    ]);
    detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "signed",
      interiorDoors: "signed",
      exteriorDoors: "needs_resigning",
    });
    expectInvalidationReasons(detail.approvalCoverage, ["exteriorDoors"]);
    // The original combined approval remains a historical record for its
    // original two-type scope even though only Exterior Doors changed. Its
    // signed PDF must be served from the captured immutable snapshot rather
    // than regenerated from the revised quote.
    const invalidatedDoors = await approvalForToken(api, quoteId, doors.token);
    expect(invalidatedDoors.status).toBe("needs_resigning");
    expect(invalidatedDoors.productTypes).toEqual([
      "interiorDoors",
      "exteriorDoors",
    ]);
    expect(invalidatedDoors.notIncludedProductTypes).toEqual(["windows"]);
    const preservedDoorsDocument = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${signedDoorsId}/document`),
    );
    expect(preservedDoorsDocument.status()).toBe(200);
    expect(await preservedDoorsDocument.body()).toEqual(immutableDoorsBytes);

    // A revision with no category tags is general/all and invalidates every
    // active scope.
    await createRevision(api, quoteId, "General project revision");
    detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "needs_resigning",
      interiorDoors: "needs_resigning",
      exteriorDoors: "needs_resigning",
    });
    expectInvalidationReasons(detail.approvalCoverage, [
      "windows",
      "interiorDoors",
      "exteriorDoors",
    ]);
  });

  test("PATCH distinguishes targeted specs, simultaneous shared edits, and no-op edits", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const windows = await createScopedApproval(api, quoteId, ["windows"]);
    const doors = await createScopedApproval(api, quoteId, [
      "interiorDoors",
      "exteriorDoors",
    ]);
    await signCurrentScopedApproval(api, windows.token);
    await signCurrentScopedApproval(api, doors.token);

    const windowsRevisedSpecs = {
      window: { brand: "Scoped Windows Revised", series: "E2E 400" },
      interiorDoor: { brand: "Scoped Interior Doors" },
      exteriorDoor: { brand: "Scoped Exterior Doors" },
    };
    const targetedSpecPatch = await api.patch(apiPath(`/quotes/${quoteId}`), {
      data: { specs: windowsRevisedSpecs },
    });
    expect(targetedSpecPatch.status()).toBe(200);
    let detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "needs_resigning",
      interiorDoors: "signed",
      exteriorDoors: "signed",
    });
    expectInvalidationReasons(detail.approvalCoverage, ["windows"]);

    const replacementWindows = await createScopedApproval(api, quoteId, [
      "windows",
    ]);
    await signCurrentScopedApproval(api, replacementWindows.token);

    // A product-specific spec change and a shared project-field edit in one
    // PATCH must conservatively invalidate every active product type.
    const sharedAndExteriorRevisedSpecs = {
      ...windowsRevisedSpecs,
      exteriorDoor: { brand: "Scoped Exterior Doors Revised" },
    };
    const simultaneousPatch = await api.patch(apiPath(`/quotes/${quoteId}`), {
      data: {
        projectName: "Scoped approval fixture with shared edit",
        specs: sharedAndExteriorRevisedSpecs,
      },
    });
    expect(simultaneousPatch.status()).toBe(200);
    detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "needs_resigning",
      interiorDoors: "needs_resigning",
      exteriorDoors: "needs_resigning",
    });
    expectInvalidationReasons(detail.approvalCoverage, [
      "windows",
      "interiorDoors",
      "exteriorDoors",
    ]);
    const sharedEditRevision = detail.revisions.find(
      (revision) =>
        revision.note.startsWith("Quote details updated:") &&
        revision.categories === null,
    );
    if (!sharedEditRevision) {
      throw new Error("Shared quote/spec PATCH did not create a general automatic revision.");
    }
    expect(sharedEditRevision.categories).toBeNull();

    const currentWindows = await createScopedApproval(api, quoteId, ["windows"]);
    const currentDoors = await createScopedApproval(api, quoteId, [
      "interiorDoors",
      "exteriorDoors",
    ]);
    await signCurrentScopedApproval(api, currentWindows.token);
    await signCurrentScopedApproval(api, currentDoors.token);
    // The automatic shared edit is tagged general and is visible in each
    // subsequently prepared scope: Windows and both door product types.
    const windowsPublic = await getScopedPublicDetail(api, currentWindows.token);
    const doorsPublic = await getScopedPublicDetail(api, currentDoors.token);
    expect(windowsPublic.productTypes).toEqual(["windows"]);
    expect(doorsPublic.productTypes).toEqual([
      "interiorDoors",
      "exteriorDoors",
    ]);
    for (const publicDetail of [windowsPublic, doorsPublic]) {
      expect(publicDetail.revisions).toContainEqual(
        expect.objectContaining({
          note: sharedEditRevision.note,
          categories: null,
        }),
      );
    }
    const beforeNoOp = await getQuoteDetail(api, quoteId);

    // Sending the current values is a no-op: it must not advance the document
    // version, add a revision, or revoke otherwise-current signed coverage.
    const noOpPatch = await api.patch(apiPath(`/quotes/${quoteId}`), {
      data: {
        customerName: "Scoped Approval E2E Customer",
        projectName: "Scoped approval fixture with shared edit",
        specs: sharedAndExteriorRevisedSpecs,
      },
    });
    expect(noOpPatch.status()).toBe(200);
    detail = await getQuoteDetail(api, quoteId);
    expect(detail.documentVersion).toBe(beforeNoOp.documentVersion);
    expectCoverage(detail.approvalCoverage, {
      windows: "signed",
      interiorDoors: "signed",
      exteriorDoors: "signed",
    });
    expectInvalidationReasons(detail.approvalCoverage, []);
  });

  test("deleting an unpublished packet leaves signed scoped coverage current", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const windows = await createScopedApproval(api, quoteId, ["windows"]);
    await signCurrentScopedApproval(api, windows.token);
    const beforeDelete = await getScopedPublicDetail(api, windows.token);

    // The row has an assigned type but has never been approved or published in
    // a customer manifest, so deleting it cannot alter the signed document.
    const upload = await api.post(apiPath(`/quotes/${quoteId}/manufacturer-packets`), {
      data: {
        name: "unpublished-scoped-packet.pdf",
        size: 128,
        contentType: "application/pdf",
        manufacturer: "Scoped E2E Manufacturer",
        productType: "windows",
      },
    });
    expect(upload.status()).toBe(201);
    const pending = (await upload.json()) as { packet: Packet };
    expect(pending.packet.status).toBe("awaiting_upload");
    expect(pending.packet.productType).toBe("windows");

    const deleted = await api.delete(
      apiPath(`/quotes/${quoteId}/manufacturer-packets/${pending.packet.id}`),
    );
    expect(deleted.status()).toBe(204);
    expect(
      (
        await api.get(
          apiPath(`/quotes/${quoteId}/manufacturer-packets/${pending.packet.id}`),
        )
      ).status(),
    ).toBe(404);

    const detail = await getQuoteDetail(api, quoteId);
    expectCoverage(detail.approvalCoverage, {
      windows: "signed",
      interiorDoors: "open",
      exteriorDoors: "open",
    });
    expectInvalidationReasons(detail.approvalCoverage, []);
    const afterDelete = await getScopedPublicDetail(api, windows.token);
    expect(afterDelete.status).toBe("signed");
    expect(afterDelete.documentVersion).toBe(beforeDelete.documentVersion);
  });

  test("rejects overlapping scopes and stale signing, confines packet pages, and invalidates on packet reassignment", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    // Simulate a pre-Task-29 packet: it was approved before packets gained a
    // product-type assignment. It must be classified explicitly rather than
    // silently appearing in every new customer request.
    const packet = await approveOnePagePacket(api, quoteId, "windows");
    await makePacketLegacyUnclassified(packet.id);
    const scopeWithUnclassifiedPacket = await api.post(
      apiPath(`/quotes/${quoteId}/scoped-approvals`),
      { data: { productTypes: ["windows"] } },
    );
    expect(scopeWithUnclassifiedPacket.status()).toBe(400);
    const assignedToWindows = await api.patch(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${packet.id}/product-type`,
      ),
      { data: { productType: "windows" } },
    );
    expect(assignedToWindows.status()).toBe(200);
    expect(((await assignedToWindows.json()) as Packet).productType).toBe(
      "windows",
    );

    const windows = await createScopedApproval(api, quoteId, ["windows"]);
    const windowsDetail = await getScopedPublicDetail(api, windows.token);

    // A request may not claim a category that an existing open request already
    // owns. This prevents ambiguous coverage from partially overlapping links.
    const overlap = await api.post(apiPath(`/quotes/${quoteId}/scoped-approvals`), {
      data: { productTypes: ["windows", "interiorDoors"] },
    });
    expect(overlap.status()).toBe(409);

    // The scoped token sees only the page indexes in its filtered manifest.
    const scopedPage = await api.get(
      apiPath(
        `/public/scoped-signoff/${windows.token}/packet/pages/1?documentVersion=${encodeURIComponent(windowsDetail.documentVersion)}`,
      ),
    );
    expect(scopedPage.status()).toBe(200);
    expect(scopedPage.headers()["content-type"]).toContain("image/png");
    expect(
      (
        await api.get(
          apiPath(
            `/public/scoped-signoff/${windows.token}/packet/pages/2?documentVersion=${encodeURIComponent(windowsDetail.documentVersion)}`,
          ),
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.get(
          apiPath(
            `/public/scoped-signoff/not-a-real-token/packet/pages/1?documentVersion=${encodeURIComponent(windowsDetail.documentVersion)}`,
          ),
        )
      ).status(),
    ).toBe(404);

    // The version captured before a relevant mutation can never be submitted.
    await createRevision(api, quoteId, "Stales only the Windows request", [
      "windows",
    ]);
    const staleSign = await submitScopedSignatureWithRateLimitRetry(
      api,
      windows.token,
      windowsDetail.documentVersion,
    );
    expect(staleSign.status()).toBe(409);
    // The invalidated request is no longer OPEN, so the same scope can be
    // replaced. Only currently-open intersections are rejected.
    const replacementWindows = await createScopedApproval(api, quoteId, [
      "windows",
    ]);
    const replacementHistory = await approvalForToken(
      api,
      quoteId,
      replacementWindows.token,
    );
    expect(replacementHistory.status).toBe("open");
    expect(replacementHistory.approvalId).toBeNull();

    // A reviewed/approved packet may be reassigned only to a category on its
    // parent quote. Existing links retain their immutable snapshots, but
    // their request becomes stale and any replacement is built from the new
    // category assignment.
    const invalidAssignment = await api.patch(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${packet.id}/product-type`,
      ),
      { data: { productType: "trim" } },
    );
    expect(invalidAssignment.status()).toBe(400);
    const reassigned = await api.patch(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${packet.id}/product-type`,
      ),
      { data: { productType: "interiorDoors" } },
    );
    expect(reassigned.status()).toBe(200);
    const resetPacket = (await reassigned.json()) as Packet & {
      manualRedactions: Record<string, unknown[]> | null;
      appliedTemplate: { id: number; name: string } | null;
    };
    expect(resetPacket.productType).toBe("interiorDoors");
    expect(resetPacket.status).toBe("queued");
    expect(resetPacket.manualRedactions).toBeNull();
    expect(resetPacket.appliedTemplate).toBeNull();

    const refreshedWindows = await getScopedPublicDetail(api, windows.token);
    expect(refreshedWindows.status).toBe("needs_resigning");
    expect(refreshedWindows.documentVersion).toBe(
      windowsDetail.documentVersion,
    );
    expect(
      (
        await api.get(
          apiPath(
            `/public/scoped-signoff/${windows.token}/packet/pages/1?documentVersion=${encodeURIComponent(refreshedWindows.documentVersion)}`,
          ),
        )
      ).status(),
    ).toBe(200);
    expect(
      (await getScopedPublicDetail(api, replacementWindows.token)).status,
    ).toBe("needs_resigning");

    // Reclassification cannot carry redactions or template attribution from
    // the former product type into newly sanitized customer pages. It must be
    // reviewed and approved again under the new classification.
    await waitForPacket(api, quoteId, packet.id, "needs_review");
    expect(
      (
        await api.patch(
          apiPath(`/quotes/${quoteId}/manufacturer-packets/${packet.id}/redactions`),
          { data: { redactionsByPage: {} } },
        )
      ).status(),
    ).toBe(202);
    await waitForPacket(api, quoteId, packet.id, "ready_for_approval");
    expect(
      (
        await api.post(
          apiPath(`/quotes/${quoteId}/manufacturer-packets/${packet.id}/approve`),
        )
      ).status(),
    ).toBe(200);

    const interior = await createScopedApproval(api, quoteId, ["interiorDoors"]);
    const interiorDetail = await getScopedPublicDetail(api, interior.token);
    expect(
      (
        await api.get(
          apiPath(
            `/public/scoped-signoff/${interior.token}/packet/pages/1?documentVersion=${encodeURIComponent(interiorDetail.documentVersion)}`,
          ),
        )
      ).status(),
    ).toBe(200);
  });

  test("cross-product packet reordering preserves scoped versions when each type's relative order is unchanged", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const windowsPacket = await approveOnePagePacket(api, quoteId, "windows");
    const interiorPacket = await approveOnePagePacket(
      api,
      quoteId,
      "interiorDoors",
    );

    const initialManifest = await api.put(
      apiPath(`/quotes/${quoteId}/manufacturer-packet-manifest`),
      {
        data: {
          entries: [
            { packetId: windowsPacket.id, pageNumber: 1, pageOrder: 1 },
            { packetId: interiorPacket.id, pageNumber: 1, pageOrder: 2 },
          ],
        },
      },
    );
    expect(initialManifest.status()).toBe(200);
    const windows = await createScopedApproval(api, quoteId, ["windows"]);
    const interior = await createScopedApproval(api, quoteId, ["interiorDoors"]);
    const windowsVersion = (await getScopedPublicDetail(api, windows.token))
      .documentVersion;
    const interiorVersion = (await getScopedPublicDetail(api, interior.token))
      .documentVersion;

    // The global packet sequence changed, but each scoped snapshot filters to
    // one type and that type's relative page order is unchanged. Neither
    // customer-facing document changed, so both original tokens remain valid.
    const reorderedManifest = await api.put(
      apiPath(`/quotes/${quoteId}/manufacturer-packet-manifest`),
      {
        data: {
          entries: [
            { packetId: interiorPacket.id, pageNumber: 1, pageOrder: 1 },
            { packetId: windowsPacket.id, pageNumber: 1, pageOrder: 2 },
          ],
        },
      },
    );
    expect(reorderedManifest.status()).toBe(200);
    const reorderedWindows = await getScopedPublicDetail(api, windows.token);
    const reorderedInterior = await getScopedPublicDetail(api, interior.token);
    expect(reorderedWindows.status).toBe("open");
    expect(reorderedInterior.status).toBe("open");
    expect(reorderedWindows.documentVersion).toBe(windowsVersion);
    expect(reorderedInterior.documentVersion).toBe(interiorVersion);
    await signScopedApproval(api, windows.token, windowsVersion);
    await signScopedApproval(api, interior.token, interiorVersion);
  });

  test("serializes concurrent scoped signing and a relevant revision without server errors", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const seededRevision = await api.post(apiPath(`/quotes/${quoteId}/revisions`), {
      data: {
        note: "Revision used by the concurrent exclusion mutation",
        categories: ["windows"],
      },
    });
    expect(seededRevision.status()).toBe(201);
    const { id: revisionId } = (await seededRevision.json()) as { id: number };
    const approval = await createScopedApproval(api, quoteId, ["windows"]);
    const documentVersion = (
      await getScopedPublicDetail(api, approval.token)
    ).documentVersion;

    // Start both requests from the same promise barrier. The backend must take
    // the quote lock before derived approval rows, avoiding lock-order
    // deadlocks while allowing either serializable outcome.
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const signPromise = (async () => {
      await barrier;
      return submitScopedSignatureWithRateLimitRetry(
        api,
        approval.token,
        documentVersion,
      );
    })();
    const revisionMutationPromise = (async () => {
      await barrier;
      return api.patch(
        apiPath(
          `/quotes/${quoteId}/revisions/${revisionId}/signoff-exclusion`,
        ),
        {
          data: {
            excludedFromSignoff: true,
          },
        },
      );
    })();
    releaseBarrier();
    const [signResponse, revisionResponse] = await Promise.all([
      signPromise,
      revisionMutationPromise,
    ]);

    expect(signResponse.status()).not.toBe(500);
    expect(revisionResponse.status()).not.toBe(500);
    expect(revisionResponse.status()).toBe(200);
    expect([200, 409]).toContain(signResponse.status());

    const detail = await getQuoteDetail(api, quoteId);
    const windowsCoverage = detail.approvalCoverage.find(
      (coverage) => coverage.productType === "windows",
    );
    // If the mutation wins, no signature was ever recorded; that type remains
    // open. If signing wins, the subsequent mutation invalidates its coverage.
    expect(windowsCoverage?.status).toBe(
      signResponse.status() === 200 ? "needs_resigning" : "open",
    );
  });

  test("keeps legacy whole-quote signed documents immutable and separate from scoped approval history", async ({
    page,
  }) => {
    const api = page.context().request;
    const legacyQuoteId = await createScopedQuote(api);
    const legacyDetail = await getQuoteDetail(api, legacyQuoteId);
    const legacySign = await api.put(apiPath(`/quotes/${legacyQuoteId}/signoff`), {
      data: signatureData(legacyDetail.documentVersion),
    });
    expect(legacySign.status()).toBe(200);

    const legacyBefore = await api.get(
      apiPath(`/quotes/${legacyQuoteId}/signoff/document`),
    );
    expect(legacyBefore.status()).toBe(200);
    const legacyBytes = await legacyBefore.body();
    const legacyScopedHistory = await listScopedApprovals(api, legacyQuoteId);
    expect(legacyScopedHistory.approvals).toEqual([]);

    // The staff UI must fetch the protected evidence with the app's bearer
    // token, then navigate a retained popup to the returned PDF blob. A raw
    // anchor to this endpoint renders {"error":"Unauthorized"} in some
    // privacy-hardened browsers.
    await page.goto(`/quotes/${legacyQuoteId}/signoff`);
    const [legacyDocumentResponse, legacyDocumentPage] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().endsWith(`/api/quotes/${legacyQuoteId}/signoff/document`),
      ),
      page.waitForEvent("popup"),
      page.getByRole("button", { name: "Open legacy signed PDF" }).click(),
    ]);
    expect(legacyDocumentResponse.status()).toBe(200);
    expect(legacyDocumentResponse.headers()["content-type"]).toContain("application/pdf");
    await expect.poll(() => legacyDocumentPage.url()).toMatch(/^blob:/);
    await legacyDocumentPage.close();

    // Creating and signing a scoped request on another quote must not migrate,
    // overwrite, or otherwise reinterpret the legacy whole-quote approval.
    const scopedQuoteId = await createScopedQuote(api);
    const scoped = await createScopedApproval(api, scopedQuoteId, ["windows"]);
    await signCurrentScopedApproval(api, scoped.token);

    const legacyAfter = await api.get(
      apiPath(`/quotes/${legacyQuoteId}/signoff/document`),
    );
    expect(legacyAfter.status()).toBe(200);
    expect(await legacyAfter.body()).toEqual(legacyBytes);
    expect((await api.get(apiPath(`/quotes/${legacyQuoteId}/signoff`))).status()).toBe(
      200,
    );
    expect((await listScopedApprovals(api, legacyQuoteId)).approvals).toEqual([]);
  });

  test("opens protected scoped evidence with a bearer-authenticated blob popup", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const scoped = await createScopedApproval(api, quoteId, ["windows"]);
    await signCurrentScopedApproval(api, scoped.token);
    const signed = await approvalForToken(api, quoteId, scoped.token);
    const approvalId = signedSnapshotId(signed);
    const signedDocument = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${approvalId}/document`),
    );
    expect(signedDocument.status()).toBe(200);
    const pdfBytes = await signedDocument.body();

    let authorizationHeader: string | undefined;
    await page.route(
      `**/api/quotes/${quoteId}/scoped-approvals/${approvalId}/document`,
      async (route) => {
        authorizationHeader = route.request().headers().authorization;
        // The intercepted response is fulfilled directly; the UI must not
        // depend on forwarding a session cookie to this protected route.
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/pdf" },
          body: pdfBytes,
        });
      },
    );

    await page.goto(`/quotes/${quoteId}/signoff`);
    await page.getByText("Approval history and advanced controls", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Approval Link History", exact: true }),
    ).toBeVisible();

    const [documentPage] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("button", { name: "Open signed evidence", exact: true }).click(),
    ]);
    await expect.poll(() => authorizationHeader).toMatch(/^Bearer\s+\S+$/);
    await expect.poll(() => documentPage.url()).toMatch(/^blob:/);
    await documentPage.close();
  });

  test("renders the immutable staff snapshot after live edits and link revocation", async ({
    page,
    request,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    await createRevision(api, quoteId, "Revision captured in the original approval", ["windows"]);
    const scoped = await createScopedApproval(api, quoteId, ["windows"]);
    await signCurrentScopedApproval(api, scoped.token);
    const signed = await approvalForToken(api, quoteId, scoped.token);
    const approvalId = signedSnapshotId(signed);

    const firstSnapshotResponse = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${approvalId}/snapshot`),
    );
    expect(firstSnapshotResponse.status()).toBe(200);
    const firstSnapshot = (await firstSnapshotResponse.json()) as {
      quote: { projectName: string };
      revisions: Array<{ note: string }>;
      status: string;
      linkStatus: string;
      packetPages: unknown[];
    };
    const originalProjectName = firstSnapshot.quote.projectName;
    expect(firstSnapshot.revisions.some((revision) => revision.note === "Revision captured in the original approval")).toBe(true);
    expect(firstSnapshot.status).toBe("signed");
    expect(firstSnapshot.linkStatus).toBe("active");
    expect((await request.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${approvalId}/snapshot`),
    )).status()).toBe(401);

    // Both a mutable quote edit and a revoked public request must leave the
    // stored fields available to staff, while current status is shown apart
    // from that original content.
    const liveEdit = await api.patch(apiPath(`/quotes/${quoteId}`), {
      data: { projectName: "Live quote name after signing" },
    });
    expect(liveEdit.status()).toBe(200);
    expect((await api.delete(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${scoped.id}`),
    )).status()).toBe(204);

    const retainedSnapshotResponse = await api.get(
      apiPath(`/quotes/${quoteId}/scoped-approvals/${approvalId}/snapshot`),
    );
    expect(retainedSnapshotResponse.status()).toBe(200);
    const retainedSnapshot = (await retainedSnapshotResponse.json()) as {
      quote: { projectName: string };
      revisions: Array<{ note: string }>;
      status: string;
      linkStatus: string;
      invalidationReason: string | null;
      packetPages: unknown[];
    };
    expect(retainedSnapshot.quote.projectName).toBe(originalProjectName);
    expect(retainedSnapshot.quote.projectName).not.toBe("Live quote name after signing");
    expect(retainedSnapshot.revisions).toEqual(firstSnapshot.revisions);
    expect(retainedSnapshot.status).toBe("needs_resigning");
    expect(retainedSnapshot.invalidationReason).toEqual(expect.any(String));
    expect(retainedSnapshot.linkStatus).toBe("revoked");

    // Exercise the HTML route with a captured packet page. Delaying this
    // bearer-authenticated blob response makes the print gate observable:
    // it must remain disabled until the image's load event fires.
    const printableSnapshot = {
      ...retainedSnapshot,
      ...firstSnapshot,
      quote: firstSnapshot.quote,
      revisions: firstSnapshot.revisions,
      status: retainedSnapshot.status,
      linkStatus: retainedSnapshot.linkStatus,
      invalidationReason: retainedSnapshot.invalidationReason,
      packetPages: [{
        pageNumber: 1,
        packetId: 900001,
        productType: "windows",
        pageOrder: 1,
      }],
    };
    let releasePacketImage!: () => void;
    const packetImageReleased = new Promise<void>((resolve) => {
      releasePacketImage = resolve;
    });
    await page.route(
      `**/api/quotes/${quoteId}/scoped-approvals/${approvalId}/snapshot`,
      async (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(printableSnapshot),
      }),
    );
    await page.route(
      `**/api/quotes/${quoteId}/scoped-approvals/${approvalId}/packet/pages/1`,
      async (route) => {
        await packetImageReleased;
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      },
    );
    await page.goto(`/quotes/${quoteId}/signoff/${approvalId}`);
    await expect(page.getByRole("heading", { name: "View or print signoff", exact: true })).toBeVisible();
    await expect(page.getByText("Live quote name after signing", { exact: true })).toHaveCount(0);
    await expect(page.getByText(new RegExp(originalProjectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeVisible();
    await expect(page.getByText("Link access: revoked", { exact: true })).toBeVisible();
    const printButton = page.getByRole("button", { name: "Print / Save PDF", exact: true });
    await expect(printButton).toBeDisabled();
    releasePacketImage();
    await expect(printButton).toBeEnabled();
  });

  test("legacy DELETE withdraws current status but retains immutable evidence and dashboard filters", async ({
    page,
  }) => {
    const api = page.context().request;
    const summaryBefore = await getDashboardSummary(api);
    const quoteId = await createScopedQuote(api);
    const detail = await getQuoteDetail(api, quoteId);
    const signed = await api.put(apiPath(`/quotes/${quoteId}/signoff`), {
      data: signatureData(detail.documentVersion),
    });
    expect(signed.status()).toBe(200);
    const originalDocument = await api.get(
      apiPath(`/quotes/${quoteId}/signoff/document`),
    );
    expect(originalDocument.status()).toBe(200);
    const originalBytes = await originalDocument.body();
    expect((await getDashboardSummary(api)).signedQuotes).toBe(
      summaryBefore.signedQuotes + 1,
    );

    const withdrawn = await api.delete(apiPath(`/quotes/${quoteId}/signoff`));
    expect(withdrawn.status()).toBe(204);
    const preservedDocument = await api.get(
      apiPath(`/quotes/${quoteId}/signoff/document`),
    );
    expect(preservedDocument.status()).toBe(200);
    expect(await preservedDocument.body()).toEqual(originalBytes);
    expect((await getDashboardSummary(api)).signedQuotes).toBe(
      summaryBefore.signedQuotes,
    );

    const share = await api.post(apiPath(`/quotes/${quoteId}/share-link`));
    expect(share.status()).toBe(200);
    const { token } = (await share.json()) as { token: string };
    const publicDetail = await api.get(apiPath(`/public/signoff/${token}`));
    expect(publicDetail.status()).toBe(200);
    const publicBody = (await publicDetail.json()) as {
      signoff: unknown;
      legacyApproval: {
        status: string;
        validity: string;
        documentAvailable: boolean;
      } | null;
    };
    expect(publicBody.signoff).toBeNull();
    expect(publicBody.legacyApproval).toMatchObject({
      status: "legacy",
      validity: "needs_resigning",
      documentAvailable: true,
    });
  });

  test("moves an invalidated legacy approval to only the signed dashboard filter after complete scoped replacement", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    const legacyDetail = await getQuoteDetail(api, quoteId);
    const legacySign = await api.put(apiPath(`/quotes/${quoteId}/signoff`), {
      data: signatureData(legacyDetail.documentVersion),
    });
    expect(legacySign.status()).toBe(200);

    await createRevision(api, quoteId, "Invalidates legacy whole-quote coverage");
    await expectQuoteInDashboardStatus(api, "needs_resigning", quoteId);
    await expectQuoteNotInDashboardStatus(api, "signed", quoteId);

    const completeReplacement = await createScopedApproval(api, quoteId, [
      "windows",
      "interiorDoors",
      "exteriorDoors",
    ]);
    await signCurrentScopedApproval(api, completeReplacement.token);

    await expectQuoteInDashboardStatus(api, "signed", quoteId);
    await expectQuoteNotInDashboardStatus(api, "needs_resigning", quoteId);
  });

  test("picker preview opens a public scoped document with print-safe controls", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);

    await page.goto(`/quotes/${quoteId}/signoff`);
    await expect(
      page.getByRole("heading", { name: "Customer Approval Setup", exact: true }),
    ).toBeVisible();
    const backToQuote = page.getByRole("link", {
      name: /^Back to Quote #\d+$/,
    });
    await expect(backToQuote).toBeVisible();
    await backToQuote.click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${quoteId}$`));
    await page.goto(`/quotes/${quoteId}/signoff`);

    // The picker starts with all active types selected. Remove both door types
    // and ensure the action label reflects the exact resulting scope.
    await page.getByText("Interior Doors", { exact: true }).click();
    await page.getByText("Exterior Doors", { exact: true }).click();
    const preview = page.getByRole("button", {
      name: "Prepare Preview for Windows",
      exact: true,
    });
    await expect(preview).toBeEnabled();
    await preview.click();

    await expect(
      page.getByRole("heading", { name: "Preview Ready" }),
    ).toBeVisible();
    const exactPreview = page
      .getByRole("link", { name: "Open preview", exact: true })
      .last();
    const publicDocumentPath = await exactPreview.getAttribute("href");
    if (!publicDocumentPath) {
      throw new Error("Open exact preview did not expose a scoped public-document path.");
    }
    await exactPreview.click();
    await expect(page).toHaveURL(/\/scoped-sign\/[^/]+$/);

    // This is the customer-document route, not the employee picker. An
    // approved employee reviewing the exact document can return to setup
    // without relying on browser history.
    await expect(
      page.getByRole("link", { name: "Back to Approval Setup", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Back to Approval Setup", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${quoteId}/signoff$`));
    await page.goto(publicDocumentPath);

    await expect(
      page.getByRole("heading", { name: "Approval scope" }),
    ).toBeVisible();
    await expect(page.getByText(/Included:\s*Windows/)).toBeVisible();
    await expect(
      page.getByText(/Not included:\s*Interior Doors, Exterior Doors/),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Windows", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Interior Doors", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Exterior Doors", exact: true }),
    ).toHaveCount(0);

    // Verify the public document's print-only styles hide interactive controls
    // and expose the paper signature line before a customer has signed.
    const printButton = page.getByRole("button", { name: /Print \/ Save PDF/ });
    await expect(printButton).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(printButton).toBeHidden();
    await expect(
      page.getByText("Authorized Signature", { exact: true }),
    ).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  });

  test("recovers an open picker request after refresh and cancels it before preparing another", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);

    await page.goto(`/quotes/${quoteId}/signoff`);
    await page.getByText("Interior Doors", { exact: true }).click();
    await page.getByText("Exterior Doors", { exact: true }).click();
    await page.getByRole("button", {
      name: "Prepare Preview for Windows",
      exact: true,
    }).click();
    await expect(
      page.getByRole("heading", { name: "Preview Ready" }),
    ).toBeVisible();
    const openPreview = page
      .getByRole("link", { name: "Open preview", exact: true })
      .first();
    const previewHref = await openPreview.getAttribute("href");
    if (!previewHref) throw new Error("Open scoped preview did not expose a token URL");
    const token = previewHref.split("/").pop();
    if (!token) throw new Error("Open scoped preview URL did not contain a token");
    const documentVersion = (await getScopedPublicDetail(api, token)).documentVersion;

    // The request is server-backed, so a reload can recover its immutable
    // scope rather than manufacturing a second, overlapping token.
    await page.reload();
    await page.getByText("Approval history and advanced controls", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Approval Link History", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Scope: Windows", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reuse this exact request" }).click();
    await expect(
      page.getByRole("heading", { name: "Preview Ready" }),
    ).toBeVisible();

    // Cancellation invokes the revoke endpoint, removes the recovered open
    // request from the picker, and permits a new exact scope to be prepared.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Revoke customer link" }).click();
    await expect(
      page.getByText("Customer link revoked", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Link access: revoked", { exact: true }),
    ).toBeVisible();
    const revokedEndpoints = await Promise.all([
      api.get(apiPath(`/public/scoped-signoff/${token}`)),
      api.get(apiPath(`/public/scoped-signoff/${token}/packet`)),
      api.get(
        apiPath(
          `/public/scoped-signoff/${token}/packet/pages/1?documentVersion=${encodeURIComponent(documentVersion)}`,
        ),
      ),
      api.get(apiPath(`/public/scoped-signoff/${token}/document`)),
      api.put(apiPath(`/public/scoped-signoff/${token}`), {
        data: signatureData(documentVersion),
      }),
    ]);
    for (const response of revokedEndpoints) {
      expect(response.status()).toBe(404);
    }
    await expect(
      page.getByRole("button", {
        name: "Prepare Preview for Windows",
        exact: true,
      }),
    ).toBeEnabled();
    await page.getByRole("button", {
      name: "Prepare Preview for Windows",
      exact: true,
    }).click();
    await expect(
      page.getByRole("heading", { name: "Preview Ready" }),
    ).toBeVisible();
  });

  test("picker permits a disjoint scope while another product type has an open request", async ({
    page,
  }) => {
    const api = page.context().request;
    const quoteId = await createScopedQuote(api);
    await createScopedApproval(api, quoteId, ["windows"]);

    await page.goto(`/quotes/${quoteId}/signoff`);
    await page.getByText("Approval history and advanced controls", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Approval Link History", exact: true }),
    ).toBeVisible();
    // Default selection includes all product types. Leave only Interior Doors
    // selected; it does not overlap the existing Windows request.
    await page.getByRole("checkbox", { name: /^Windows Status:/ }).click();
    await page.getByText("Exterior Doors", { exact: true }).click();
    const preview = page.getByRole("button", {
      name: "Prepare Preview for Interior Doors",
      exact: true,
    });
    await expect(preview).toBeEnabled();
    await preview.click();
    await expect(
      page.getByRole("heading", { name: "Preview Ready" }),
    ).toBeVisible();
    const preparedScope = page
      .getByText("Included in this link:", { exact: true })
      .locator("..");
    await expect(
      preparedScope.getByText("Interior Doors", { exact: true }),
    ).toBeVisible();
  });
});

async function authenticateApiContext(page: Page): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: TEST_USER_EMAIL });
}

async function createScopedQuote(api: APIRequestContext): Promise<number> {
  const unique = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const quoteNumber = String(1_000_000 + (Number(unique.slice(-7)) % 9_000_000));
  const response = await api.post(apiPath("/quotes"), {
    data: {
      quoteNumber,
      customerName: "Scoped Approval E2E Customer",
      projectName: `Scoped approval fixture ${unique.slice(-6)}`,
      jobAddress: "29 Approval Scope Way",
      categories: ["windows", "interiorDoors", "exteriorDoors"],
      specs: {
        window: { brand: "Scoped Windows", series: "E2E 400" },
        interiorDoor: { brand: "Scoped Interior Doors" },
        exteriorDoor: { brand: "Scoped Exterior Doors" },
      },
    },
  });
  expect(response.status()).toBe(201);
  const quote = (await response.json()) as { id: number };
  expect(quote.id).toEqual(expect.any(Number));
  createdQuoteIds.add(quote.id);
  return quote.id;
}

async function getQuoteDetail(
  api: APIRequestContext,
  quoteId: number,
): Promise<QuoteDetail> {
  const response = await api.get(apiPath(`/quotes/${quoteId}`), {
    headers: { "Cache-Control": "no-store" },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as QuoteDetail;
}

async function createScopedApproval(
  api: APIRequestContext,
  quoteId: number,
  productTypes: ProductType[],
): Promise<ScopedApproval> {
  const response = await api.post(apiPath(`/quotes/${quoteId}/scoped-approvals`), {
    data: { productTypes },
  });
  expect(response.status()).toBe(201);
  const approval = (await response.json()) as ScopedApproval;
  expect(approval.token).toEqual(expect.any(String));
  expect(approval.productTypes).toEqual(productTypes);
  expect(approval.documentVersion).toMatch(/^[a-f0-9]{40,64}$/);
  return approval;
}

async function listScopedApprovals(
  api: APIRequestContext,
  quoteId: number,
): Promise<ScopedApprovalList> {
  const response = await api.get(apiPath(`/quotes/${quoteId}/scoped-approvals`), {
    headers: { "Cache-Control": "no-store" },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as ScopedApprovalList;
}

async function approvalForToken(
  api: APIRequestContext,
  quoteId: number,
  token: string,
): Promise<ScopedApproval> {
  const history = await listScopedApprovals(api, quoteId);
  const approval = history.approvals.find((entry) => entry.token === token);
  if (!approval) throw new Error(`Scoped approval token was absent from quote ${quoteId} history.`);
  return approval;
}

function signedSnapshotId(approval: ScopedApproval): number {
  if (!approval.approvalId) {
    throw new Error(
      "Signed scoped approval history entry has no immutable approval ID.",
    );
  }
  return approval.approvalId;
}

function coverageByProduct(
  coverage: ApprovalCoverage[],
): Partial<Record<ProductType, ApprovalStatus>> {
  return Object.fromEntries(
    coverage.map((entry) => [entry.productType, entry.status]),
  ) as Partial<Record<ProductType, ApprovalStatus>>;
}

function expectCoverage(
  coverage: ApprovalCoverage[],
  expected: Record<ProductType, ApprovalStatus>,
): void {
  expect(coverageByProduct(coverage)).toEqual(expected);
}

function expectInvalidationReasons(
  coverage: ApprovalCoverage[],
  invalidatedTypes: ProductType[],
): void {
  for (const entry of coverage) {
    if (invalidatedTypes.includes(entry.productType)) {
      expect(entry.invalidationReason).toEqual(expect.any(String));
    } else {
      expect(entry.invalidationReason).toBeNull();
    }
  }
}

async function getScopedPublicDetail(
  api: APIRequestContext,
  token: string,
): Promise<ScopedPublicDetail> {
  const response = await api.get(apiPath(`/public/scoped-signoff/${token}`), {
    headers: { "Cache-Control": "no-store" },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as ScopedPublicDetail;
}

function expectScopedDetailIsPublicSafe(
  detail: ScopedPublicDetail,
  legacyShareToken: string,
): void {
  const serialized = JSON.stringify(detail);
  // Detail is an explicit public DTO: a scoped token is never an excuse to
  // disclose either the legacy bearer token or private storage/source paths.
  for (const privateValue of [
    legacyShareToken,
    "legacy-private-upload-object-path",
    "legacy-private-source-object-path",
    "legacy-private-manufacturer-source-path",
    "legacy-private-snapshot-token",
    "legacy-raw-out-of-scope-interior",
    "legacy-raw-out-of-scope-exterior",
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
  expect(Object.keys(detail)).not.toContain("token");
  expect(serialized).not.toContain("shareToken");
  expect(serialized).not.toContain("uploadObjectPath");
  expect(serialized).not.toContain("sourceObjectPath");
  expect(serialized).not.toContain("manufacturerSourcePath");
  expect(detail.quote.categories).toEqual(["windows"]);
  expect(Object.keys(detail.quote.specs)).toEqual(["window"]);
  // The selected Windows snapshot must not disclose specifications for the
  // two product types outside this public request.
  expect(serialized).not.toContain("Scoped Interior Doors");
  expect(serialized).not.toContain("Scoped Exterior Doors");
}

function signatureData(documentVersion: string) {
  return {
    customerName: "Scoped Approval Signer",
    stakeholderRole: "Homeowner",
    signatureType: "typed",
    signatureData: "Scoped Approval Signer",
    documentVersion,
  };
}

async function submitScopedSignature(
  api: APIRequestContext,
  token: string,
  documentVersion: string,
) {
  return api.put(apiPath(`/public/scoped-signoff/${token}`), {
    data: signatureData(documentVersion),
  });
}

async function signScopedApproval(
  api: APIRequestContext,
  token: string,
  documentVersion: string,
): Promise<void> {
  const response = await submitScopedSignatureWithRateLimitRetry(
    api,
    token,
    documentVersion,
  );
  expect(response.status()).toBe(200);
}

async function submitScopedSignatureWithRateLimitRetry(
  api: APIRequestContext,
  token: string,
  documentVersion: string,
) {
  let response = await submitScopedSignature(api, token, documentVersion);
  // Do not retry validation, stale-version, or any other real application
  // error. One Retry-After-guided retry is solely for the intentional public
  // signing rate limit shared by the full E2E suite's test IP.
  if (response.status() === 429) {
    const retryAfter = retryAfterMilliseconds(response);
    if (retryAfter !== null) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfter));
      response = await submitScopedSignature(api, token, documentVersion);
    }
  }
  return response;
}

function retryAfterMilliseconds(response: { headers(): Record<string, string> }): number | null {
  const retryAfter = response.headers()["retry-after"];
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1_000, Math.ceil(seconds * 1_000));
  }
  const retryAt = Date.parse(retryAfter);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(1_000, retryAt - Date.now());
}

async function signCurrentScopedApproval(
  api: APIRequestContext,
  token: string,
): Promise<void> {
  const detail = await getScopedPublicDetail(api, token);
  await signScopedApproval(api, token, detail.documentVersion);
}

async function createRevision(
  api: APIRequestContext,
  quoteId: number,
  note: string,
  categories?: ProductType[],
): Promise<number> {
  const response = await api.post(apiPath(`/quotes/${quoteId}/revisions`), {
    data: categories ? { note, categories } : { note },
  });
  expect(response.status()).toBe(201);
  const revision = (await response.json()) as { id: number };
  expect(revision.id).toEqual(expect.any(Number));
  return revision.id;
}

async function setRevisionSignoffExclusion(
  api: APIRequestContext,
  quoteId: number,
  revisionId: number,
  excludedFromSignoff: boolean,
): Promise<void> {
  const response = await api.patch(
    apiPath(`/quotes/${quoteId}/revisions/${revisionId}/signoff-exclusion`),
    { data: { excludedFromSignoff } },
  );
  expect(response.status()).toBe(200);
}

async function getDashboardSummary(api: APIRequestContext): Promise<{
  totalQuotes: number;
  totalRevisions: number;
  signedQuotes: number;
  quotesAwaitingSignoff: number;
}> {
  const response = await api.get(apiPath("/dashboard/summary"), {
    headers: { "Cache-Control": "no-store" },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    totalQuotes: number;
    totalRevisions: number;
    signedQuotes: number;
    quotesAwaitingSignoff: number;
  };
}

async function expectQuoteInDashboardStatus(
  api: APIRequestContext,
  status: "partial" | "signed" | "needs_resigning" | "awaiting",
  quoteId: number,
): Promise<void> {
  const response = await api.get(apiPath(`/quotes?status=${status}`), {
    headers: { "Cache-Control": "no-store" },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ id: number }> };
  expect(body.items.map((quote) => quote.id)).toContain(quoteId);
}

async function expectQuoteNotInDashboardStatus(
  api: APIRequestContext,
  status: "partial" | "signed" | "needs_resigning" | "awaiting",
  quoteId: number,
): Promise<void> {
  const response = await api.get(apiPath(`/quotes?status=${status}`), {
    headers: { "Cache-Control": "no-store" },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ id: number }> };
  expect(body.items.map((quote) => quote.id)).not.toContain(quoteId);
}

/**
 * New uploads require productType. This creates the one authentic legacy
 * fixture the API must continue to handle: an already-approved pre-Task-29
 * row whose product_type is null. It does not fabricate packet bytes or
 * bypass review/approval; only the historical column state is set directly.
 */
async function makePacketLegacyUnclassified(packetId: number): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      "UPDATE manufacturer_packets SET product_type = NULL WHERE id = $1 AND status = 'approved'",
      [packetId],
    );
    expect(result.rowCount).toBe(1);
  } finally {
    await pool.end();
  }
}

/**
 * Models a rollout-era request whose JSON snapshot was the raw quote row.
 * This is deliberately a DB fixture: snapshot evidence is immutable, so a
 * production migration must not mutate it just to remove private fields.
 */
async function addLegacyRawFieldsToScopedSnapshot(
  requestId: number,
  legacyShareToken: string,
): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      `UPDATE scoped_approval_requests
       SET snapshot = jsonb_set(
         jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(snapshot, '{quote,shareToken}', to_jsonb($2::text), true),
                   '{quote,uploadObjectPath}', to_jsonb('legacy-private-upload-object-path'::text), true
                 ),
                 '{quote,sourceObjectPath}', to_jsonb('legacy-private-source-object-path'::text), true
               ),
               '{quote,manufacturerSourcePath}', to_jsonb('legacy-private-manufacturer-source-path'::text), true
             ),
             '{quote,specs,interiorDoor}', jsonb_build_object('brand', 'legacy-raw-out-of-scope-interior'), true
           ),
           '{quote,specs,exteriorDoor}', jsonb_build_object('brand', 'legacy-raw-out-of-scope-exterior'), true
         ),
         '{token}', to_jsonb('legacy-private-snapshot-token'::text), true
       )
       WHERE id = $1`,
      [requestId, legacyShareToken],
    );
    expect(result.rowCount).toBe(1);
  } finally {
    await pool.end();
  }
}

/** Adds an excluded revision retained by a pre-filtering stored snapshot. */
async function addExcludedRevisionToScopedSnapshot(
  requestId: number,
): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      `UPDATE scoped_approval_requests
       SET snapshot = jsonb_set(
         snapshot,
         '{revisions}',
         COALESCE(snapshot->'revisions', '[]'::jsonb) || jsonb_build_array(
           jsonb_build_object(
             'id', -1,
             'quoteId', quote_id,
             'authorId', 'historical-private-author-id',
             'authorName', 'Historical Author',
             'note', 'historical excluded revision must never be public',
             'categories', jsonb_build_array('windows'),
             'excludedFromSignoff', true,
             'createdAt', '1970-01-01T00:00:00.000Z'
           )
         ),
         true
       )
       WHERE id = $1`,
      [requestId],
    );
    expect(result.rowCount).toBe(1);
  } finally {
    await pool.end();
  }
}

async function approveOnePagePacket(
  api: APIRequestContext,
  quoteId: number,
  productType: ProductType,
): Promise<Packet> {
  const bytes = await createSyntheticPdf();
  const requested = await api.post(
    apiPath(`/quotes/${quoteId}/manufacturer-packets`),
    {
      data: {
        name: "scoped-approval-packet.pdf",
        size: bytes.byteLength,
        contentType: "application/pdf",
        manufacturer: "Scoped E2E Manufacturer",
        productType,
      },
    },
  );
  expect(requested.status()).toBe(201);
  const upload = (await requested.json()) as { packet: Packet; uploadURL: string };
  expect(upload.packet.productType).toBe(productType);

  const directUpload = await api.put(upload.uploadURL, {
    headers: { "Content-Type": "application/pdf" },
    data: bytes,
  });
  expect(directUpload.status()).toBe(200);
  expect(
    (
      await api.post(
        apiPath(
          `/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/complete-upload`,
        ),
      )
    ).status(),
  ).toBe(202);
  await waitForPacket(api, quoteId, upload.packet.id, "needs_review");
  expect(
    (
      await api.patch(
        apiPath(
          `/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/redactions`,
        ),
        { data: { redactionsByPage: {} } },
      )
    ).status(),
  ).toBe(202);
  await waitForPacket(api, quoteId, upload.packet.id, "ready_for_approval");

  const approved = await api.post(
    apiPath(`/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/approve`),
  );
  expect(approved.status()).toBe(200);
  const packet = (await approved.json()) as Packet;
  expect(packet.status).toBe("approved");
  return packet;
}

async function waitForPacket(
  api: APIRequestContext,
  quoteId: number,
  packetId: number,
  expectedStatus: Packet["status"],
): Promise<Packet> {
  const deadline = Date.now() + 75_000;
  let last: Packet | undefined;
  while (Date.now() < deadline) {
    const response = await api.get(
      apiPath(`/quotes/${quoteId}/manufacturer-packets/${packetId}`),
    );
    if (response.ok()) {
      last = (await response.json()) as Packet;
      if (last.status === expectedStatus) return last;
      if (last.status === "failed") {
        throw new Error(`Packet ${packetId} failed while being prepared.`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for packet ${packetId} to reach ${expectedStatus}; last status: ${last?.status ?? "unknown"}.`,
  );
}

async function createSyntheticPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("SCOPED APPROVAL E2E PACKET", {
    x: 36,
    y: 730,
    size: 16,
    font,
  });
  page.drawText("This page is assigned to exactly one product type.", {
    x: 36,
    y: 690,
    size: 12,
    font,
  });
  return Buffer.from(await pdf.save());
}