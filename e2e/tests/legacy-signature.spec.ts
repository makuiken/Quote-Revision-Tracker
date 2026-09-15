import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { TEST_USER_EMAIL } from "../test-user";

const apiPath = (path: string) => `/api${path}`;
const createdQuoteIds = new Set<number>();

type QuoteDetail = {
  quote: { id: number };
  documentVersion: string;
};

type LegacySignatureRecord = {
  recordType: "legacy_signature_record";
  id: number;
  quoteId: number;
  quoteNumber: string;
  signerName: string;
  signerRole: "Homeowner" | "Contractor" | "Architect/Designer" | "Other";
  signatureType: "typed" | "drawn";
  signatureData: string;
  signatureDataValid: boolean;
  signedAt: string;
  validity: "signed" | "needs_resigning";
  invalidationReason: string | null;
  signedDocumentAvailable: boolean;
  signedDocumentPath: string | null;
};

test.describe("legacy signature restoration", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await page.goto("/sign-in");
    await clerk.loaded({ page });
    await clerk.signIn({ page, emailAddress: TEST_USER_EMAIL });
  });

  test.afterEach(async ({ page }) => {
    for (const quoteId of createdQuoteIds) {
      const response = await page.context().request.delete(apiPath(`/quotes/${quoteId}`));
      expect(response.status()).toBe(204);
    }
    createdQuoteIds.clear();
  });

  test("shows typed and drawn records from both entry points without current-content leakage", async ({
    page,
  }) => {
    const api = page.context().request;
    const typedQuoteId = await createQuote(api, "Legacy typed current spec sentinel");
    const drawnQuoteId = await createQuote(api, "Legacy drawn current spec sentinel");

    const typed = await signLegacy(api, typedQuoteId, {
      signatureType: "typed",
      signatureData: "Typed Legacy Signer",
      customerName: "Typed Legacy Signer",
      stakeholderRole: "Homeowner",
    });
    const drawnData = await createDrawnPng(page);
    const drawn = await signLegacy(api, drawnQuoteId, {
      signatureType: "drawn",
      signatureData: drawnData,
      customerName: "Drawn Legacy Signer",
      stakeholderRole: "Contractor",
    });
    expect(typed.signatureType).toBe("typed");
    expect(drawn.signatureType).toBe("drawn");

    // Quote-detail entry point.
    await page.goto(`/quotes/${typedQuoteId}`);
    await expect(page.getByRole("link", { name: /view legacy signature/i })).toBeVisible();
    await page.getByRole("link", { name: /view legacy signature/i }).click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${typedQuoteId}/legacy-signature$`));
    await expect(page.getByRole("heading", { name: "Legacy signature record", level: 1 })).toBeVisible();
    await expect(page.getByText("Typed Legacy Signer", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Original typed signature", { exact: true })).toBeVisible();
    await expect(page.getByText("Legacy typed current spec sentinel", { exact: true })).not.toBeVisible();
    await expect(page.getByText("Current legacy validity", { exact: true })).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.getByText(/This printable record contains only the original stored signature fields/i)).toBeVisible();
    await page.emulateMedia({ media: "screen" });

    // Signoff-setup entry point and drawn rendering.
    await page.goto(`/quotes/${drawnQuoteId}/signoff`);
    await expect(page.getByRole("link", { name: /view legacy signature/i })).toBeVisible();
    await page.getByRole("link", { name: /view legacy signature/i }).click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${drawnQuoteId}/legacy-signature$`));
    await expect(page.getByText("Drawn Legacy Signer", { exact: true })).toBeVisible();
    await expect(page.getByAltText("Original drawn signature")).toBeVisible();
    await page.screenshot({ path: "test-results/legacy-signature-preview.png", fullPage: true });
    await expect(page.getByText("Legacy drawn current spec sentinel", { exact: true })).not.toBeVisible();
  });

  test("keeps invalidated records viewable and labels a missing original PDF", async ({ page }) => {
    const api = page.context().request;
    const quoteId = await createQuote(api, "Legacy invalidated current spec sentinel");
    const record = await signLegacy(api, quoteId, {
      signatureType: "typed",
      signatureData: "Invalidated Legacy Signer",
      customerName: "Invalidated Legacy Signer",
      stakeholderRole: "Other",
    });

    const revision = await api.post(apiPath(`/quotes/${quoteId}/revisions`), {
      data: { note: "Current revision must never appear in legacy record" },
    });
    expect(revision.status()).toBe(201);

    const current = await api.get(apiPath(`/quotes/${quoteId}/legacy-signature`));
    expect(current.status()).toBe(200);
    const currentRecord = (await current.json()) as LegacySignatureRecord;
    expect(currentRecord.id).toBe(record.id);
    expect(currentRecord.validity).toBe("needs_resigning");

    // Exercise the no-PDF printable path with the same server-shaped record,
    // without mutating the stored signature row or fabricating a document.
    await page.route(apiPath(`/quotes/${quoteId}/legacy-signature`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...currentRecord,
          signedDocumentAvailable: false,
          signedDocumentPath: null,
        }),
      });
    });
    await page.goto(`/quotes/${quoteId}/legacy-signature`);
    await expect(page.getByText("Needs re-signing", { exact: true })).toBeVisible();
    await expect(page.getByText(/original full-document PDF was not saved/i)).toBeVisible();
    await expect(page.getByText(/No signed document can be reconstructed/i)).toBeVisible();
    await expect(page.getByText("Current revision must never appear in legacy record", { exact: true })).not.toBeVisible();
  });

  test("denies anonymous access and reports a missing record", async ({ page, request }) => {
    const quoteId = await createQuote(page.context().request, "Legacy missing-record sentinel");
    const anonymous = await request.get(apiPath(`/quotes/${quoteId}/legacy-signature`));
    expect(anonymous.status()).toBe(401);

    const missing = await page.context().request.get(apiPath("/quotes/999999999/legacy-signature"));
    expect(missing.status()).toBe(404);
    await page.goto("/quotes/999999999/legacy-signature");
    await expect(page.getByText(/quote or legacy signature record was not found/i)).toBeVisible();
  });
});

