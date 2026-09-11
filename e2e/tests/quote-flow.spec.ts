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
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(
      page.getByText("Changed jamb depth per customer request"),
    ).toBeVisible();
    // Wait for the composer to reset after publishing before typing again —
    // the post-publish state update would otherwise race with the next fill.
    await expect(page.locator("#note")).toHaveValue("");

    await page.locator("#note").fill("Confirmed hardware finish with supplier");
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(
      page.getByText("Confirmed hardware finish with supplier"),
    ).toBeVisible();
    await expect(page.locator("#note")).toHaveValue("");
  });

  test("draft revision notes persist, stay private, and publish", async ({ page }) => {
    const draftText = "Draft: waiting on trim pricing from supplier";
    await page.goto(quoteUrl);
    await page.locator("#note").fill(draftText);
    await page.getByRole("button", { name: /save draft/i }).click();
    await expect(page.getByText(/draft — not published/i)).toBeVisible();

    // Draft survives a reload and is re-hydrated into the composer.
    await page.reload();
    await expect(page.locator("#note")).toHaveValue(draftText);
    await expect(page.getByText(/draft — not published/i)).toBeVisible();

    // Draft is absent from the printed log.
    await page.goto(`${quoteUrl}/print-log`);
    await expect(page.getByText(draftText)).not.toBeVisible();

    // Draft is absent from the signoff document.
    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(draftText)).not.toBeVisible();

    // Publishing turns the draft into a normal revision entry.
    await page.goto(quoteUrl);
    await expect(page.locator("#note")).toHaveValue(draftText);
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(
      page.locator("#note"),
    ).toHaveValue("", { timeout: 15000 });
    await expect(page.getByText(draftText)).toBeVisible();
    await expect(page.getByText(/draft — not published/i)).not.toBeVisible();
  });

  test("discarding a draft removes it without publishing", async ({ page }) => {
    const draftText = "Draft to discard — should never publish";
    await page.goto(quoteUrl);
    await page.locator("#note").fill(draftText);
    await page.getByRole("button", { name: /save draft/i }).click();
    await expect(page.getByText(/draft — not published/i)).toBeVisible();

    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(page.locator("#note")).toHaveValue("");
    await expect(page.getByText(/draft — not published/i)).not.toBeVisible();

    await page.reload();
    await expect(page.locator("#note")).toHaveValue("");
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
    await page.locator("#note").fill("First auto-saved text");
    await page.waitForTimeout(2700);
    // ...second auto-save queues behind it (fast PUT #2)...
    await page.locator("#note").fill("Second auto-saved text");
    await page.waitForTimeout(2700);
    // ...then discard while writes are still settling.
    await expect(page.getByRole("button", { name: /discard draft/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(page.locator("#note")).toHaveValue("", { timeout: 20000 });
    expect(putCount).toBeGreaterThanOrEqual(2);

    // After everything settles, no draft exists on the server.
    await page.waitForTimeout(3500);
    await page.unroute("**/revision-draft");
    await page.reload();
    await expect(page.locator("#note")).toHaveValue("");
    await expect(page.getByText(/draft — not published/i)).not.toBeVisible();
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
    await page.locator("#note").fill("Older auto-saved text");
    await page.waitForTimeout(2700);
    await page.locator("#note").fill("Newer auto-saved text");
    await page.waitForTimeout(2700);
    // ...then publish the latest text while writes are still settling.
    await page.locator("#note").fill("Final published text");
    await page.getByRole("button", { name: /publish update/i }).click();
    await expect(page.getByText("Final published text")).toBeVisible({ timeout: 25000 });
    await expect(page.locator("#note")).toHaveValue("", { timeout: 15000 });
    expect(putCount).toBeGreaterThanOrEqual(2);

    // The published entry has the latest text and no draft remains.
    await page.waitForTimeout(3500);
    await page.unroute("**/revision-draft");
    await page.reload();
    await expect(page.getByText("Final published text")).toBeVisible();
    await expect(page.locator("#note")).toHaveValue("");
    await expect(page.getByText(/draft — not published/i)).not.toBeVisible();
    await expect(page.getByText("Older auto-saved text")).not.toBeVisible();
    await expect(page.getByText("Newer auto-saved text")).not.toBeVisible();
  });

  test("leaving via browser back auto-saves the typed draft", async ({ page }) => {
    // Reach the quote via an in-app (SPA) navigation so browser back is a
    // popstate, not a full page load.
    await page.goto("/quotes");
    await page.getByText(quoteNumber).first().click();
    await expect(page).toHaveURL(new RegExp(`${quoteUrl}$`));

    await page.locator("#note").fill("History nav draft text");
    const savedResponse = page.waitForResponse(
      (r) => r.url().includes("/revision-draft") && r.request().method() === "PUT" && r.ok(),
    );
    await page.goBack();
    await expect(page).toHaveURL(/\/quotes$/);
    await savedResponse;

    // The typed text survived as a draft; clean it up.
    await page.goto(quoteUrl);
    await expect(page.locator("#note")).toHaveValue("History nav draft text");
    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(page.locator("#note")).toHaveValue("");
  });

  test("in-app navigation with unsaved typing warns before leaving", async ({ page }) => {
    await page.goto(quoteUrl);
    await page.locator("#note").fill("Guard test: unsaved typing");
    await page.getByRole("link", { name: /back to dashboard/i }).click();

    // Guard dialog appears; staying keeps the text and the page.
    await expect(page.getByText(/unsaved changes/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^stay$/i }).click();
    await expect(page).toHaveURL(new RegExp(`${quoteUrl}$`));
    await expect(page.locator("#note")).toHaveValue("Guard test: unsaved typing");

    // Make the composer dirty again, then save-and-leave.
    await page.locator("#note").fill("Guard test: unsaved typing, extended");
    await page.getByRole("link", { name: /back to dashboard/i }).click();
    await expect(page.getByText(/unsaved changes/i).first()).toBeVisible();
    await page.getByRole("button", { name: /save draft & leave/i }).click();
    await expect(page).toHaveURL(/\/quotes$/);

    // The draft survived the navigation; clean it up.
    await page.goto(quoteUrl);
    await expect(page.locator("#note")).toHaveValue("Guard test: unsaved typing, extended");
    await page.getByRole("button", { name: /discard draft/i }).click();
    await expect(page.locator("#note")).toHaveValue("");
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
    await fillSignerIdentity(page, customerName, "Homeowner");
    await page.getByRole("button", { name: /type signature/i }).click();
    await page.getByRole("button", { name: /confirm signature/i }).click();
    await expect(page.getByText(/electronically signed/i)).toBeVisible();
    await expect(page.getByText(customerName).first()).toBeVisible();
    await expect(page.getByText(/homeowner/i)).toBeVisible();
  });

  test("editing a signed quote clears the typed signoff", async ({ page }) => {
    await editQuoteNotes(page, "Edited after typed signature");
    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(page.getByRole("button", { name: /type signature/i })).toBeVisible();
  });

  test("save a drawn signature", async ({ page }) => {
    await page.goto(`${quoteUrl}/signoff`);
    await fillSignerIdentity(page, customerName, "Contractor");
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
    await expect(page.getByText(/contractor/i)).toBeVisible();
  });

  test("editing a signed quote clears the drawn signoff", async ({ page }) => {
    await editQuoteNotes(page, "Edited after drawn signature");
    await page.goto(`${quoteUrl}/signoff`);
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: /draw signature/i }),
    ).toBeVisible();
  });

  test("signoff requires a name, role, and real signature", async ({ page }) => {
    await page.goto(`${quoteUrl}/signoff`);

    // An untouched drawing canvas cannot be submitted.
    await page.getByRole("button", { name: /confirm signature/i }).click();
    await expect(page.getByText(/please draw your signature/i)).toBeVisible();
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();

    // Typed signing validates both identity fields.
    await page.getByRole("button", { name: /type signature/i }).click();
    await page.getByRole("button", { name: /confirm signature/i }).click();
    await expect(page.getByText(/please enter your full name/i)).toBeVisible();
    await expect(page.getByText(/please select your role/i)).toBeVisible();

    const quoteId = quoteUrl.split("/").pop();
    const detail = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}`);
      return res.json();
    }, quoteId);
    const blankPng = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 300;
      canvas.height = 120;
      return canvas.toDataURL("image/png");
    });
    const invalidDrawnStatuses = await page.evaluate(
      async ({ id, version, blank }) => {
        const submit = (signatureData: string) =>
          fetch(`/api/quotes/${id}/signoff`, {
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
      { id: quoteId, version: detail.documentVersion, blank: blankPng },
    );
    expect(invalidDrawnStatuses).toEqual([400, 400]);

    const invalidRoleStatus = await page.evaluate(
      async ({ id, version }) => {
        const res = await fetch(`/api/quotes/${id}/signoff`, {
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
      { id: quoteId, version: detail.documentVersion },
    );
    expect(invalidRoleStatus).toBe(400);

    // The public token-gated route enforces and persists the same identity
    // fields; clean up afterward so later serial tests remain unsigned.
    const publicResult = await page.evaluate(async ({ id, blank }) => {
      const linkRes = await fetch(`/api/quotes/${id}/share-link`, { method: "POST" });
      const { token } = await linkRes.json();
      const detailRes = await fetch(`/api/public/signoff/${token}`);
      const publicDetail = await detailRes.json();
      const blankRes = await fetch(`/api/public/signoff/${token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Public Signer",
          stakeholderRole: "Architect/Designer",
          signatureType: "drawn",
          signatureData: blank,
          documentVersion: publicDetail.documentVersion,
        }),
      });
      const saveRes = await fetch(`/api/public/signoff/${token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Public Signer",
          stakeholderRole: "Architect/Designer",
          signatureType: "typed",
          signatureData: "Public Signer",
          documentVersion: publicDetail.documentVersion,
        }),
      });
      return {
        blankStatus: blankRes.status,
        status: saveRes.status,
        body: await saveRes.json(),
      };
    }, { id: quoteId, blank: blankPng });
    expect(publicResult.blankStatus).toBe(400);
    expect(publicResult.status).toBe(200);
    expect(publicResult.body.customerName).toBe("Public Signer");
    expect(publicResult.body.stakeholderRole).toBe("Architect/Designer");

    const clearStatus = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/signoff`, { method: "DELETE" });
      return res.status;
    }, quoteId);
    expect(clearStatus).toBe(204);
  });

  test("adding a revision to a signed quote warns and clears the signature", async ({ page }) => {
    await signTyped(page);

    await page.goto(quoteUrl);
    await page.locator("#note").fill("New revision after signing");
    await page.getByRole("button", { name: /publish update/i }).click();
    // Warning dialog: confirm signature removal.
    await page
      .getByRole("button", { name: /remove signature & publish update/i })
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
    await expect(page.getByRole("button", { name: /type signature/i })).toBeVisible();
    const quoteId = quoteUrl.split("/").pop();
    const status = await page.evaluate(async (id) => {
      const res = await fetch(`/api/quotes/${id}/signoff`, {
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
    await expect(page.getByText(/electronically signed/i)).not.toBeVisible();
    await expect(page.getByRole("button", { name: /type signature/i })).toBeVisible();
  });
});

/** Sign the quote with a typed signature (from an unsigned state). */
async function signTyped(page: Page): Promise<void> {
  await page.goto(`${quoteUrl}/signoff`);
  await fillSignerIdentity(page, customerName, "Homeowner");
  await page.getByRole("button", { name: /type signature/i }).click();
  await page.getByRole("button", { name: /confirm signature/i }).click();
  await expect(page.getByText(/electronically signed/i)).toBeVisible();
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
