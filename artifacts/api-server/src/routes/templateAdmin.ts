import { Router, type IRouter } from "express";
import {
  AnalyzeTemplateDraftBody,
  AnalyzeTemplateDraftParams,
  CancelTemplateDraftParams,
  CreateManufacturerRedactionTemplateDraftBody,
  CreateManufacturerRedactionTemplateDraftParams,
  GetTemplateDraftParams,
  PreviewTemplateDraftBody,
  PreviewTemplateDraftParams,
  RequestTemplateDraftUploadUrlBody,
  SaveTemplateDraftBody,
  SaveTemplateDraftParams,
  TemplateRedactionsInput,
  UpdateTemplateDraftRedactionsBody,
  UpdateTemplateDraftRedactionsParams,
} from "@workspace/api-zod";

import {
  cancelTemplateDraft,
  createTemplateEditDraft,
  createTemplateUploadDraft,
  analyzeTemplateDraft,
  getDraftWithSample,
  renderTemplatePreview,
  renderTemplateSourcePage,
  saveTemplateDraft,
  serializeTemplate,
  serializeTemplateDraft,
  TemplateLifecycleError,
  updateDraftRedactions,
  type TemplateUser,
} from "../lib/templateLifecycle";
import {
  getUserProfile,
  requireAdmin,
  requireApproved,
  requireAuth,
  type AuthedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use("/admin", requireAuth, requireApproved, requireAdmin);

async function actor(req: AuthedRequest): Promise<TemplateUser> {
  if (!req.userId) throw new TemplateLifecycleError("Unauthorized.", 401);
  if (req.appUser?.name) return { id: req.userId, name: req.appUser.name };
  const profile = await getUserProfile(req.userId);
  return { id: req.userId, name: profile.name };
}

function pathId(
  schema: { safeParse(value: unknown): { success: boolean; data?: { id?: number; draftId?: number }; error?: { message: string } } },
  value: unknown,
  key: "id" | "draftId",
): number | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success || !parsed.data?.[key]) return null;
  return parsed.data[key]!;
}

function errorResponse(res: Parameters<Parameters<IRouter["use"]>[1]>[1], error: unknown) {
  if (error instanceof TemplateLifecycleError) {
    res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
    return;
  }
  res.status(500).json({ error: "Template operation failed. Try again." });
}

function draftResponse(draft: Awaited<ReturnType<typeof getDraftWithSample>>) {
  if (!draft) return null;
  return serializeTemplateDraft(draft.draft, draft.sample);
}

router.post("/admin/template-drafts/uploads/request-url", async (req: AuthedRequest, res) => {
  const parsed = RequestTemplateDraftUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await createTemplateUploadDraft(parsed.data, await actor(req));
    res.status(201).json({
      draft: draftResponse({ draft: result.draft, sample: null }),
      uploadURL: result.uploadURL,
      objectPath: result.objectPath,
      uploadExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/admin/manufacturer-redaction-templates/:id/drafts", async (req: AuthedRequest, res) => {
  const params = CreateManufacturerRedactionTemplateDraftParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = CreateManufacturerRedactionTemplateDraftBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await createTemplateEditDraft(
      params.data.id,
      body.data,
      body.data.replaceSample === true,
      await actor(req),
    );
    if ("uploadURL" in result) {
      res.status(201).json({
        draft: draftResponse({ draft: result.draft, sample: null }),
        uploadURL: result.uploadURL,
        objectPath: result.objectPath,
        uploadExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
      return;
    }
    res.status(201).json(draftResponse(result));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/admin/template-drafts/:draftId", async (req: AuthedRequest, res) => {
  const id = pathId(GetTemplateDraftParams, req.params, "draftId");
  if (!id) {
    res.status(400).json({ error: "Invalid draft id." });
    return;
  }
  try {
    const result = await getDraftWithSample(id);
    if (!result) {
      res.status(404).json({ error: "Template draft not found.", code: "DRAFT_NOT_FOUND" });
      return;
    }
    res.json(draftResponse(result));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.delete("/admin/template-drafts/:draftId", async (req: AuthedRequest, res) => {
  const id = pathId(CancelTemplateDraftParams, req.params, "draftId");
  if (!id) {
    res.status(400).json({ error: "Invalid draft id." });
    return;
  }
  try {
    await cancelTemplateDraft(id, await actor(req));
    res.sendStatus(204);
  } catch (error) {
    // Cancelling an already-cancelled draft is safe and idempotent.
    if (error instanceof TemplateLifecycleError && error.code === "DRAFT_NOT_FOUND") {
      const existing = await getDraftWithSample(id);
      if (existing?.draft.status === "cancelled") {
        res.sendStatus(204);
        return;
      }
    }
    errorResponse(res, error);
  }
});

router.post("/admin/template-drafts/:draftId/analyze", async (req: AuthedRequest, res) => {
  const params = AnalyzeTemplateDraftParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = AnalyzeTemplateDraftBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await analyzeTemplateDraft(
      params.data.draftId,
      body.data.manufacturer,
      await actor(req),
    );
    const withSample = await getDraftWithSample(result.draft.id);
    res.json({
      ...draftResponse(withSample),
      warnings: result.analysisWarnings,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.patch("/admin/template-drafts/:draftId/redactions", async (req: AuthedRequest, res) => {
  const params = UpdateTemplateDraftRedactionsParams.safeParse(req.params);
  const body = UpdateTemplateDraftRedactionsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." });
    return;
  }
  try {
    const updated = await updateDraftRedactions(
      params.data.draftId,
      body.data.manualRedactions,
      await actor(req),
    );
    const withSample = await getDraftWithSample(updated.id);
    res.json(draftResponse(withSample));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/admin/template-drafts/:draftId/source/pages/:pageNumber", async (req: AuthedRequest, res) => {
  const params = GetTemplateDraftParams.safeParse({ draftId: req.params.draftId });
  const pageNumber = Number(req.params.pageNumber);
  if (!params.success || !Number.isInteger(pageNumber) || pageNumber < 1) {
    res.status(400).json({ error: "Invalid draft or page number." });
    return;
  }
  try {
    const png = await renderTemplateSourcePage(params.data.draftId, pageNumber);
    res.type("png").set("Cache-Control", "private, no-store").send(png);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/admin/template-drafts/:draftId/preview", async (req: AuthedRequest, res) => {
  const params = PreviewTemplateDraftParams.safeParse(req.params);
  const body = PreviewTemplateDraftBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." });
    return;
  }
  try {
    const png = await renderTemplatePreview(
      params.data.draftId,
      body.data.pageNumber,
      body.data.manualRedactions,
    );
    res.type("png").set("Cache-Control", "private, no-store").send(png);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post("/admin/template-drafts/:draftId/save", async (req: AuthedRequest, res) => {
  const params = SaveTemplateDraftParams.safeParse(req.params);
  const body = SaveTemplateDraftBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." });
    return;
  }
  try {
    const result = await saveTemplateDraft(params.data.draftId, body.data, await actor(req));
    const serialized = serializeTemplate(result.template, result.sample);
    res.status(result.created ? 201 : 200).json(serialized);
  } catch (error) {
    errorResponse(res, error);
  }
});

export default router;