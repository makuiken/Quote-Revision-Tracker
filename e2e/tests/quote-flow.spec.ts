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
let scopedPreviewUrl: string;

test.describe.serial("quote-to-signoff flow", () => {
  // A rate-limited public signing retry may wait through the server's
  // one-minute Retry-After window.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await page.goto("/sign-in");
    await clerk.loaded({ page });
    // Ticket-based sign-in (via a backend-created sign-in token) — bypasses
    // bot protection, which blocks password sign-ins in headless browsers.
    await clerk.signIn({ page, emailAddress: TEST_USER_EMAIL });
  });

  // This serial flow deliberately shares one quote across its tests, so it is
  // removed only after the final scenario rather than in afterEach.
  test.afterAll(async ({ browser }) => {
    if (!quoteUrl) return;
    const quoteId = Number(quoteUrl.split("/").pop());
    if (!Number.isInteger(quoteId)) {
      throw new Error(`Unable to clean up test-created quote URL: ${quoteUrl}`);
    }
    const page = await browser.newPage();
    try {
      await setupClerkTestingToken({ page });
      await page.goto("/sign-in");
      await clerk.loaded({ page });
      await clerk.signIn({ page, emailAddress: TEST_USER_EMAIL });
      const deleted = await page.context().request.delete(`/api/quotes/${quoteId}`);
      expect(deleted.status()).toBe(204);
    } finally {
      await page.close();
    }
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
    await expandProductSpecs(page);
    await expect(page.getByText("Andersen").first()).toBeVisible();
  });

  test("add revision entries", async ({ page }) => {
    await page.goto(quoteUrl);
    await revisionComposer(page).fill("Changed jamb depth per customer request");
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(
      page.getByText("Changed jamb depth per customer request"),
    ).toBeVisible();
    // Wait for the composer to reset after publishing before typing again —
    // the post-publish state update would otherwise race with the next fill.
    await expect(revisionComposer(page)).toHaveValue("");

    await revisionComposer(page).fill("Confirmed hardware finish with supplier");
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(
      page.getByText("Confirmed hardware finish with supplier"),
    ).toBeVisible();
    await expect(revisionComposer(page)).toHaveValue("");
  });

  test("draft revision notes persist, stay private, and publish", async ({ page }) => {
    const draftText = "Draft: waiting on trim pricing from supplier";
    await page.goto(quoteUrl);
    await revisionComposer(page).fill(draftText);
    await page.getByRole("button", { name: /save draft/i }).click();
    await expect(draftSavedIndicator(page)).toBeVisible();

    // Draft survives a reload and is re-hydrated into the composer.
    await page.reload();
    await expect(revisionComposer(page)).toHaveValue(draftText);
    await expect(draftSavedIndicator(page)).toBeVisible();

    // Draft is absent from the printed log.
    await page.goto(`${quoteUrl}/print-log`);
    await expect(page.getByText(draftText)).not.toBeVisible();

    // Draft is absent from the signoff document.
    await prepareExactPreview(page);
    await expect(page.getByText(draftText)).not.toBeVisible();

    // Publishing turns the draft into a normal revision entry.
    await page.goto(quoteUrl);
    await expect(revisionComposer(page)).toHaveValue(draftText);
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(
      revisionComposer(page),
    ).toHaveValue("", { timeout: 15000 });
    await expect(page.getByText(draftText)).toBeVisible();
    await expect(draftSavedIndicator(page)).not.toBeVisible();
  });

  test("discarding a draft removes it without publishing", async ({ page }) => {
    const draftText = "Draft to discard — should never publish";
    await page.goto(quoteUrl);
    await revisionComposer(page).fill(draftText);
    await page.getByRole("button", { name: /save draft/i }).click();
    await expect(draftSavedIndicator(page)).toBeVisible();

    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(revisionComposer(page)).toHaveValue("");
    await expect(draftSavedIndicator(page)).not.toBeVisible();

    await page.reload();
    await expect(revisionComposer(page)).toHaveValue("");
    await expect(page.getByText(draftText)).not.toBeVisible();
  });

  test("whitespace-only drafts are rejected without destroying anything", async ({ page }) => {
    await page.goto(quoteUrl);
    const quoteId = quoteUrl.split("/").pop();

    // Saving a whitespace-only draft is rejected.
    const saveStatus = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/revision-draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "   " }),
      });
      return res.status;
    }, quoteId);
    expect(saveStatus).toBe(400);

    // Publishing with no draft is rejected (and nothing is deleted).
    const publishStatus = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/revision-draft/publish`, {
        method: "POST",
      });
      return res.status;
    }, quoteId);
    expect(publishStatus).toBe(400);
  });

  test("delayed out-of-order auto-saves cannot resurrect a discarded draft", async ({ page }) => {
    // All draft PUTs are delayed so a second auto-save is deterministically
    // dispatched and still in flight when Discard is clicked. The client
    // write queue must keep every write ordered, and Discard (queued last)
    // must win — no delayed PUT may recreate the deleted draft.
    let putCount = 0;
    await page.route("**/revision-draft", async (route) => {
      if (route.request().method() === "PUT") {
        putCount++;
        await new Promise((r) => setTimeout(r, 2000));
      }
      await route.continue();
    });

    await page.goto(quoteUrl);
    // First auto-save (slow PUT #1)...
    await revisionComposer(page).fill("First auto-saved text");
    await page.waitForTimeout(2700);
    // ...second auto-save queues behind it (fast PUT #2)...
    await revisionComposer(page).fill("Second auto-saved text");
    await page.waitForTimeout(2700);
    // ...then discard while writes are still settling.
    await expect(page.getByRole("button", { name: /discard draft/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(revisionComposer(page)).toHaveValue("", { timeout: 20000 });
    expect(putCount).toBeGreaterThanOrEqual(2);

    // After everything settles, no draft exists on the server.
    await page.waitForTimeout(3500);
    await page.unroute("**/revision-draft");
    await page.reload();
    await expect(revisionComposer(page)).toHaveValue("");
    await expect(draftSavedIndicator(page)).not.toBeVisible();
  });

  test("delayed out-of-order auto-saves cannot overtake publish with older text", async ({ page }) => {
    let putCount = 0;
    await page.route("**/revision-draft", async (route) => {
      if (route.request().method() === "PUT") {
        putCount++;
        await new Promise((r) => setTimeout(r, 2000));
      }
      await route.continue();
    });

    await page.goto(quoteUrl);
    // Two delayed auto-saves, the second still in flight at publish time...
    await revisionComposer(page).fill("Older auto-saved text");
    await page.waitForTimeout(2700);
    await revisionComposer(page).fill("Newer auto-saved text");
    await page.waitForTimeout(2700);
    // ...then publish the latest text while writes are still settling.
    await revisionComposer(page).fill("Final published text");
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(page.getByText("Final published text")).toBeVisible({ timeout: 25000 });
    await expect(revisionComposer(page)).toHaveValue("", { timeout: 15000 });
    expect(putCount).toBeGreaterThanOrEqual(2);

    // The published entry has the latest text and no draft remains.
    await page.waitForTimeout(3500);
    await page.unroute("**/revision-draft");
    await page.reload();
    await expect(page.getByText("Final published text")).toBeVisible();
    await expect(revisionComposer(page)).toHaveValue("");
    await expect(draftSavedIndicator(page)).not.toBeVisible();
    await expect(page.getByText("Older auto-saved text")).not.toBeVisible();
    await expect(page.getByText("Newer auto-saved text")).not.toBeVisible();
  });

  test("leaving via browser back auto-saves the typed draft", async ({ page }) => {
    // Reach the quote via an in-app (SPA) navigation so browser back is a
    // popstate, not a full page load.
    await page.goto("/quotes");
    await page.getByText(quoteNumber).first().click();
    await expect(page).toHaveURL(new RegExp(`${quoteUrl}$`));

    await revisionComposer(page).fill("History nav draft text");
    const savedResponse = page.waitForResponse(
      (r) => r.url().includes("/revision-draft") && r.request().method() === "PUT" && r.ok(),
    );
    await page.goBack();
    await expect(page).toHaveURL(/\/quotes$/);
    await savedResponse;

    // The typed text survived as a draft; clean it up.
    await page.goto(quoteUrl);
    await expect(revisionComposer(page)).toHaveValue("History nav draft text");
    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(revisionComposer(page)).toHaveValue("");
  });

  test("in-app navigation with unsaved typing warns before leaving", async ({ page }) => {
    await page.goto(quoteUrl);
    await revisionComposer(page).fill("Guard test: unsaved typing");
    await page.getByRole("link", { name: /back to dashboard/i }).click();

    // Guard dialog appears; staying keeps the text and the page.
    await expect(
      page.getByRole("heading", { name: "Unsaved Draft", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Stay here", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${quoteUrl}$`));
    await expect(revisionComposer(page)).toHaveValue("Guard test: unsaved typing");

    // Make the composer dirty again, then save-and-leave.
    await revisionComposer(page).fill("Guard test: unsaved typing, extended");
    await page.getByRole("link", { name: /back to dashboard/i }).click();
    await expect(
      page.getByRole("heading", { name: "Unsaved Draft", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /save draft & leave/i }).click();
    await expect(page).toHaveURL(/\/quotes$/);

    // The draft survived the navigation; clean it up.
    await page.goto(quoteUrl);
    await expect(revisionComposer(page)).toHaveValue("Guard test: unsaved typing, extended");
    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(revisionComposer(page)).toHaveValue("");
  });

  test("revision history uses Older and Newer pages, then resets after publishing", async ({
    page,
  }) => {
    const firstPagedRevision = "Pagination fixture: first paged revision";
    const secondPagedRevision = "Pagination fixture: second paged revision";
    const resetRevision = "Pagination fixture: publish resets the current page";

    await page.goto(quoteUrl);
    await publishRevision(page, firstPagedRevision);
    await publishRevision(page, secondPagedRevision);

    // Newest revisions appear first; older entries remain accessible.
    await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
    await expect(page.getByText(firstPagedRevision, { exact: true })).toBeVisible();
    await expect(page.getByText(secondPagedRevision, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Newer", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Older", exact: true }).click();
    await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
    await expect(page.getByText(secondPagedRevision, { exact: true })).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Older", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Newer", exact: true }).click();
    await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();

    // Publishing while viewing a later page returns the history to its newest
    // page, so the employee immediately sees the updated activity.
    await page.getByRole("button", { name: "Older", exact: true }).click();
    await publishRevision(page, resetRevision);
    await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
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
    await prepareExactPreview(page);
    await expect(page.getByText(quoteNumber).first()).toBeVisible();
    await expect(page.getByText("Andersen").first()).toBeVisible();
  });

  test("save a typed signature", async ({ page }) => {
    await prepareExactPreview(page);
    await submitTypedSignature(page, customerName, "Homeowner");
    await expect(page.getByText(/electronically signed/i)).toBeVisible();
    await expect(page.getByText(customerName).first()).toBeVisible();
    await expect(page.getByText(/homeowner/i)).toBeVisible();
  });

  test("editing a signed quote clears the typed signoff", async ({ page }) => {
    await editQuoteNotes(page, "Edited after typed signature");
    await prepareExactPreview(page);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(page.getByRole("button", { name: /type signature/i })).toBeVisible();
  });

  test("save a drawn signature", async ({ page }) => {
    await prepareExactPreview(page);
    await submitDrawnSignature(page, customerName, "Contractor");
    await expect(page.getByText(/electronically signed/i)).toBeVisible();
    await expect(page.getByAltText("Customer Signature")).toBeVisible();
    await expect(page.getByText(/contractor/i)).toBeVisible();
  });

  test("editing a signed quote clears the drawn signoff", async ({ page }) => {
    await editQuoteNotes(page, "Edited after drawn signature");
    await prepareExactPreview(page);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: /draw signature/i }),
    ).toBeVisible();
  });

  test("signoff requires a name, role, and real signature", async ({ page }) => {
    await prepareExactPreview(page);

    // An untouched drawing canvas cannot be submitted.
    await page.getByRole("button", { name: /confirm signature/i }).click();
    await expect(page.getByText(/please draw your signature/i)).toBeVisible();
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();

    // Typed signing validates both identity fields.
    await page.getByRole("button", { name: /type signature/i }).click();
    await page.getByRole("button", { name: /confirm signature/i }).click();
    await expect(page.getByText(/please enter your full name/i)).toBeVisible();
    await expect(page.getByText(/please select your role/i)).toBeVisible();

    const scopedToken = scopedPreviewUrl.split("/").pop();
    const detail = await page.evaluate(async (token) => {
      const res = await fetch(`/api/public/scoped-signoff/${token}`);
      return res.json();
    }, scopedToken);
    const blankPng = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 300;
      canvas.height = 120;
      return canvas.toDataURL("image/png");
    });
    const invalidDrawnStatuses = await page.evaluate(
      async ({ token, version, blank }) => {
        const submit = (signatureData: string) =>
          fetch(`/api/public/scoped-signoff/${token}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customerName: "API Signer",
              stakeholderRole: "Contractor",
              signatureType: "drawn",
              signatureData,
              documentVersion: version,
            }),
          }).then((res) => res.status);
        return [await submit("data:image/png;base64,not-a-png"), await submit(blank)];
      },
      { token: scopedToken, version: detail.documentVersion, blank: blankPng },
    );
    expect(invalidDrawnStatuses).toEqual([400, 400]);

    const invalidRoleStatus = await page.evaluate(
      async ({ token, version }) => {
        const res = await fetch(`/api/public/scoped-signoff/${token}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: "API Signer",
            stakeholderRole: "Not A Role",
            signatureType: "typed",
            signatureData: "API Signer",
            documentVersion: version,
          }),
        });
        return res.status;
      },
      { token: scopedToken, version: detail.documentVersion },
    );
    expect(invalidRoleStatus).toBe(400);

  });

  test("adding a revision to a signed quote requires a fresh scoped preview", async ({ page }) => {
    await signTyped(page);

    await page.goto(quoteUrl);
    await revisionComposer(page).fill("New revision after signing");
    await page.getByRole("button", { name: /publish update/i }).click();
    // Warning dialog: confirm signature removal.
    await page
      .getByRole("button", { name: /remove signature & publish/i })
      .click();
    await expect(page.getByText("New revision after signing")).toBeVisible();

    await prepareExactPreview(page);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(page.getByRole("button", { name: /type signature/i })).toBeVisible();
  });

  test("excluding a revision is controlled from the scoped approval picker", async ({ page }) => {
    await signTyped(page);

    await page.goto(`${quoteUrl}/signoff`);
    await expect(
      page.getByRole("heading", { name: "Review revisions", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Exclude", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Include", exact: true }).first(),
    ).toBeVisible();

    // Re-include so the document returns to full content.
    await page
      .getByRole("button", { name: "Include", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Include", exact: true }),
    ).not.toBeVisible();
  });

  test("signing with a stale document version is rejected", async ({ page }) => {
    await prepareExactPreview(page);
    await expect(page.getByRole("button", { name: /type signature/i })).toBeVisible();
    const scopedToken = scopedPreviewUrl.split("/").pop();
    const status = await page.evaluate(async (token) => {
      const res = await fetch(`/api/public/scoped-signoff/${token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Stale Signer",
          stakeholderRole: "Other",
          signatureType: "typed",
          signatureData: "Stale Signer",
          documentVersion: "0000000000000000000000000000000000000000",
        }),
      });
      return res.status;
    }, scopedToken);
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
      // no-store: avoid a cached/stale response missing the revisions array.
      const listRes = await fetch(`/api/quotes/${id}`, { cache: "no-store" });
      if (!listRes.ok) throw new Error(`GET /quotes/${id} failed: ${listRes.status}`);
      const list = await listRes.json();
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
    await expect(
      page.getByRole("heading", { name: "Customer Approval Setup", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Status: Needs re-signing", { exact: true }),
    ).toBeVisible();
  });
});

/**
 * Product approval is prepared from the internal picker, then reviewed and
 * signed only on its locked customer preview. Reusing an open request after a
 * prior test or page refresh prevents a second overlapping request.
 */
async function prepareExactPreview(page: Page): Promise<void> {
  await page.goto(`${quoteUrl}/signoff`);
  await expect(
    page.getByRole("heading", { name: "Customer Approval Setup", exact: true }),
  ).toBeVisible();
  const reuse = page.getByRole("button", {
    name: "Reuse this exact request",
    exact: true,
  });
  const preview = page.getByRole("button", {
    name: "Prepare Preview for Windows",
    exact: true,
  });
  const nextAction = await Promise.race([
    reuse.waitFor({ state: "visible", timeout: 5_000 }).then(() => "reuse" as const),
    expect(preview).toBeEnabled({ timeout: 5_000 }).then(() => "preview" as const),
  ]).catch(() => null);
  if (nextAction === "reuse") {
    await reuse.click();
  } else if (nextAction === "preview") {
    await preview.click();
  } else {
    throw new Error("Approval picker did not expose an open request or enabled preview action");
  }
  await expect(
    page.getByRole("heading", { name: "Preview Ready" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open preview", exact: true }).last().click();
  await expect(page).toHaveURL(/\/scoped-sign\/[^/]+$/);
  scopedPreviewUrl = new URL(page.url()).pathname;
}

/** Sign the quote with a typed signature (from an unsigned state). */
async function signTyped(page: Page): Promise<void> {
  await prepareExactPreview(page);
  await submitTypedSignature(page, customerName, "Homeowner");
  await expect(page.getByText(/electronically signed/i)).toBeVisible();
}

/**
 * The UI remains the signing surface. Only a server-advertised 429 earns one
 * delayed repeat; validation and stale-document responses remain test failures.
 */
async function submitTypedSignature(
  page: Page,
  name: string,
  role: "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await fillSignerIdentity(page, name, role);
    await page.getByRole("button", { name: /type signature/i }).click();
    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        /\/api\/public\/scoped-signoff\/[^/]+$/.test(
          new URL(candidate.url()).pathname,
        ),
    );
    await page.getByRole("button", { name: /confirm signature/i }).click();
    const result = await response;
    if (result.status() !== 429 || attempt === 1) return;
    const retryAfter = retryAfterMilliseconds(result);
    if (retryAfter === null) return;
    await new Promise<void>((resolve) => setTimeout(resolve, retryAfter));
    await page.reload();
  }
}

async function submitDrawnSignature(
  page: Page,
  name: string,
  role: "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await fillSignerIdentity(page, name, role);
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

    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        /\/api\/public\/scoped-signoff\/[^/]+$/.test(
          new URL(candidate.url()).pathname,
        ),
    );
    await page.getByRole("button", { name: /confirm signature/i }).click();
    const result = await response;
    if (result.status() !== 429 || attempt === 1) return;
    const retryAfter = retryAfterMilliseconds(result);
    if (retryAfter === null) return;
    await new Promise<void>((resolve) => setTimeout(resolve, retryAfter));
    await page.reload();
  }
}

async function fillSignerIdentity(
  page: Page,
  name: string,
  role: "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
): Promise<void> {
  await page.locator("#signerName").fill(name);
  await page.getByTestId("stakeholder-role").click();
  await page.getByRole("option", { name: role, exact: true }).click();
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

function revisionComposer(page: Page) {
  return page.getByPlaceholder(
    "Describe the update, log a call, or note a change...",
    { exact: true },
  );
}

async function publishRevision(page: Page, note: string): Promise<void> {
  await revisionComposer(page).fill(note);
  const published = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.status() === 201 &&
      response.url().includes("/revision-draft/publish"),
  );
  await page.getByRole("button", { name: "Publish Update", exact: true }).click();
  await published;
  await expect(revisionComposer(page)).toHaveValue("", { timeout: 15_000 });
  // Clearing the composer happens before the invalidated quote query has
  // necessarily repainted the log. Wait for that refetch so the next publish
  // cannot race a stale revision-history view.
  await expect(page.getByText(note, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

function draftSavedIndicator(page: Page) {
  return page.locator("main").getByText("Draft saved", { exact: true });
}

async function expandProductSpecs(page: Page): Promise<void> {
  const trigger = page.getByRole("button", {
    name: "Product Specs",
    exact: true,
  });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
}
