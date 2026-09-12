import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import pg from "pg";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  PDFDocument,
  StandardFonts,
  rgb,
} from "../../artifacts/api-server/node_modules/pdf-lib/cjs/index.js";
import { TEST_USER_EMAIL } from "../test-user";

/**
 * These are API regression tests. The page fixture is used only for the
 * existing Clerk ticket-based sign-in setup; all assertions and application
 * traffic below use the authenticated BrowserContext APIRequestContext.
 */

type PacketStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "needs_review"
  | "ready_for_approval"
  | "approved"
  | "failed";

type Packet = {
  id: number;
  quoteId: number;
  originalName: string;
  status: PacketStatus;
  pageCount: number | null;
  analysis: Array<{
    pageNumber: number;
    width: number;
    height: number;
    pageType: string;
    suggestedRects: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      reason?: string;
    }>;
  }> | null;
  manualRedactions: Record<string, unknown[]> | null;
  [key: string]: unknown;
};

type QuoteDetail = {
  quote: { id: number };
  documentVersion: string;
  signoff: unknown;
};

const apiPath = (path: string): string => `/api${path}`;

function publicPacketPagePath(
  token: string,
  pageNumber: number,
  documentVersion: string,
): string {
  const encodedToken = encodeURIComponent(token);
  const encodedVersion = encodeURIComponent(documentVersion);
  return apiPath(
    `/public/signoff/${encodedToken}/packet/pages/${pageNumber}?documentVersion=${encodedVersion}`,
  );
}

