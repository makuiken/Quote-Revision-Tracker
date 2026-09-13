import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import pg from "pg";
import {
  expect,
  test,
  type APIResponse,
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
 * This is intentionally an API-only integration suite. The page fixture is
 * used solely for the existing Clerk testing-token sign-in setup; all
 * application requests after that use the authenticated context request API.
 */

type TemplatePage = {
  pageNumber: number;
  width: number;
  height: number;
  rects: Array<Record<string, unknown>>;
};

type Template = {
  id: number;
  manufacturer: string;
  manufacturerCanonical: string;
  productType: string;
  eligibleProductTypes: string[];
  name: string;
  active: boolean;
  pages: TemplatePage[];
  source: { id: number; originalName: string; size: number; sha256: string } | null;
  sourceAvailable: boolean;
  updatedAt: string;
};

type Draft = {
  id: number;
  templateId: number | null;
  status: string;
  revision: number;
  manufacturer: string | null;
  productType: string | null;
  eligibleProductTypes: string[] | null;
  active: boolean;
  source: { originalName: string; size?: number; sha256?: string } | null;
  sourceAvailable: boolean;
  analysis: Array<{ pageNumber: number; width: number; height: number }> | null;
  manualRedactions: Record<string, Array<Record<string, unknown>>> | null;
};

const apiPath = (path: string): string => `/api${path}`;

test.describe("standalone manufacturer template lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await authenticateApiContext(page);
  });

  test("uploads, analyzes, edits, replaces, conflicts, and preserves safe options", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const api = page.context().request;
    const templateIds = new Set<number>();
    let rolePromoted = false;

    const unique = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const manufacturer = `Task 58 E2E ${unique}`;
    const eligibleProductTypes = ["windows", "interiorDoors"];
    const initialBytes = await createTemplatePdf([
      "INITIAL TEMPLATE SAMPLE",
      "INITIAL SECOND PAGE",
    ]);
    const replacementBytes = await createTemplatePdf([
      "REPLACEMENT TEMPLATE SAMPLE",
      "REPLACEMENT SECOND PAGE",
    ]);

    try {
      // The dedicated account is normally a member. Establish and verify the
      // denied baseline before temporarily promoting it for lifecycle work.
      await setTestUserRole("member");
      await waitForStatus(
        api,
        "/admin/manufacturer-redaction-templates",
        403,
      );
      const memberOptions = await api.get(
        apiPath("/manufacturer-redaction-template-options"),
      );
      await expectStatus(memberOptions, 200);

      const deniedDraftUpload = await api.post(
        apiPath("/admin/template-drafts/uploads/request-url"),
        {
          data: {
            name: "member-cannot-create.pdf",
            size: initialBytes.byteLength,
            contentType: "application/pdf",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
          },
        },
      );
      await expectStatus(deniedDraftUpload, 403);

      await setTestUserRole("admin");
      rolePromoted = true;
      await waitForStatus(
        api,
        "/admin/manufacturer-redaction-templates",
        200,
      );

      // Standalone upload draft -> signed sample upload -> analysis.
      const createUpload = await api.post(
        apiPath("/admin/template-drafts/uploads/request-url"),
        {
          data: {
            name: "initial-template-sample.pdf",
            size: initialBytes.byteLength,
            contentType: "application/pdf",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
          },
        },
      );
      await expectStatus(createUpload, 201);
      const uploadBody = (await createUpload.json()) as {
        draft: Draft;
        uploadURL: string;
      };
      expect(uploadBody.draft.status).toBe("awaiting_upload");
      expect(uploadBody.draft.eligibleProductTypes).toEqual(
        eligibleProductTypes,
      );

      const initialPut = await api.put(uploadBody.uploadURL, {
        headers: { "Content-Type": "application/pdf" },
        data: initialBytes,
      });
      await expectStatus(initialPut, 200);

      const analyzed = await api.post(
        apiPath(`/admin/template-drafts/${uploadBody.draft.id}/analyze`),
        { data: { manufacturer } },
      );
      await expectStatus(analyzed, 200);
      const analyzedDraft = (await analyzed.json()) as Draft;
      expect(analyzedDraft.status).toBe("ready");
      expect(analyzedDraft.analysis?.length).toBe(2);
      expect(analyzedDraft.sourceAvailable).toBe(true);

      // Persist an explicit redaction, then save the first active template.
      const redact = await api.patch(
        apiPath(`/admin/template-drafts/${uploadBody.draft.id}/redactions`),
        {
          data: {
            manualRedactions: {
              "1": [
                {
                  x: 10,
                  y: 10,
                  width: 20,
                  height: 20,
                  reason: "Task 58 fixture",
                },
              ],
            },
          },
        },
      );
      await expectStatus(redact, 200);
      const redactedDraft = (await redact.json()) as Draft;
      expect(redactedDraft.manualRedactions?.["1"]).toHaveLength(1);

      const saved = await api.post(
        apiPath(`/admin/template-drafts/${uploadBody.draft.id}/save`),
        {
          data: {
            name: "Task 58 initial template",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
            active: true,
            expectedDraftRevision: redactedDraft.revision,
          },
        },
      );
      await expectStatus(saved, 201);
      let template = (await saved.json()) as Template;
      templateIds.add(template.id);
      expect(template.manufacturerCanonical).toBe(
        manufacturer.trim().toLocaleLowerCase("en-US"),
      );
      expect(template.eligibleProductTypes).toEqual(eligibleProductTypes);
      expect(template.active).toBe(true);
      expect(template.sourceAvailable).toBe(true);
      expect(template.source?.originalName).toBe("initial-template-sample.pdf");

      // A single template may advertise multiple eligible categories, but no
      // unrelated category should leak into the approved-member options.
      const activeOptions = await api.get(
        apiPath("/manufacturer-redaction-template-options"),
      );
      await expectStatus(activeOptions, 200);
      const options = (await activeOptions.json()) as Array<{
        manufacturer: string;
        productType: string;
      }>;
      const ours = options.filter(
        (option) =>
          option.manufacturer.trim().toLocaleLowerCase("en-US") ===
          template.manufacturerCanonical,
      );
      expect(ours.map((option) => option.productType).sort()).toEqual(
        ["interiorDoors", "windows"].sort(),
      );
      expect(ours.map((option) => option.productType)).not.toContain(
        "exteriorDoors",
      );

      // Metadata-only edits retain both the source sample and page snapshot.
      const immutableSnapshot = {
        pages: template.pages,
        source: template.source,
      };
      const metadataDraftResponse = await api.post(
        apiPath(`/admin/manufacturer-redaction-templates/${template.id}/drafts`),
        { data: {} },
      );
      await expectStatus(metadataDraftResponse, 201);
      const metadataDraft = (await metadataDraftResponse.json()) as Draft;
      expect(metadataDraft.sourceAvailable).toBe(true);
      expect(metadataDraft.source?.originalName).toBe(
        template.source?.originalName,
      );

      const metadataSave = await api.post(
        apiPath(`/admin/template-drafts/${metadataDraft.id}/save`),
        {
          data: {
            name: "Task 58 metadata edit",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
            active: true,
            expectedTemplateUpdatedAt: template.updatedAt,
            expectedDraftRevision: metadataDraft.revision,
          },
        },
      );
      await expectStatus(metadataSave, 200);
      template = (await metadataSave.json()) as Template;
      expect(template.pages).toEqual(immutableSnapshot.pages);
      expect(template.source).toEqual(immutableSnapshot.source);
      expect(template.name).toBe("Task 58 metadata edit");

      // Explicit replacement uses a new signed upload and a new immutable
      // sample object; the old published sample is not overwritten.
      const replacementDraftResponse = await api.post(
        apiPath(`/admin/manufacturer-redaction-templates/${template.id}/drafts`),
        {
          data: {
            replaceSample: true,
            name: "replacement-template-sample.pdf",
            size: replacementBytes.byteLength,
            contentType: "application/pdf",
          },
        },
      );
      await expectStatus(replacementDraftResponse, 201);
      const replacementDraftBody = (await replacementDraftResponse.json()) as {
        draft: Draft;
        uploadURL: string;
      };
      expect(replacementDraftBody.draft.status).toBe("awaiting_upload");
      expect(replacementDraftBody.draft.source).toBeNull();

      const replacementPut = await api.put(replacementDraftBody.uploadURL, {
        headers: { "Content-Type": "application/pdf" },
        data: replacementBytes,
      });
      await expectStatus(replacementPut, 200);
      const replacementAnalyze = await api.post(
        apiPath(
          `/admin/template-drafts/${replacementDraftBody.draft.id}/analyze`,
        ),
        { data: { manufacturer } },
      );
      await expectStatus(replacementAnalyze, 200);
      const replacementAnalyzed = (await replacementAnalyze.json()) as Draft;
      expect(replacementAnalyzed.status).toBe("ready");

      // Analysis deliberately clears prior geometry. Review the replacement
      // before saving so the replacement cannot silently publish without
      // explicit redactions.
      const replacementRedact = await api.patch(
        apiPath(
          `/admin/template-drafts/${replacementDraftBody.draft.id}/redactions`,
        ),
        {
          data: {
            manualRedactions: {
              "1": [
                {
                  x: 10,
                  y: 10,
                  width: 20,
                  height: 20,
                  reason: "Task 58 replacement fixture",
                },
              ],
            },
          },
        },
      );
      await expectStatus(replacementRedact, 200);
      const replacementReviewed = (await replacementRedact.json()) as Draft;
      expect(replacementReviewed.manualRedactions?.["1"]).toHaveLength(1);

      const replacementSave = await api.post(
        apiPath(
          `/admin/template-drafts/${replacementDraftBody.draft.id}/save`,
        ),
        {
          data: {
            name: "Task 58 replacement template",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
            active: false,
            expectedTemplateUpdatedAt: template.updatedAt,
            expectedDraftRevision: replacementReviewed.revision,
            manualRedactions: replacementReviewed.manualRedactions ?? {},
          },
        },
      );
      await expectStatus(replacementSave, 200);
      template = (await replacementSave.json()) as Template;
      expect(template.active).toBe(false);
      expect(template.source?.originalName).toBe(
        "replacement-template-sample.pdf",
      );
      expect(template.source?.id).not.toBe(immutableSnapshot.source?.id);

      // Inactive templates remain in the administrative collection while
      // disappearing from the safe active option list.
      const adminTemplates = await api.get(
        apiPath("/admin/manufacturer-redaction-templates"),
      );
      await expectStatus(adminTemplates, 200);
      const listed = (await adminTemplates.json()) as Template[];
      expect(
        listed.find((candidate) => candidate.id === template.id),
      ).toMatchObject({
        id: template.id,
        active: false,
        sourceAvailable: true,
      });
      const inactiveOptions = await api.get(
        apiPath("/manufacturer-redaction-template-options"),
      );
      await expectStatus(inactiveOptions, 200);
      expect(
        ((await inactiveOptions.json()) as Array<{ manufacturer: string }>)
          .some(
            (option) =>
              option.manufacturer.trim().toLocaleLowerCase("en-US") ===
              template.manufacturerCanonical,
          ),
      ).toBe(false);

      // Two drafts from the same saved template exercise optimistic stale
      // template protection. The second save must not overwrite the first.
      const staleAResponse = await api.post(
        apiPath(`/admin/manufacturer-redaction-templates/${template.id}/drafts`),
        { data: {} },
      );
      const staleBResponse = await api.post(
        apiPath(`/admin/manufacturer-redaction-templates/${template.id}/drafts`),
        { data: {} },
      );
      await expectStatus(staleAResponse, 201);
      await expectStatus(staleBResponse, 201);
      const staleA = (await staleAResponse.json()) as Draft;
      const staleB = (await staleBResponse.json()) as Draft;
      const staleAt = template.updatedAt;

      const firstStaleSave = await api.post(
        apiPath(`/admin/template-drafts/${staleA.id}/save`),
        {
          data: {
            name: "Task 58 first concurrent edit",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
            active: false,
            expectedTemplateUpdatedAt: staleAt,
            expectedDraftRevision: staleA.revision,
          },
        },
      );
      await expectStatus(firstStaleSave, 200);
      const secondStaleSave = await api.post(
        apiPath(`/admin/template-drafts/${staleB.id}/save`),
        {
          data: {
            name: "Task 58 stale concurrent edit",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
            active: false,
            expectedTemplateUpdatedAt: staleAt,
            expectedDraftRevision: staleB.revision,
          },
        },
      );
      await expectStatus(secondStaleSave, 409);
      expect((await secondStaleSave.json()).code).toBe("STALE_TEMPLATE");

      // A second canonical spelling conflicts even though it differs in case
      // and whitespace from the existing manufacturer.
      const duplicateBytes = await createTemplatePdf(["DUPLICATE"]);
      const duplicateDraftResponse = await api.post(
        apiPath("/admin/template-drafts/uploads/request-url"),
        {
          data: {
            name: "duplicate-template-sample.pdf",
            size: duplicateBytes.byteLength,
            contentType: "application/pdf",
            manufacturer: `  ${manufacturer.toUpperCase()}  `,
            productType: "windows",
            eligibleProductTypes: ["windows"],
          },
        },
      );
      await expectStatus(duplicateDraftResponse, 201);
      const duplicateDraftBody = (await duplicateDraftResponse.json()) as {
        draft: Draft;
        uploadURL: string;
      };
      const duplicatePut = await api.put(duplicateDraftBody.uploadURL, {
        headers: { "Content-Type": "application/pdf" },
        data: duplicateBytes,
      });
      await expectStatus(duplicatePut, 200);
      const duplicateAnalyze = await api.post(
        apiPath(`/admin/template-drafts/${duplicateDraftBody.draft.id}/analyze`),
        { data: { manufacturer: manufacturer.toUpperCase() } },
      );
      await expectStatus(duplicateAnalyze, 200);
      const duplicateAnalyzed = (await duplicateAnalyze.json()) as Draft;
      const duplicateRedact = await api.patch(
        apiPath(`/admin/template-drafts/${duplicateDraftBody.draft.id}/redactions`),
        {
          data: {
            manualRedactions: {
              "1": [
                {
                  x: 10,
                  y: 10,
                  width: 20,
                  height: 20,
                  reason: "Task 58 duplicate fixture",
                },
              ],
            },
          },
        },
      );
      await expectStatus(duplicateRedact, 200);
      const duplicateReviewed = (await duplicateRedact.json()) as Draft;
      expect(duplicateReviewed.manualRedactions?.["1"]).toHaveLength(1);
      const duplicateSave = await api.post(
        apiPath(`/admin/template-drafts/${duplicateDraftBody.draft.id}/save`),
        {
          data: {
            name: "Task 58 duplicate",
            manufacturer: manufacturer.toUpperCase(),
            productType: "windows",
            eligibleProductTypes: ["windows"],
            active: true,
            expectedDraftRevision: duplicateReviewed.revision,
            manualRedactions: duplicateReviewed.manualRedactions ?? {},
          },
        },
      );
      await expectStatus(duplicateSave, 409);
      expect((await duplicateSave.json()).code).toBe("TEMPLATE_CONFLICT");

      // Cancellation is idempotent and never mutates the saved inactive
      // template.
      const cancelDraftResponse = await api.post(
        apiPath(`/admin/manufacturer-redaction-templates/${template.id}/drafts`),
        { data: {} },
      );
      await expectStatus(cancelDraftResponse, 201);
      const cancelDraft = (await cancelDraftResponse.json()) as Draft;
      const cancel = await api.delete(
        apiPath(`/admin/template-drafts/${cancelDraft.id}`),
      );
      await expectStatus(cancel, 204);
      const cancelled = await api.get(
        apiPath(`/admin/template-drafts/${cancelDraft.id}`),
      );
      await expectStatus(cancelled, 200);
      expect((await cancelled.json()).status).toBe("cancelled");
      const cancelAgain = await api.delete(
        apiPath(`/admin/template-drafts/${cancelDraft.id}`),
      );
      await expectStatus(cancelAgain, 204);

      // Deleting a saved template cancels attached edit drafts before the
      // foreign key detaches them. Saving the old draft must never recreate
      // the deleted template as a new row.
      const deleteRaceDraftResponse = await api.post(
        apiPath(`/admin/manufacturer-redaction-templates/${template.id}/drafts`),
        { data: {} },
      );
      await expectStatus(deleteRaceDraftResponse, 201);
      const deleteRaceDraft = (await deleteRaceDraftResponse.json()) as Draft;
      const deleteTemplate = await api.delete(
        apiPath(`/admin/manufacturer-redaction-templates/${template.id}`),
      );
      await expectStatus(deleteTemplate, 204);
      templateIds.delete(template.id);
      const deletedDraftState = await api.get(
        apiPath(`/admin/template-drafts/${deleteRaceDraft.id}`),
      );
      await expectStatus(deletedDraftState, 200);
      expect((await deletedDraftState.json()) as Draft).toMatchObject({
        status: "cancelled",
        revision: deleteRaceDraft.revision + 1,
      });

      const detachedSave = await api.post(
        apiPath(`/admin/template-drafts/${deleteRaceDraft.id}/save`),
        {
          data: {
            name: "Task 58 deleted template edit",
            manufacturer,
            productType: "windows",
            eligibleProductTypes,
            active: false,
            expectedDraftRevision: deleteRaceDraft.revision,
          },
        },
      );
      await expectStatus(detachedSave, 409);
      expect(["DRAFT_CANCELLED", "TEMPLATE_NOT_FOUND"]).toContain(
        (await detachedSave.json()).code,
      );
    } finally {
      // Keep this regression suite isolated when a lifecycle assertion fails.
      try {
        if (rolePromoted) {
          for (const templateId of templateIds) {
            const remove = await api.delete(
              apiPath(`/admin/manufacturer-redaction-templates/${templateId}`),
            );
            await expectStatus(remove, 204);
          }
        }
      } finally {
        await setTestUserRole("member");
        await waitForStatus(
          api,
          "/admin/manufacturer-redaction-templates",
          403,
        );
      }
    }
  });
});

