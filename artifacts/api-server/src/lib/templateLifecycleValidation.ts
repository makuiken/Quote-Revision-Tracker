export const MAX_TEMPLATE_RECTANGLES_PER_PAGE = 32;
export const MAX_TEMPLATE_PRODUCT_TYPES = 32;
export const MAX_TEMPLATE_PRODUCT_TYPE_LENGTH = 100;

export const QUOTE_PRODUCT_TYPES = [
  "doors",
  "interiorDoors",
  "exteriorDoors",
  "windows",
  "trim",
  "millwork",
] as const;

export type QuoteProductType = (typeof QUOTE_PRODUCT_TYPES)[number];

export class TemplateLifecycleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = "TemplateLifecycleError";
  }
}

export function normalizeTemplateProductType(
  value: unknown,
  field = "productType",
): QuoteProductType {
  if (typeof value !== "string") {
    throw new TemplateLifecycleError(
      `${field} must be one of: ${QUOTE_PRODUCT_TYPES.join(", ")}.`,
      400,
      "INVALID_PRODUCT_TYPE",
    );
  }
  const normalized = value.trim();
  if (!(QUOTE_PRODUCT_TYPES as readonly string[]).includes(normalized)) {
    throw new TemplateLifecycleError(
      `${field} must be one of: ${QUOTE_PRODUCT_TYPES.join(", ")}.`,
      400,
      "INVALID_PRODUCT_TYPE",
    );
  }
  return normalized as QuoteProductType;
}

export function normalizeTemplateEligibleProductTypes(
  value: unknown,
  primaryProductType: string | null,
  allowEmpty = true,
): QuoteProductType[] {
  const normalizedPrimary = primaryProductType
    ? normalizeTemplateProductType(primaryProductType)
    : null;
  if (value === undefined || value === null) {
    return normalizedPrimary ? [normalizedPrimary] : [];
  }
  if (!Array.isArray(value)) {
    throw new TemplateLifecycleError("eligibleProductTypes must be an array.");
  }
  if (value.length > MAX_TEMPLATE_PRODUCT_TYPES) {
    throw new TemplateLifecycleError(
      `A template may be eligible for at most ${MAX_TEMPLATE_PRODUCT_TYPES} product types.`,
    );
  }
  const types = [
    ...new Set(
      value.map((item) => {
        if (typeof item !== "string") {
          throw new TemplateLifecycleError(
            "eligibleProductTypes item must be a product type.",
            400,
            "INVALID_PRODUCT_TYPE",
          );
        }
        const normalized = item.trim().replace(/\s+/g, " ");
        if (!normalized || normalized.length > MAX_TEMPLATE_PRODUCT_TYPE_LENGTH) {
          throw new TemplateLifecycleError(
            `eligibleProductTypes item must be no longer than ${MAX_TEMPLATE_PRODUCT_TYPE_LENGTH} characters.`,
          );
        }
        return normalizeTemplateProductType(normalized, "eligibleProductTypes item");
      }),
    ),
  ];
  if (!allowEmpty && types.length === 0) {
    throw new TemplateLifecycleError(
      "eligibleProductTypes must contain at least one product type.",
    );
  }
  if (normalizedPrimary && !types.includes(normalizedPrimary)) {
    throw new TemplateLifecycleError(
      "eligibleProductTypes must include the template productType.",
    );
  }
  return types;
}

export function assertTemplateDraftReady(
  status: string,
  hasAnalysis: boolean,
  operation: "redactions" | "save" = "save",
): void {
  if (status === "cancelled") {
    throw new TemplateLifecycleError(
      "This template draft was cancelled.",
      409,
      "DRAFT_CANCELLED",
    );
  }
  if (status !== "ready" || !hasAnalysis) {
    throw new TemplateLifecycleError(
      operation === "redactions"
        ? "Analyze the sample before editing redactions."
        : "Analyze the sample successfully before saving the template.",
      409,
      "DRAFT_NOT_READY",
    );
  }
}

export function assertTemplateBaseUnchanged(
  templateId: number | null,
  baseTemplateUpdatedAt: Date | null,
  currentTemplateUpdatedAt: Date | null,
): void {
  if (templateId === null) return;
  if (!baseTemplateUpdatedAt || !currentTemplateUpdatedAt) {
    throw new TemplateLifecycleError(
      "This edit draft has no captured template version. Reopen the template to create a fresh draft.",
      409,
      "STALE_TEMPLATE",
    );
  }
  if (baseTemplateUpdatedAt.getTime() !== currentTemplateUpdatedAt.getTime()) {
    throw new TemplateLifecycleError(
      "This template changed after the draft was opened. Reopen the template before saving.",
      409,
      "STALE_TEMPLATE",
    );
  }
}

