import {
  analyzeTemplateDraft as analyzeTemplateDraftRequest,
  cancelTemplateDraft as cancelTemplateDraftRequest,
  createManufacturerRedactionTemplateDraft,
  getTemplateDraft as getTemplateDraftRequest,
  getTemplateDraftSourcePage as getTemplateDraftSourcePageRequest,
  previewTemplateDraft as previewTemplateDraftRequest,
  requestTemplateDraftUploadUrl as requestTemplateDraftUploadUrlRequest,
  saveTemplateDraft as saveTemplateDraftRequest,
  updateTemplateDraftRedactions,
} from "@workspace/api-client-react";
import type {
  TemplateEditorPage,
  TemplateEditorRect,
} from "@/components/template-redaction-editor";

export type TemplateSourceMetadata = {
  id?: number;
  originalName: string;
  size: number;
  sha256: string;
  createdAt: string;
};

export type TemplateRecord = {
  id: number;
  manufacturer: string;
  manufacturerCanonical: string;
  productType: string;
  eligibleProductTypes?: string[];
  name: string;
  active: boolean;
  pages: Array<{
    pageNumber: number;
    width: number;
    height: number;
    rects: TemplateEditorRect[];
  }>;
  source: TemplateSourceMetadata | null;
  sourceAvailable: boolean;
  createdById: string;
  createdByName: string;
  updatedById: string;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
};

export type TemplateDraftStatus =
  "awaiting_upload" | "analyzing" | "ready" | "saving" | "failed" | "cancelled";

export type TemplateAnalysisPage = {
  pageNumber: number;
  width: number;
  height: number;
  pageType: string;
  suggestedRects: TemplateEditorRect[];
};

export type TemplateDraft = {
  id: number;
  templateId: number | null;
  status: TemplateDraftStatus;
  originalName: string | null;
  declaredSize: number | null;
  sourceAvailable: boolean;
  source: TemplateSourceMetadata | null;
  manufacturer: string | null;
  manufacturerCanonical: string | null;
  productType: string | null;
  eligibleProductTypes?: string[] | null;
  name: string | null;
  active: boolean;
  revision: number;
  analysis: TemplateAnalysisPage[] | null;
  manualRedactions: Record<string, TemplateEditorRect[]> | null;
  warnings: string[];
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UploadDraftResponse = {
  draft: TemplateDraft;
  uploadURL: string;
  objectPath: string;
  uploadExpiresAt: string;
};

export type SaveDraftResponse = TemplateRecord;

export function requestTemplateDraftUploadUrl(input: {
  name: string;
  size: number;
  contentType: "application/pdf";
  manufacturer?: string;
  productType?: string;
  eligibleProductTypes?: string[];
}) {
  return requestTemplateDraftUploadUrlRequest(
    input as Parameters<typeof requestTemplateDraftUploadUrlRequest>[0],
  ) as Promise<UploadDraftResponse>;
}

export function analyzeTemplateDraft(
  draftId: number,
  input?: { manufacturer?: string },
) {
  return analyzeTemplateDraftRequest(
    draftId,
    input && Object.keys(input).length > 0 ? input : undefined,
  );
}

export function createTemplateDraftFromTemplate(
  templateId: number,
  input: Record<string, unknown> = {},
) {
  return createManufacturerRedactionTemplateDraft(
    templateId,
    input as Parameters<typeof createManufacturerRedactionTemplateDraft>[1],
  ).then(
    (response) =>
      ("draft" in response ? response : { draft: response }) as
        UploadDraftResponse | { draft: TemplateDraft },
  );
}

export function getTemplateDraft(draftId: number) {
  return getTemplateDraftRequest(draftId);
}

export function cancelTemplateDraft(draftId: number) {
  return cancelTemplateDraftRequest(draftId);
}

export function patchTemplateDraftRedactions(
  draftId: number,
  manualRedactions: Record<string, TemplateEditorRect[]>,
) {
  return updateTemplateDraftRedactions(draftId, { manualRedactions });
}

export function getTemplateDraftSourcePage(
  draftId: number,
  pageNumber: number,
) {
  return getTemplateDraftSourcePageRequest(draftId, pageNumber);
}

export function previewTemplateDraftPage(
  draftId: number,
  pageNumber: number,
  manualRedactions?: Record<string, TemplateEditorRect[]>,
) {
  return previewTemplateDraftRequest(draftId, {
    pageNumber,
    ...(manualRedactions === undefined ? {} : { manualRedactions }),
  });
}

export function saveTemplateDraft(
  draftId: number,
  input: {
    name: string;
    manufacturer: string;
    productType: string;
    active: boolean;
    expectedTemplateUpdatedAt?: string;
    expectedDraftRevision?: number;
    manualRedactions?: Record<string, TemplateEditorRect[]>;
    eligibleProductTypes?: string[];
  },
) {
  return saveTemplateDraftRequest(
    draftId,
    input as Parameters<typeof saveTemplateDraftRequest>[1],
  ) as Promise<SaveDraftResponse>;
}

export function draftPagesToEditorPages(
  draft: TemplateDraft,
  sourceUrls: Record<number, string | null> = {},
  cleanedUrls: Record<number, string | null> = {},
): TemplateEditorPage[] {
  const analysis = draft.analysis ?? [];
  const redactions = draft.manualRedactions ?? {};
  return analysis.map((page) => ({
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    rects: [...(redactions[String(page.pageNumber)] ?? [])],
    sourceUrl: sourceUrls[page.pageNumber] ?? null,
    cleanedUrl: cleanedUrls[page.pageNumber] ?? null,
  }));
}