async function authenticateApiContext(page: Page): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/sign-in");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: TEST_USER_EMAIL });
}

async function setTestUserRole(role: "admin" | "member"): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      `update users
       set role = $1, status = 'approved'
       where email = $2`,
      [role, TEST_USER_EMAIL],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Could not update the E2E user's role to ${role}.`);
    }
  } finally {
    await pool.end();
  }
}

async function expectStatus(
  response: APIResponse,
  status: number,
): Promise<void> {
  expect(response.status(), await response.text()).toBe(status);
}

async function waitForStatus(
  api: APIRequestContext,
  path: string,
  status: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = -1;
  while (Date.now() < deadline) {
    const response = await api.get(apiPath(path), {
      failOnStatusCode: false,
    });
    lastStatus = response.status();
    if (lastStatus === status) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Expected ${path} to return ${status}; got ${lastStatus}.`);
}

async function createTemplatePdf(lines: readonly string[]): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.setTitle("Task 58 template lifecycle fixture");
  document.setAuthor("Automated API regression test");
  for (const [index, line] of lines.entries()) {
    const page = document.addPage([612, 792]);
    page.drawText("SYNTHETIC MANUFACTURER TEMPLATE", {
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
    page.drawText(`Synthetic template page ${index + 1}`, {
      x: 36,
      y: 660,
      size: 11,
      font,
    });
  }
  return Buffer.from(await document.save());
}