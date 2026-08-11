import { test, expect, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { TEST_USER_EMAIL } from "../test-user";

/**
 * End-to-end pass over the quote-to-signoff flow:
 * sign in (setup project) -> create quote with category specs -> add revision
 * entries -> print pages render -> typed signature -> editing clears signoff
 * -> drawn signature -> editing clears it again.
 */

const runId = Date.now().toString(36);
// BisTrack quote numbers are exactly 7 digits.
const quoteNumber = String(1000000 + (Date.now() % 9000000));
const customerName = `E2E Customer ${runId}`;
const projectName = `E2E Project ${runId}`;
const jobAddress = "123 Test Lane, Fair Lawn, NJ";

let quoteUrl: string;

test.describe.serial("quote-to-signoff flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await page.goto("/sign-in");
    await clerk.loaded({ page });
    // Ticket-based sign-in (via a backend-created sign-in token) — bypasses
    // bot protection, which blocks password sign-ins in headless browsers.
    await clerk.signIn({ page, emailAddress: TEST_USER_EMAIL });
  });

  test("create quote with category specs", async ({ page }) => {
    await page.goto("/quotes/new");
    await page.locator("#quoteNumber").fill(quoteNumber);
    await page.locator("#customerName").fill(customerName);
    await page.locator("#projectName").fill(projectName);
    await page.locator("#jobAddress").fill(jobAddress);

    // Select the Windows category card and fill its specs.
    await page.getByText("Windows", { exact: true }).click();
    await page.locator("#window\\.brand").fill("Andersen");
    await page.locator("#window\\.series").fill("400 Series");
    await page.locator("#window\\.exteriorColor").fill("Forest Green");

    await page.getByRole("button", { name: /create quote/i }).click();
    await expect(page).toHaveURL(/\/quotes\/\d+$/);
    quoteUrl = new URL(page.url()).pathname;

    await expect(page.getByText(quoteNumber).first()).toBeVisible();
    await expect(page.getByText(customerName).first()).toBeVisible();
    await expect(page.getByText("Andersen").first()).toBeVisible();
  });

  test("add revision entries", async ({ page }) => {
    await page.goto(quoteUrl);
    await page.locator("#note").fill("Changed jamb depth per customer request");
    await page.getByRole("button", { name: /add update/i }).click();
    await expect(
      page.getByText("Changed jamb depth per customer request"),
    ).toBeVisible();

    await page.locator("#note").fill("Confirmed hardware finish with supplier");
    await page.getByRole("button", { name: /add update/i }).click();
    await expect(
      page.getByText("Confirmed hardware finish with supplier"),
    ).toBeVisible();
  });

  test("print log page renders the revision history", async ({ page }) => {
    await page.goto(`${quoteUrl}/print-log`);
    await expect(page.getByText(quoteNumber).first()).toBeVisible();
    await expect(
      page.getByText("Changed jamb depth per customer request"),
    ).toBeVisible();
    await expect(
      page.getByText("Confirmed hardware finish with supplier"),
    ).toBeVisible();
  });

  test("signoff page renders the quote document", async ({ page }) => {
    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(quoteNumber).first()).toBeVisible();
    await expect(page.getByText("Andersen").first()).toBeVisible();
  });

  test("save a typed signature", async ({ page }) => {
    await page.goto(`${quoteUrl}/signoff`);
    await page.getByRole("button", { name: /type name/i }).click();
    await page.locator("#typedName").fill(customerName);
    await page.getByRole("button", { name: /confirm signature/i }).click();
    await expect(page.getByText(/electronically signed/i)).toBeVisible();
    await expect(page.getByText(customerName).first()).toBeVisible();
  });

  test("editing a signed quote clears the typed signoff", async ({ page }) => {
    await editQuoteNotes(page, "Edited after typed signature");
    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(page.getByRole("button", { name: /type name/i })).toBeVisible();
  });

  test("save a drawn signature", async ({ page }) => {
    await page.goto(`${quoteUrl}/signoff`);
    await page.getByRole("button", { name: /draw signature/i }).click();

    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("signature canvas has no bounding box");
    await page.mouse.move(box.x + 30, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 60, { steps: 10 });
    await page.mouse.move(box.x + 220, box.y + 130, { steps: 10 });
    await page.mouse.up();

    await page.getByRole("button", { name: /confirm signature/i }).click();
    await expect(page.getByText(/electronically signed/i)).toBeVisible();
    await expect(page.getByAltText("Customer Signature")).toBeVisible();
  });

  test("editing a signed quote clears the drawn signoff", async ({ page }) => {
    await editQuoteNotes(page, "Edited after drawn signature");
    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: /draw signature/i }),
    ).toBeVisible();
  });

  test("adding a revision to a signed quote warns and clears the signature", async ({ page }) => {
    await signTyped(page);

    await page.goto(quoteUrl);
    await page.locator("#note").fill("New revision after signing");
    await page.getByRole("button", { name: /add update/i }).click();
    // Warning dialog: confirm signature removal.
    await page
      .getByRole("button", { name: /remove signature & add update/i })
      .click();
    await expect(page.getByText("New revision after signing")).toBeVisible();

    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
  });

  test("hiding a revision on a signed quote warns and clears the signature", async ({ page }) => {
    await signTyped(page);

    await page.goto(`${quoteUrl}/signoff`);
    await page
      .getByRole("button", { name: /hide from signoff/i })
      .first()
      .click();
    // Warning dialog: confirm signature removal.
    await page
      .getByRole("button", { name: /remove signature & continue/i })
      .click();
    await expect(
      page.getByRole("button", { name: /include on signoff/i }).first(),
    ).toBeVisible();
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();

    // Re-include so the document returns to full content.
    await page
      .getByRole("button", { name: /include on signoff/i })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: /include on signoff/i }),
    ).not.toBeVisible();
  });

  test("signing with a stale document version is rejected", async ({ page }) => {
    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByRole("button", { name: /type name/i })).toBeVisible();
    const quoteId = quoteUrl.split("/").pop();
    const status = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/signoff`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Stale Signer",
          signatureType: "typed",
          signatureData: "Stale Signer",
          documentVersion: "0000000000000000000000000000000000000000",
        }),
      });
      return res.status;
    }, quoteId);
    expect(status).toBe(409);
    // No signature was stored.
    await page.reload();
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
  });

  test("archiving and restoring a signed quote clears the signature and blocks archived exclusion edits", async ({ page }) => {
    await signTyped(page);
    const quoteId = quoteUrl.split("/").pop();

    // Archive the signed quote via the API (auth cookies from the page context).
    const archive = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "E2E archive test" }),
      });
      return res.status;
    }, quoteId);
    expect(archive).toBe(200);

    // Exclusion toggles are rejected while archived.
    const excluded = await page.evaluate(async (id) => {
      const list = await fetch(`/api/quotes/${id}`).then((r) => r.json());
      const revisionId = list.revisions[0].id;
      const res = await fetch(
        `/api/quotes/${id}/revisions/${revisionId}/signoff-exclusion`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ excludedFromSignoff: true }),
        },
      );
      return res.status;
    }, quoteId);
    expect(excluded).toBe(400);

    // New revisions are also rejected while archived (the create-revision
    // transaction re-validates archive state under the quote-row lock, so
    // this holds even when the archive commits mid-request).
    const revisionWhileArchived = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "Should be rejected" }),
      });
      return res.status;
    }, quoteId);
    expect(revisionWhileArchived).toBe(400);

    // Attachment deletion is also rejected while archived (checked under the
    // quote-row lock before the attachment is even looked up).
    const attachmentDeleteWhileArchived = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/attachments/999999`, {
        method: "DELETE",
      });
      return res.status;
    }, quoteId);
    expect(attachmentDeleteWhileArchived).toBe(400);

    // Restore, then verify the quote is no longer signed: the archive/restore
    // entries changed the revision log, so the old signature is invalid.
    const restore = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/unarchive`, { method: "POST" });
      return res.status;
    }, quoteId);
    expect(restore).toBe(200);

    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(page.getByRole("button", { name: /type name/i })).toBeVisible();
  });
});

/** Sign the quote with a typed signature (from an unsigned state). */
async function signTyped(page: Page): Promise<void> {
  await page.goto(`${quoteUrl}/signoff`);
  await page.getByRole("button", { name: /type name/i }).click();
  await page.locator("#typedName").fill(customerName);
  await page.getByRole("button", { name: /confirm signature/i }).click();
  await expect(page.getByText(/electronically signed/i)).toBeVisible();
}

/** Edit the quote via the detail page, accepting the signature-removal warning if shown. */
async function editQuoteNotes(page: Page, notes: string): Promise<void> {
  await page.goto(quoteUrl);
  await page.getByRole("button", { name: /edit quote/i }).click();
  const notesField = page.getByPlaceholder(/overarching notes|delivery instructions/i);
  await notesField.fill(notes);
  await page.getByRole("button", { name: /save changes/i }).click();
  const removeAndSave = page.getByRole("button", {
    name: /remove signature & save/i,
  });
  if (await removeAndSave.isVisible({ timeout: 3000 }).catch(() => false)) {
    await removeAndSave.click();
  }
  await expect(page.getByRole("button", { name: /edit quote/i })).toBeVisible();
}