test.describe("manufacturer packet API contract", () => {
  test.beforeEach(async ({ page }) => {
    await authenticateApiContext(page);
  });

  test("uploads through the signed URL, queues review, and keeps unapproved bytes private", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const api = page.context().request;
    const quoteId = await createSyntheticQuote(api);
    const token = await createShareToken(api, quoteId);

    // Invalid metadata is rejected before a packet row or upload URL exists.
    const invalidMetadata = await api.post(
      apiPath(`/quotes/${quoteId}/manufacturer-packets`),
      {
        data: {
          name: "not-a-pdf.txt",
          size: 1,
          contentType: "text/plain",
        },
      },
    );
    expect(invalidMetadata.status()).toBe(400);

    // Completing an upload before the direct PUT is explicitly rejected.
    const pending = await requestPacketUpload(api, quoteId, {
      name: "synthetic-pending.pdf",
      size: 128,
      manufacturer: "Andersen",
    });
    const prematureComplete = await api.post(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${pending.packet.id}/complete-upload`,
      ),
    );
    expect(prematureComplete.status()).toBe(400);

    const filename = "synthetic-andersen-packet.pdf";
    const sourceBytes = await createSyntheticPdf([
      "SYNTHETIC ADMIN HEADER",
      "SYNTHETIC PRODUCT SPECIFICATION",
    ]);
    const upload = await requestPacketUpload(api, quoteId, {
      name: filename,
      size: sourceBytes.byteLength,
      manufacturer: "Andersen",
    });
    expect(upload.packet.status).toBe("awaiting_upload");
    expect(upload.packet.originalName).toBe(filename);
    expect(upload.packet).not.toHaveProperty("uploadObjectPath");
    expect(upload.packet).not.toHaveProperty("sourceObjectPath");
    expect(upload.packet).not.toHaveProperty("sanitizedPdfObjectPath");

    // The PDF bytes go directly to the quote-bound signed URL, not through
    // the JSON API.
    const directPut = await api.put(upload.uploadURL, {
      headers: { "Content-Type": "application/pdf" },
      data: sourceBytes,
    });
    expect(directPut.status()).toBe(200);

    const completed = await api.post(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/complete-upload`,
      ),
    );
    expect(completed.status()).toBe(202);

    const needsReview = await waitForPacket(
      api,
      quoteId,
      upload.packet.id,
      "needs_review",
    );
    expect(needsReview.pageCount).toBe(2);
    expect(needsReview.analysis).toHaveLength(2);
    expect(needsReview.manualRedactions).toBeNull();
    expect(needsReview.analysis?.map((page) => page.pageNumber)).toEqual([
      1, 2,
    ]);

    // Employee source review returns the exact immutable original, but the
    // response does not reveal a storage key or an original filename header.
    const source = await api.get(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/source`,
      ),
    );
    expect(source.status()).toBe(200);
    expect(await source.body()).toEqual(sourceBytes);
    expect(source.headers()["content-disposition"] ?? "").not.toContain(
      filename,
    );
    const unauthenticatedSource = await request.get(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/source`,
      ),
    );
    expect(unauthenticatedSource.status()).toBe(401);

    // Sanitized page bytes cannot be read until review has been confirmed.
    const pendingPreview = await api.get(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/pages/1`,
      ),
    );
    expect(pendingPreview.status()).toBe(404);

    // Invalid tokens never disclose quote or packet state.
    for (const path of [
      "/public/signoff",
      "/public/signoff/not-a-real-token",
      "/public/signoff/not-a-real-token/packet",
      "/public/signoff/not-a-real-token/packet/pages/1?documentVersion=invalid",
    ]) {
      const response = await api.get(apiPath(path));
      expect(response.status()).toBe(404);
    }

    // A share link exists before approval, but the public packet routes expose
    // neither source bytes nor an unapproved packet.
    const publicPacket = await api.get(
      apiPath(`/public/signoff/${token}/packet`),
    );
    expect(publicPacket.status()).toBe(404);
    const beforeApproval = await getPublicSignoff(api, token);
    const publicPage = await api.get(
      publicPacketPagePath(token, 1, beforeApproval.documentVersion),
    );
    expect(publicPage.status()).toBe(404);
  });

  test("redacts, approves, orders multiple packets, invalidates stale signatures, and downloads the signed snapshot", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const api = page.context().request;
    const quoteId = await createSyntheticQuote(api);
    const token = await createShareToken(api, quoteId);

    const firstFilename = "synthetic-first-manufacturer-packet.pdf";
    const firstBytes = await createSyntheticPdf([
      "FIRST PACKET ADMIN HEADER",
      "FIRST PACKET PRODUCT SPECIFICATION",
    ]);
    const first = await uploadAndQueuePacket(api, quoteId, {
      name: firstFilename,
      bytes: firstBytes,
      manufacturer: "Andersen",
    });
    const firstAnalysis = first.needsReview.analysis;
    expect(firstAnalysis).toHaveLength(2);
    const firstPage = firstAnalysis?.[0];
    if (!firstPage) throw new Error("Synthetic first packet analysis is empty");

    // Coordinates are top-left PDF points. Suggestions remain unapplied until
    // this explicit reviewer selection is sent.
    const redactions = {
      "1": [
        {
          x: 0,
          y: 0,
          width: Math.min(160, firstPage.width),
          height: Math.min(28, firstPage.height),
          reason: "Synthetic administrative header",
        },
      ],
    };
    const confirmed = await api.patch(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${first.packet.id}/redactions`,
      ),
      { data: { redactionsByPage: redactions } },
    );
    expect(confirmed.status()).toBe(202);
    const firstReady = await waitForPacket(
      api,
      quoteId,
      first.packet.id,
      "ready_for_approval",
    );
    expect(firstReady.manualRedactions).toEqual(redactions);

    const firstSanitizedPages = await getInternalPacketPages(
      api,
      quoteId,
      first.packet.id,
      2,
    );
    for (const page of firstSanitizedPages) {
      expect(page.status()).toBe(200);
      expect(page.headers()["content-type"]).toContain("image/png");
      expect((await page.body()).byteLength).toBeGreaterThan(0);
    }

    // Exercise the authenticated reviewer surface with the same Clerk page
    // session used for the API contract, including source preview and a
    // rectangle interaction before the API redaction assertion above.
    await page.goto(`/quotes/${quoteId}/packets`);
    await page.getByRole("button", { name: `Open ${firstFilename}`, exact: true }).click();
    await expect(page.getByText("Step 2: Review & Redact", { exact: true })).toBeVisible();
    await expect(page.getByAltText("Original manufacturer page 1")).toBeVisible();
    await expect(page.getByAltText("Original manufacturer page 1")).toHaveJSProperty("complete", true);
    const editor = page.locator('[data-rect-index]').first();
    await expect(editor).toBeVisible();
    const editorBox = await editor.boundingBox();
    if (!editorBox) throw new Error("Redaction rectangle is not laid out");
    await page.mouse.move(editorBox.x + 20, editorBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(editorBox.x + 30, editorBox.y + 30);
    await page.mouse.up();
    const handle = page.locator('[data-resize-handle]').first();
    await expect(handle).toBeVisible();
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("Redaction resize handle is not laid out");
    await page.mouse.move(handleBox.x + 2, handleBox.y + 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 10, handleBox.y + 10);
    await page.mouse.up();

    // The redaction actions must work as real controls, not just as hover
    // decoration. The page-selection dialog should let the reviewer choose
    // page 2 even when its first/continuation label differs, without
    // duplicating the box on the page where it already exists.
    await editor.hover();
    const applyToSimilar = page.getByTestId("button-redaction-apply-similar-0");
    await expect(applyToSimilar).toBeVisible();
    await applyToSimilar.click();
    const pageTwoTarget = page.getByRole("checkbox", { name: "Page 2", exact: true });
    await expect(pageTwoTarget).toBeVisible();
    await pageTwoTarget.check();
    await page.getByTestId("button-confirm-apply-redaction").click();
    await expect(page.getByText("Redaction added to 1 selected page.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Page 2/ }).click();
    await expect(page.locator("[data-rect-index]")).toHaveCount(1);

    // Delete the copied redaction through the visible, keyboard-accessible
    // action button and verify that the original page remains unchanged.
    const removeRedaction = page.getByTestId("button-redaction-remove-0");
    await expect(removeRedaction).toBeVisible();
    await removeRedaction.click();
    await expect(page.locator("[data-rect-index]")).toHaveCount(0);
    await page.getByRole("button", { name: /^Page 1/ }).click();
    await expect(page.locator("[data-rect-index]")).toHaveCount(1);

    await page.screenshot({ path: `test-results/manufacturer-packet-source-${quoteId}.png`, fullPage: true });

    // Per-packet approve remains a convenience action and publishes all pages
    // in source order.
    const approved = await api.post(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${first.packet.id}/approve`,
      ),
    );
    expect(approved.status()).toBe(200);
    expect(((await approved.json()) as Packet).status).toBe("approved");
    const firstManifest = await getManifest(api, quoteId);
    expect(firstManifest.entries).toEqual([
      { packetId: first.packet.id, pageNumber: 1, pageOrder: 1 },
      { packetId: first.packet.id, pageNumber: 2, pageOrder: 2 },
    ]);

    const approvedPublicMetadata = await api.get(
      apiPath(`/public/signoff/${token}/packet`),
    );
    expect(approvedPublicMetadata.status()).toBe(200);
    const metadata = (await approvedPublicMetadata.json()) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(["approvedAt", "id", "manufacturer", "pageCount"]);
    expect(metadata).not.toHaveProperty("originalName");
    expect(metadata).not.toHaveProperty("analysis");
    expect(metadata).not.toHaveProperty("sourceObjectPath");
    expect(metadata.pageCount).toBe(2);

    const beforeSigning = await getPublicSignoff(api, token);
    const publicFirstPage = await api.get(publicPacketPagePath(token, 1, beforeSigning.documentVersion));
    const publicSecondPage = await api.get(publicPacketPagePath(token, 2, beforeSigning.documentVersion));
    expect(publicFirstPage.status()).toBe(200);
    expect(publicSecondPage.status()).toBe(200);
    expect(await publicFirstPage.body()).toEqual(await firstSanitizedPages[0]!.body());
    expect(await publicSecondPage.body()).toEqual(await firstSanitizedPages[1]!.body());
    expect((await api.get(publicPacketPagePath(token, 3, beforeSigning.documentVersion))).status()).toBe(404);

    const unsignedPublic = await api.get(
      apiPath(`/public/signoff/${token}/document`),
    );
    expect(unsignedPublic.status()).toBe(200);
    expect(unsignedPublic.headers()["content-type"]).toContain(
      "application/pdf",
    );
    expect(unsignedPublic.headers()["content-disposition"] ?? "").not.toContain(
      firstFilename,
    );
    expect((await unsignedPublic.body()).subarray(0, 5).toString()).toBe(
      "%PDF-",
    );

    const signature = await signPublicDocument(
      api,
      token,
      beforeSigning.documentVersion,
    );
    expect(signature.status()).toBe(200);
    const signedDetail = await getPublicSignoff(api, token);
    expect(signedDetail.signoff).not.toBeNull();

    const internalSigned = await api.get(
      apiPath(`/quotes/${quoteId}/signoff/document`),
    );
    expect(internalSigned.status()).toBe(200);
    expect(internalSigned.headers()["content-type"]).toContain(
      "application/pdf",
    );
    expect(internalSigned.headers()["content-disposition"] ?? "").not.toContain(
      firstFilename,
    );
    const signedBytes = await internalSigned.body();
    expect(signedBytes.subarray(0, 5).toString()).toBe("%PDF-");
    const signedPdf = await PDFDocument.load(signedBytes);
    // Quote/specifications, revisions, terms, signature, and the two packet
    // pages are all part of the downloadable immutable snapshot.
    expect(signedPdf.getPageCount()).toBeGreaterThan(4);

    const publicSigned = await api.get(
      apiPath(`/public/signoff/${token}/document`),
    );
    expect(publicSigned.status()).toBe(200);
    expect(await publicSigned.body()).toEqual(signedBytes);
    expect(publicSigned.headers()["content-disposition"] ?? "").not.toContain(
      firstFilename,
    );

    // Emulate a pre-feature signature lacking snapshot fields. Both download
    // paths must backfill a SIGNED artifact without changing signer identity.
    const legacyPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      for (const downloadPath of [
        `/quotes/${quoteId}/signoff/document`,
        `/public/signoff/${token}/document`,
      ]) {
        const beforeLegacy = await legacyPool.query(
          "SELECT signed_at, customer_name, signature_data FROM signoffs WHERE quote_id = $1",
          [quoteId],
        );
        await legacyPool.query(
          "UPDATE signoffs SET signed_document_object_path = NULL, signed_document_sha256 = NULL WHERE quote_id = $1",
          [quoteId],
        );
        const migratedDownload = await api.get(apiPath(downloadPath));
        expect(migratedDownload.status()).toBe(200);
        const afterLegacy = await legacyPool.query(
          "SELECT signed_at, customer_name, signature_data, signed_document_object_path, signed_document_sha256, signed_packet_sha256 FROM signoffs WHERE quote_id = $1",
          [quoteId],
        );
        expect(afterLegacy.rows[0].signed_at).toEqual(beforeLegacy.rows[0].signed_at);
        expect(afterLegacy.rows[0].customer_name).toBe(beforeLegacy.rows[0].customer_name);
        expect(afterLegacy.rows[0].signature_data).toBe(beforeLegacy.rows[0].signature_data);
        expect(afterLegacy.rows[0].signed_document_object_path).toBeTruthy();
        expect(afterLegacy.rows[0].signed_document_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(afterLegacy.rows[0].signed_packet_sha256).toMatch(/^[a-f0-9]{64}$/);
        const repeatedDownload = await api.get(apiPath(downloadPath));
        expect(await repeatedDownload.body()).toEqual(await migratedDownload.body());
      }
    } finally {
      await legacyPool.end();
    }

    const secondFilename = "synthetic-second-manufacturer-packet.pdf";
    const secondBytes = await createSyntheticPdf([
      "SECOND PACKET ADMIN HEADER",
      "SECOND PACKET PRODUCT SPECIFICATION",
    ]);
    const second = await uploadAndQueuePacket(api, quoteId, {
      name: secondFilename,
      bytes: secondBytes,
      manufacturer: "Marvin",
    });
    const secondReadyRequest = await api.patch(
      apiPath(
        `/quotes/${quoteId}/manufacturer-packets/${second.packet.id}/redactions`,
      ),
      { data: { redactionsByPage: {} } },
    );
    expect(secondReadyRequest.status()).toBe(202);
    const secondReady = await waitForPacket(
      api,
      quoteId,
      second.packet.id,
      "ready_for_approval",
    );
    expect(secondReady.pageCount).toBe(2);
    const secondSanitizedPages = await getInternalPacketPages(
      api,
      quoteId,
      second.packet.id,
      2,
    );

    // Two reviewable PDFs with identical dimensions must retain distinct boxes.
    const thirdFilename = "synthetic-review-state-isolation.pdf";
    const third = await uploadAndQueuePacket(api, quoteId, {
      name: thirdFilename,
      bytes: await createSyntheticPdf(["THIRD ADMIN FIELD"]),
      manufacturer: "Marvin",
    });
    const thirdCleanup = await api.patch(
      apiPath(`/quotes/${quoteId}/manufacturer-packets/${third.packet.id}/redactions`),
      { data: { redactionsByPage: { "1": [{ x: 20, y: 20, width: 80, height: 20 }] } } },
    );
    expect(thirdCleanup.status()).toBe(202);
    await waitForPacket(api, quoteId, third.packet.id, "ready_for_approval");
    await page.goto(`/quotes/${quoteId}/packets`);
    await page.getByRole("button", { name: `Open ${thirdFilename}`, exact: true }).click();
    await expect(page.locator("[data-rect-index]")).toHaveCount(1);
    await page.getByRole("button", { name: `Open ${secondFilename}`, exact: true }).click();
    await expect(page.locator("[data-rect-index]")).toHaveCount(0);
    await page.getByRole("button", { name: `Open ${thirdFilename}`, exact: true }).click();
    await expect(page.locator("[data-rect-index]")).toHaveCount(1);

    const publishedVersion = beforeSigning.documentVersion;
    const manifest = await api.put(
      apiPath(`/quotes/${quoteId}/manufacturer-packet-manifest`),
      {
        data: {
          // Exclude first packet page 1 and second packet page 2, and
          // deliberately interleave the remaining pages.
          entries: [
            { packetId: first.packet.id, pageNumber: 2, pageOrder: 1 },
            { packetId: second.packet.id, pageNumber: 1, pageOrder: 2 },
          ],
        },
      },
    );
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).entries).toEqual([
      { packetId: first.packet.id, pageNumber: 2, pageOrder: 1 },
      { packetId: second.packet.id, pageNumber: 1, pageOrder: 2 },
    ]);

    // Publishing a different packet set/order invalidates the existing
    // signoff and makes its previously loaded document version stale.
    const afterPublication = await getPublicSignoff(api, token);
    expect(afterPublication.documentVersion).not.toBe(publishedVersion);
    expect(afterPublication.signoff).toBeNull();
    const staleAfterPublication = await signPublicDocument(
      api,
      token,
      publishedVersion,
    );
    expect(staleAfterPublication.status()).toBe(409);
    const stalePageAfterPublication = await api.get(
      publicPacketPagePath(token, 1, publishedVersion),
    );
    expect(stalePageAfterPublication.status()).toBe(409);

    const orderedPublicPage1 = await api.get(
      publicPacketPagePath(token, 1, afterPublication.documentVersion),
    );
    const orderedPublicPage2 = await api.get(
      publicPacketPagePath(token, 2, afterPublication.documentVersion),
    );
    expect(await orderedPublicPage1.body()).toEqual(
      await secondPageBody(firstSanitizedPages[1]!),
    );
    expect(await orderedPublicPage2.body()).toEqual(
      await secondPageBody(secondSanitizedPages[0]!),
    );
    expect(
      (
        await api.get(
          publicPacketPagePath(token, 3, afterPublication.documentVersion),
        )
      ).status(),
    ).toBe(404);

    expect((await api.get(apiPath(
      `/quotes/${quoteId}/manufacturer-packet-manifest?documentVersion=${publishedVersion}`,
    ))).status()).toBe(409);
    expect((await api.get(apiPath(
      `/quotes/${quoteId}/manufacturer-packets/${first.packet.id}/pages/1?documentVersion=${afterPublication.documentVersion}`,
    ))).status()).toBe(404);

    // A refreshed internal quote version cannot sign while its manifest is delayed.
    let releaseInternal!: () => void;
    const internalHold = new Promise<void>((resolve) => { releaseInternal = resolve; });
    const internalRoute = `**/api/quotes/${quoteId}/manufacturer-packet-manifest?documentVersion=*`;
    await page.route(internalRoute, async (route) => {
      await internalHold;
      await route.continue();
    });
    await page.goto(`/quotes/${quoteId}/signoff`);
    await expect(page.getByText("Cannot sign: Loading manufacturer packet specifications...")).toBeVisible();
    await expect(page.getByLabel("Your full legal name")).toHaveCount(0);
    releaseInternal();
    await expect(page.getByLabel("Your full legal name")).toBeVisible();
    await page.unroute(internalRoute);

    // Discovery itself must block signing, before the app knows a packet exists.
    let releaseMetadata!: () => void;
    const metadataHold = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const metadataRoute = `**/api/public/signoff/${token}/packet`;
    await page.route(metadataRoute, async (route) => {
      await metadataHold;
      await route.continue();
    });
    await page.goto(`/sign/${token}`);
    await expect(page.getByText("Cannot sign: Loading manufacturer packet specifications...")).toBeVisible();
    await expect(page.getByLabel("Your full legal name")).toHaveCount(0);
    releaseMetadata();
    await expect(page.getByLabel("Your full legal name")).toBeVisible();
    await page.unroute(metadataRoute);

    const signedPublishedManifest = await signPublicDocument(
      api,
      token,
      afterPublication.documentVersion,
    );
    expect(signedPublishedManifest.status()).toBe(200);
    expect((await getPublicSignoff(api, token)).signoff).not.toBeNull();

    await page.goto(`/sign/${token}`);
    await expect(page.getByText("Manufacturer Specifications")).toBeVisible();
    await expect(page.locator('img[alt^="Packet Page"]').first()).toBeVisible();
    await expect(page.getByRole("link", { name: /download pdf/i })).toBeVisible();
    await page.screenshot({ path: `test-results/public-manufacturer-packet-${quoteId}.png`, fullPage: true });

    const unpublished = await api.delete(
      apiPath(`/quotes/${quoteId}/manufacturer-packet-manifest`),
    );
    expect(unpublished.status()).toBe(204);
    expect((await getManifest(api, quoteId)).entries).toEqual([]);
    const afterUnpublication = await getPublicSignoff(api, token);
    expect(afterUnpublication.documentVersion).not.toBe(
      afterPublication.documentVersion,
    );
    expect(afterUnpublication.signoff).toBeNull();
    expect(
      (await api.get(apiPath(`/public/signoff/${token}/packet`))).status(),
    ).toBe(404);
    expect(
      (
        await api.get(
          publicPacketPagePath(token, 1, afterUnpublication.documentVersion),
        )
      ).status(),
    ).toBe(404);
    const stalePageAfterUnpublication = await api.get(
      publicPacketPagePath(token, 1, afterPublication.documentVersion),
    );
    expect(stalePageAfterUnpublication.status()).toBe(409);

    // Unpublication is also a document mutation and rejects the version that
    // was loaded while the two-page manifest was live.
    const staleAfterUnpublication = await signPublicDocument(
      api,
      token,
      afterPublication.documentVersion,
    );
    expect(staleAfterUnpublication.status()).toBe(409);

    // With a valid parent detail but no published packet, the public page
    // remains a usable unsigned signing form rather than a fatal 404 state.
    await page.goto(`/sign/${token}`);
    await expect(page.getByText("Signoff Document")).toBeVisible();
    await expect(page.getByRole("link", { name: /download pdf/i })).toBeVisible();

    const unsignedInternal = await api.get(
      apiPath(`/quotes/${quoteId}/signoff/document/unsigned`),
    );
    expect(unsignedInternal.status()).toBe(200);
    expect(unsignedInternal.headers()["content-type"]).toContain(
      "application/pdf",
    );
    expect(
      unsignedInternal.headers()["content-disposition"] ?? "",
    ).not.toContain(firstFilename);
    expect(
      unsignedInternal.headers()["content-disposition"] ?? "",
    ).not.toContain(secondFilename);
  });

  test("blocks packet writes on archived quotes", async ({ page }) => {
    const api = page.context().request;
    const quoteId = await createSyntheticQuote(api);
    const archive = await api.post(apiPath(`/quotes/${quoteId}/archive`), {
      data: { reason: "Synthetic packet archive regression" },
    });
    expect(archive.status()).toBe(200);

    const uploadOnArchivedQuote = await api.post(
      apiPath(`/quotes/${quoteId}/manufacturer-packets`),
      {
        data: {
          name: "synthetic-archived-packet.pdf",
          size: 64,
          contentType: "application/pdf",
          manufacturer: "Andersen",
        },
      },
    );
    expect(uploadOnArchivedQuote.status()).toBe(400);

    const manifestOnArchivedQuote = await api.put(
      apiPath(`/quotes/${quoteId}/manufacturer-packet-manifest`),
      { data: { entries: [] } },
    );
    expect(manifestOnArchivedQuote.status()).toBe(400);

    const clearManifestOnArchivedQuote = await api.delete(
      apiPath(`/quotes/${quoteId}/manufacturer-packet-manifest`),
    );
    expect(clearManifestOnArchivedQuote.status()).toBe(400);
  });
});

async function authenticateApiContext(page: Page): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: TEST_USER_EMAIL });
}


async function createSyntheticQuote(api: APIRequestContext): Promise<number> {
  const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const quoteNumber = String(1000000 + (Number(unique.slice(-7)) % 9000000));
  const response = await api.post(apiPath("/quotes"), {
    data: {
      quoteNumber,
      customerName: "Synthetic Packet Customer",
      projectName: `Synthetic Packet Fixture ${unique.slice(-6)}`,
      jobAddress: "1 Synthetic Test Way",
      categories: ["windows"],
      specs: {
        window: {
          brand: "Synthetic Brand",
          series: "Synthetic Series",
          exteriorColor: "Synthetic White",
        },
      },
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id: number };
  expect(body.id).toEqual(expect.any(Number));
  return body.id;
}

async function createShareToken(
  api: APIRequestContext,
  quoteId: number,
): Promise<string> {
  const response = await api.post(apiPath(`/quotes/${quoteId}/share-link`));
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { token: string };
  expect(body.token).toEqual(expect.any(String));
  return body.token;
}

async function createSyntheticPdf(lines: readonly string[]): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.setTitle("Synthetic packet fixture");
  document.setAuthor("Automated API regression test");
  for (const [index, line] of lines.entries()) {
    const page = document.addPage([612, 792]);
    page.drawText("SYNTHETIC MANUFACTURER PACKET", {
      x: 36,
      y: 744,
      size: 18,
      font,
      color: rgb(0.08, 0.15, 0.26),
    });
    page.drawText(line, {
      x: 36,
      y: 700,
      size: 14,
      font,
      color: rgb(0.12, 0.12, 0.12),
    });
    page.drawText(`Synthetic page ${index + 1}`, {
      x: 36,
      y: 660,
      size: 11,
      font,
    });
    page.drawText("Product: Synthetic 400 Series | Finish: Synthetic White", {
      x: 36,
      y: 600,
      size: 11,
      font,
    });
  }
  return Buffer.from(await document.save());
}

async function requestPacketUpload(
  api: APIRequestContext,
  quoteId: number,
  input: { name: string; size: number; manufacturer: string },
): Promise<{ packet: Packet; uploadURL: string }> {
  const response = await api.post(
    apiPath(`/quotes/${quoteId}/manufacturer-packets`),
    {
      data: {
        name: input.name,
        size: input.size,
        contentType: "application/pdf",
        manufacturer: input.manufacturer,
      },
    },
  );
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { packet: Packet; uploadURL: string };
  expect(body.uploadURL).toMatch(/^https?:\/\//);
  return body;
}

async function uploadAndQueuePacket(
  api: APIRequestContext,
  quoteId: number,
  input: { name: string; bytes: Buffer; manufacturer: string },
): Promise<{ packet: Packet; bytes: Buffer; needsReview: Packet }> {
  const upload = await requestPacketUpload(api, quoteId, {
    name: input.name,
    size: input.bytes.byteLength,
    manufacturer: input.manufacturer,
  });
  const directPut = await api.put(upload.uploadURL, {
    headers: { "Content-Type": "application/pdf" },
    data: input.bytes,
  });
  expect(directPut.status()).toBe(200);
  const completed = await api.post(
    apiPath(
      `/quotes/${quoteId}/manufacturer-packets/${upload.packet.id}/complete-upload`,
    ),
  );
  expect(completed.status()).toBe(202);
  const needsReview = await waitForPacket(
    api,
    quoteId,
    upload.packet.id,
    "needs_review",
  );
  return { packet: upload.packet, bytes: input.bytes, needsReview };
}

async function waitForPacket(
  api: APIRequestContext,
  quoteId: number,
  packetId: number,
  expected: PacketStatus,
): Promise<Packet> {
  const deadline = Date.now() + 75_000;
  let last: Packet | null = null;
  while (Date.now() < deadline) {
    const response = await api.get(
      apiPath(`/quotes/${quoteId}/manufacturer-packets/${packetId}`),
      { failOnStatusCode: false },
    );
    if (response.ok()) {
      last = (await response.json()) as Packet;
      if (last.status === expected) return last;
      if (last.status === "failed") {
        throw new Error(
          `Packet ${packetId} failed while waiting for ${expected}: ${String(last.failureMessage)}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for packet ${packetId} to reach ${expected}; last status was ${last?.status ?? "unknown"}`,
  );
}

async function getInternalPacketPages(
  api: APIRequestContext,
  quoteId: number,
  packetId: number,
  pageCount: number,
): Promise<Array<Awaited<ReturnType<APIRequestContext["get"]>>>> {
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    pages.push(
      await api.get(
        apiPath(
          `/quotes/${quoteId}/manufacturer-packets/${packetId}/pages/${pageNumber}`,
        ),
      ),
    );
  }
  return pages;
}

async function secondPageBody(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<Buffer> {
  return response.body();
}

async function getManifest(
  api: APIRequestContext,
  quoteId: number,
): Promise<{
  entries: Array<{ packetId: number; pageNumber: number; pageOrder: number }>;
}> {
  const response = await api.get(
    apiPath(`/quotes/${quoteId}/manufacturer-packet-manifest`),
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    entries: Array<{ packetId: number; pageNumber: number; pageOrder: number }>;
  };
}

async function getPublicSignoff(
  api: APIRequestContext,
  token: string,
): Promise<QuoteDetail> {
  const response = await api.get(apiPath(`/public/signoff/${token}`));
  expect(response.status()).toBe(200);
  return (await response.json()) as QuoteDetail;
}

async function signPublicDocument(
  api: APIRequestContext,
  token: string,
  documentVersion: string,
) {
  return api.put(apiPath(`/public/signoff/${token}`), {
    data: {
      customerName: "Synthetic Signer",
      stakeholderRole: "Homeowner",
      signatureType: "typed",
      signatureData: "Synthetic Signer",
      documentVersion,
    },
    failOnStatusCode: false,
  });
}