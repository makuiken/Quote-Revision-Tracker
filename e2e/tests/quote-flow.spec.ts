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
const quoteNumber = `E2E-${runId}`;
const customerName = `E2E Customer ${runId}`;

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
});

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