export function assertTemplateDraftIdentity(
  templateId: number | null,
  originalTemplateId: number | null,
  sourceSampleId: number | null,
  baseTemplateUpdatedAt: Date | null,
  uploadObjectPath: string | null,
  status: string,
  hasAnalysis: boolean,
): void {
  if (
    originalTemplateId !== null &&
    templateId !== originalTemplateId
  ) {
    throw new TemplateLifecycleError(
      "The saved template for this edit draft no longer exists. Reopen the template to continue.",
      409,
      "TEMPLATE_NOT_FOUND",
    );
  }
  // Before originalTemplateId was introduced, a deleted source-less edit
  // draft could be indistinguishable from a new draft after ON DELETE SET
  // NULL. A ready, analyzed draft with no staging upload is only a detached
  // legacy edit in that state.
  const hasCapturedLegacyIdentity =
    sourceSampleId !== null || baseTemplateUpdatedAt !== null;
  const isSourceLessLegacyEdit =
    sourceSampleId === null &&
    baseTemplateUpdatedAt === null &&
    status === "ready" &&
    hasAnalysis;
  if (
    templateId === null &&
    originalTemplateId === null &&
    (hasCapturedLegacyIdentity ||
      (isSourceLessLegacyEdit && !uploadObjectPath))
  ) {
    throw new TemplateLifecycleError(
      "This edit draft is detached from its deleted template. Reopen the template to continue.",
      409,
      "TEMPLATE_NOT_FOUND",
    );
  }
}

export type TemplateAnalysisPageLike = {
  pageNumber: number;
  width: number;
  height: number;
};

export type TemplateRectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
};

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TemplateLifecycleError(`${field} must be a number.`);
  }
  return value;
}

function asPacketRedaction(
  value: unknown,
  page: TemplateAnalysisPageLike,
): TemplateRectLike {
  if (typeof value !== "object" || value === null) {
    throw new TemplateLifecycleError(
      "Each redaction box must be an object.",
      400,
      "INVALID_REDACTIONS",
    );
  }
  const rect = value as Record<string, unknown>;
  const x = numberValue(rect.x, "Redaction x");
  const y = numberValue(rect.y, "Redaction y");
  const width = numberValue(rect.width, "Redaction width");
  const height = numberValue(rect.height, "Redaction height");
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > page.width ||
    y + height > page.height
  ) {
    throw new TemplateLifecycleError(
      `Redaction on page ${page.pageNumber} must be finite and inside page bounds.`,
      400,
      "INVALID_REDACTIONS",
    );
  }
  const reason = rect.reason;
  return {
    x,
    y,
    width,
    height,
    ...(reason === undefined ? {} : { reason: String(reason).slice(0, 200) }),
  };
}

export function validateManualRedactions(
  analysis: TemplateAnalysisPageLike[],
  value: unknown,
  requireAtLeastOne = false,
): Record<string, TemplateRectLike[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TemplateLifecycleError(
      "manualRedactions must be an object keyed by analyzed page number.",
      400,
      "INVALID_REDACTIONS",
    );
  }
  const input = value as Record<string, unknown>;
  const byPage: Record<string, TemplateRectLike[]> = {};
  let count = 0;
  for (const [pageNumber, rawRects] of Object.entries(input)) {
    const page = analysis.find((candidate) => String(candidate.pageNumber) === pageNumber);
    if (!page) {
      throw new TemplateLifecycleError(
        `Redactions refer to page ${pageNumber}, which is not in the analysis.`,
        400,
        "INVALID_REDACTIONS",
      );
    }
    if (!Array.isArray(rawRects) || rawRects.length > MAX_TEMPLATE_RECTANGLES_PER_PAGE) {
      throw new TemplateLifecycleError(
        `A page may contain at most ${MAX_TEMPLATE_RECTANGLES_PER_PAGE} redaction boxes.`,
        400,
        "INVALID_REDACTIONS",
      );
    }
    const rects = rawRects.map((rect) => asPacketRedaction(rect, page));
    if (rects.length > 0) byPage[pageNumber] = rects;
    count += rects.length;
  }
  if (requireAtLeastOne && count === 0) {
    throw new TemplateLifecycleError(
      "Choose at least one manual redaction box before saving a template.",
      400,
      "INVALID_REDACTIONS",
    );
  }
  return byPage;
}

export type TemplateSerializationSource = {
  id: number;
  originalName: string;
  declaredSize: number;
  sha256: string;
  createdAt: Date;
};

export type TemplateSerializationRecord = {
  id: number;
  manufacturer: string;
  manufacturerCanonical: string;
  productType: string;
  eligibleProductTypes: string[];
  name: string;
  active: boolean;
  pages: unknown;
  sourceSampleId?: number | null;
  createdById: string;
  createdByName: string;
  updatedById: string;
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
};

export function serializeTemplate(
  template: TemplateSerializationRecord,
  sample: TemplateSerializationSource | null,
) {
  return {
    id: template.id,
    manufacturer: template.manufacturer,
    manufacturerCanonical: template.manufacturerCanonical,
    productType: template.productType,
    eligibleProductTypes: template.eligibleProductTypes,
    name: template.name,
    active: template.active,
    pages: template.pages,
    source: sample
      ? {
          id: sample.id,
          originalName: sample.originalName,
          size: sample.declaredSize,
          sha256: sample.sha256,
          createdAt: sample.createdAt,
        }
      : null,
    sourceAvailable: sample !== null,
    createdById: template.createdById,
    createdByName: template.createdByName,
    updatedById: template.updatedById,
    updatedByName: template.updatedByName,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}