async function createQuote(api: APIRequestContext, sentinel: string): Promise<number> {
  const unique = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const quoteNumber = String(1_000_000 + (Number(unique.slice(-7)) % 9_000_000));
  const response = await api.post(apiPath("/quotes"), {
    data: {
      quoteNumber,
      customerName: "Legacy signature E2E customer",
      projectName: sentinel,
      jobAddress: "1 Legacy Evidence Way",
      categories: ["windows"],
      specs: { window: { brand: sentinel, series: "Current-only series" } },
    },
  });
  expect(response.status()).toBe(201);
  const quote = (await response.json()) as { id: number };
  createdQuoteIds.add(quote.id);
  return quote.id;
}

async function signLegacy(
  api: APIRequestContext,
  quoteId: number,
  input: {
    signatureType: "typed" | "drawn";
    signatureData: string;
    customerName: string;
    stakeholderRole: LegacySignatureRecord["signerRole"];
  },
): Promise<LegacySignatureRecord> {
  const detailResponse = await api.get(apiPath(`/quotes/${quoteId}`));
  expect(detailResponse.status()).toBe(200);
  const detail = (await detailResponse.json()) as QuoteDetail;
  const response = await api.put(apiPath(`/quotes/${quoteId}/signoff`), {
    data: {
      customerName: input.customerName,
      stakeholderRole: input.stakeholderRole,
      signatureType: input.signatureType,
      signatureData: input.signatureData,
      documentVersion: detail.documentVersion,
    },
  });
  expect(response.status()).toBe(200);

  const recordResponse = await api.get(apiPath(`/quotes/${quoteId}/legacy-signature`));
  expect(recordResponse.status()).toBe(200);
  return (await recordResponse.json()) as LegacySignatureRecord;
}

async function createDrawnPng(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.strokeStyle = "#000";
    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(20, 90);
    context.lineTo(70, 30);
    context.lineTo(120, 90);
    context.lineTo(180, 35);
    context.lineTo(260, 90);
    context.stroke();
    return canvas.toDataURL("image/png");
  });
}