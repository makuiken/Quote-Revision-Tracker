import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  manufacturerRedactionTemplatesTable,
  manufacturerTemplateDraftsTable,
  manufacturerTemplateSamplesTable,
  type ManufacturerRedactionTemplate,
  type ManufacturerTemplateDraft,
  type ManufacturerTemplateSample,
  type ManufacturerRedactionTemplatePage,
  type PacketPageAnalysis,
  type PacketRedaction,
} from "@workspace/db";

import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import { packetEngine } from "./packets/engine";
import { canonicalManufacturer } from "./packets/templates";
import {
  MAX_TEMPLATE_RECTANGLES_PER_PAGE,
  normalizeTemplateEligibleProductTypes,
  assertTemplateDraftIdentity,
  assertTemplateBaseUnchanged,
  assertTemplateDraftReady,
  serializeTemplate,
  TemplateLifecycleError,
  validateManualRedactions,
} from "./templateLifecycleValidation";

export const MAX_TEMPLATE_SOURCE_BYTES = 40 * 1024 * 1024;
export const MAX_TEMPLATE_PROCESSING_ATTEMPTS = 3;
export const TEMPLATE_PROCESSING_ABANDONED_AFTER_MS = 15 * 60 * 1000;
export const MAX_TEMPLATE_NAME_LENGTH = 200;
export const MAX_TEMPLATE_MANUFACTURER_LENGTH = 200;
export const MAX_TEMPLATE_PRODUCT_TYPE_LENGTH = 100;
export const MAX_TEMPLATE_ELIGIBLE_PRODUCT_TYPES = 32;

const storage = new ObjectStorageService();

export type TemplateDraftStatus =
  | "awaiting_upload"
  | "analyzing"
  | "ready"
  | "saving"
  | "failed"
  | "cancelled";

export {
  MAX_TEMPLATE_RECTANGLES_PER_PAGE,
  normalizeTemplateEligibleProductTypes,
  normalizeTemplateProductType,
  QUOTE_PRODUCT_TYPES,
  assertTemplateDraftIdentity,
  assertTemplateBaseUnchanged,
  assertTemplateDraftReady,
  serializeTemplate,
  TemplateLifecycleError,
  validateManualRedactions,
} from "./templateLifecycleValidation";

export type TemplateSaveInput = {
  name?: unknown;
  manufacturer?: unknown;
  productType?: unknown;
  eligibleProductTypes?: unknown;
  active?: unknown;
  expectedTemplateUpdatedAt?: unknown;
  expectedDraftRevision?: unknown;
  manualRedactions?: unknown;
};

export type TemplateUploadInput = {
  name?: unknown;
  size?: unknown;
  contentType?: unknown;
  manufacturer?: unknown;
  productType?: unknown;
  eligibleProductTypes?: unknown;
};

export type TemplateUser = {
  id: string;
  name: string;
};

type TemplateWithSample = {
  template: ManufacturerRedactionTemplate;
  sample: ManufacturerTemplateSample | null;
};

type ReplacementSeed = {
  template: ManufacturerRedactionTemplate;
  sample: ManufacturerTemplateSample | null;
};

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown template processing error.";
  return message.slice(0, 500);
}

function asTrimmedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new TemplateLifecycleError(`${field} is required.`);
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new TemplateLifecycleError(`${field} must not be blank.`);
  if (trimmed.length > maxLength) {
    throw new TemplateLifecycleError(`${field} must be no longer than ${maxLength} characters.`);
  }
  return trimmed;
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  return asTrimmedString(value, field, maxLength);
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TemplateLifecycleError(`${field} must be a number.`);
  }
  return value;
}

function integerValue(value: unknown, field: string): number {
  const result = numberValue(value, field);
  if (!Number.isInteger(result)) {
    throw new TemplateLifecycleError(`${field} must be an integer.`);
  }
  return result;
}

function assertPdfBytes(bytes: Buffer): void {
  if (
    bytes.length < 5 ||
    !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
  ) {
    throw new TemplateLifecycleError(
      "Uploaded file is not a valid PDF.",
      422,
      "INVALID_PDF",
    );
  }
  if (bytes.length > MAX_TEMPLATE_SOURCE_BYTES) {
    throw new TemplateLifecycleError(
      "PDF exceeds the 40 MiB template sample limit.",
      422,
      "PROCESSING_LIMIT",
    );
  }
}

function pagesFromAnalysis(
  analysis: PacketPageAnalysis[],
  manualRedactions: Record<string, PacketRedaction[]>,
): ManufacturerRedactionTemplatePage[] {
  return analysis.map((page) => ({
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    rects: manualRedactions[String(page.pageNumber)] ?? [],
  }));
}

function analysisFromTemplatePages(
  pages: ManufacturerRedactionTemplatePage[],
): PacketPageAnalysis[] {
  return pages.map((page) => ({
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    pageType: "other",
    suggestedRects: [],
  }));
}

function sourcePathForDraft(
  draft: ManufacturerTemplateDraft,
  sample: ManufacturerTemplateSample | null,
): string | null {
  return draft.uploadObjectPath ?? sample?.objectPath ?? null;
}

async function sampleForDraft(draft: ManufacturerTemplateDraft) {
  if (!draft.sourceSampleId) return null;
  const [sample] = await db
    .select()
    .from(manufacturerTemplateSamplesTable)
    .where(eq(manufacturerTemplateSamplesTable.id, draft.sourceSampleId));
  return sample ?? null;
}

export function serializeTemplateDraft(
  draft: ManufacturerTemplateDraft,
  sample: ManufacturerTemplateSample | null,
) {
  return {
    id: draft.id,
    templateId: draft.templateId,
    status: draft.status,
    originalName: draft.originalName,
    declaredSize: draft.declaredSize,
    sourceAvailable: Boolean(sample || (draft.uploadObjectPath && draft.status !== "awaiting_upload")),
    baseTemplateUpdatedAt: draft.baseTemplateUpdatedAt,
    source: sample
      ? {
          originalName: sample.originalName,
          size: sample.declaredSize,
          sha256: sample.sha256,
          createdAt: sample.createdAt,
        }
      : draft.sourceSha256 && draft.originalName && draft.declaredSize
        ? {
            originalName: draft.originalName,
            size: draft.declaredSize,
            sha256: draft.sourceSha256,
            createdAt: draft.createdAt,
          }
        : null,
    manufacturer: draft.manufacturer,
    manufacturerCanonical: draft.manufacturerCanonical,
    productType: draft.productType,
    eligibleProductTypes: draft.eligibleProductTypes,
    name: draft.name,
    active: draft.active,
    revision: draft.revision,
    analysis: draft.analysis,
    manualRedactions: draft.manualRedactions,
    warnings: [],
    failureMessage: draft.failureMessage,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export async function getTemplateWithSample(id: number): Promise<TemplateWithSample | null> {
  const [row] = await db
    .select({
      template: manufacturerRedactionTemplatesTable,
      sample: manufacturerTemplateSamplesTable,
    })
    .from(manufacturerRedactionTemplatesTable)
    .leftJoin(
      manufacturerTemplateSamplesTable,
      eq(
        manufacturerRedactionTemplatesTable.sourceSampleId,
        manufacturerTemplateSamplesTable.id,
      ),
    )
    .where(eq(manufacturerRedactionTemplatesTable.id, id));
  return row
    ? {
        template: row.template,
        sample: row.sample,
      }
    : null;
}

export async function listTemplates(): Promise<TemplateWithSample[]> {
  const rows = await db
    .select({
      template: manufacturerRedactionTemplatesTable,
      sample: manufacturerTemplateSamplesTable,
    })
    .from(manufacturerRedactionTemplatesTable)
    .leftJoin(
      manufacturerTemplateSamplesTable,
      eq(
        manufacturerRedactionTemplatesTable.sourceSampleId,
        manufacturerTemplateSamplesTable.id,
      ),
    )
    .orderBy(desc(manufacturerRedactionTemplatesTable.updatedAt));
  return rows.map((row) => ({ template: row.template, sample: row.sample }));
}

export async function getDraft(id: number): Promise<ManufacturerTemplateDraft | null> {
  const [draft] = await db
    .select()
    .from(manufacturerTemplateDraftsTable)
    .where(eq(manufacturerTemplateDraftsTable.id, id));
  return draft ?? null;
}

export async function getDraftWithSample(id: number) {
  const draft = await getDraft(id);
  if (!draft) return null;
  const sample = await sampleForDraft(draft);
  return { draft, sample };
}

async function createUploadDraft(
  input: TemplateUploadInput,
  user: TemplateUser,
  templateId: number | null = null,
  replacementSeed: ReplacementSeed | null = null,
): Promise<{ draft: ManufacturerTemplateDraft; uploadURL: string; objectPath: string }> {
  const originalName = asTrimmedString(input.name, "name", 255);
  const size = integerValue(input.size, "size");
  if (size < 1 || size > MAX_TEMPLATE_SOURCE_BYTES) {
    throw new TemplateLifecycleError("Template sample must be between 1 byte and 40 MiB.");
  }
  if (input.contentType !== "application/pdf") {
    throw new TemplateLifecycleError("Template sample contentType must be application/pdf.");
  }
  const inputManufacturer = optionalTrimmedString(
    input.manufacturer,
    "manufacturer",
    MAX_TEMPLATE_MANUFACTURER_LENGTH,
  );
  const inputProductType = optionalTrimmedString(
    input.productType,
    "productType",
    MAX_TEMPLATE_PRODUCT_TYPE_LENGTH,
  );
  const manufacturer = inputManufacturer ?? replacementSeed?.template.manufacturer ?? null;
  const productType = inputProductType ?? replacementSeed?.template.productType ?? null;
  const eligibleProductTypes = normalizeTemplateEligibleProductTypes(
    input.eligibleProductTypes ??
      replacementSeed?.template.eligibleProductTypes ??
      (productType ? [productType] : []),
    productType,
  );
  const objectPath = `/objects/manufacturer-template-staging/${randomUUID()}.pdf`;
  const [draft] = await db
    .insert(manufacturerTemplateDraftsTable)
    .values({
      templateId,
      originalTemplateId: templateId,
      sourceSampleId: replacementSeed?.sample?.id ?? null,
      uploadObjectPath: objectPath,
      originalName,
      declaredSize: size,
      baseTemplateUpdatedAt: replacementSeed?.template.updatedAt ?? null,
      manufacturer,
      manufacturerCanonical: manufacturer ? canonicalManufacturer(manufacturer) : null,
      productType,
      eligibleProductTypes,
      name: replacementSeed?.template.name ?? null,
      ...(replacementSeed ? { active: replacementSeed.template.active } : {}),
      status: "awaiting_upload",
      createdById: user.id,
      createdByName: user.name,
      updatedById: user.id,
      updatedByName: user.name,
    })
    .returning();
  if (!draft) throw new Error("Template draft could not be created.");
  try {
    const uploadURL = await storage.getObjectEntityUploadURLForPath(objectPath);
    return { draft, uploadURL, objectPath };
  } catch (error) {
    await db
      .delete(manufacturerTemplateDraftsTable)
      .where(eq(manufacturerTemplateDraftsTable.id, draft.id));
    throw error;
  }
}

export async function createTemplateUploadDraft(
  input: TemplateUploadInput,
  user: TemplateUser,
) {
  return createUploadDraft(input, user);
}

export async function createTemplateEditDraft(
  templateId: number,
  input: TemplateUploadInput | undefined,
  replaceSample: boolean,
  user: TemplateUser,
) {
  const existing = await getTemplateWithSample(templateId);
  if (!existing) {
    throw new TemplateLifecycleError("Template not found.", 404, "TEMPLATE_NOT_FOUND");
  }
  if (replaceSample) {
    return createUploadDraft(input ?? {}, user, templateId, existing);
  }
  const { template, sample } = existing;
  const [draft] = await db
    .insert(manufacturerTemplateDraftsTable)
    .values({
      templateId: template.id,
      originalTemplateId: template.id,
      sourceSampleId: sample?.id ?? null,
      originalName: sample?.originalName ?? null,
      declaredSize: sample?.declaredSize ?? null,
      sourceSha256: sample?.sha256 ?? null,
      baseTemplateUpdatedAt: template.updatedAt,
      manufacturer: template.manufacturer,
      manufacturerCanonical: template.manufacturerCanonical,
      productType: template.productType,
      eligibleProductTypes: template.eligibleProductTypes,
      name: template.name,
      active: template.active,
      analysis: analysisFromTemplatePages(template.pages),
      manualRedactions: Object.fromEntries(
        template.pages
          .filter((page) => page.rects.length > 0)
          .map((page) => [String(page.pageNumber), page.rects]),
      ),
      status: "ready",
      createdById: user.id,
      createdByName: user.name,
      updatedById: user.id,
      updatedByName: user.name,
    })
    .returning();
  if (!draft) throw new Error("Template edit draft could not be created.");
  return { draft, sample };
}

async function claimDraftForAnalysis(
  draftId: number,
  user: TemplateUser,
) {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(manufacturerTemplateDraftsTable)
      .where(eq(manufacturerTemplateDraftsTable.id, draftId))
      .for("update");
    if (!draft) throw new TemplateLifecycleError("Template draft not found.", 404, "DRAFT_NOT_FOUND");
    if (draft.status === "cancelled") {
      throw new TemplateLifecycleError("This template draft was cancelled.", 409, "DRAFT_CANCELLED");
    }
    if (!draft.uploadObjectPath) {
      throw new TemplateLifecycleError(
        "This draft has no uploaded sample. Upload a replacement sample before analyzing.",
        400,
        "SOURCE_SAMPLE_MISSING",
      );
    }
    const isFreshProcessing =
      draft.status === "analyzing" &&
      draft.processingStartedAt &&
      Date.now() - draft.processingStartedAt.getTime() <= TEMPLATE_PROCESSING_ABANDONED_AFTER_MS;
    if (isFreshProcessing) {
      throw new TemplateLifecycleError(
        "This template sample is already being analyzed.",
        409,
        "DRAFT_BUSY",
      );
    }
    if (draft.attemptCount >= MAX_TEMPLATE_PROCESSING_ATTEMPTS) {
      throw new TemplateLifecycleError(
        "Template analysis retry limit reached. Upload a new sample.",
        409,
        "PROCESSING_LIMIT",
      );
    }
    const processingAttemptToken = randomUUID();
    const [claimed] = await tx
      .update(manufacturerTemplateDraftsTable)
      .set({
        status: "analyzing",
        attemptCount: draft.attemptCount + 1,
        revision: draft.revision + 1,
        processingAttemptToken,
        processingStartedAt: new Date(),
        failureMessage: null,
        updatedById: user.id,
        updatedByName: user.name,
        updatedAt: new Date(),
      })
      .where(eq(manufacturerTemplateDraftsTable.id, draft.id))
      .returning();
    return claimed!;
  });
}

export async function analyzeTemplateDraft(
  draftId: number,
  manufacturerInput: unknown,
  user: TemplateUser,
) {
  const claimed = await claimDraftForAnalysis(draftId, user);
  const manufacturer =
    manufacturerInput === undefined
      ? claimed.manufacturer
      : optionalTrimmedString(
          manufacturerInput,
          "manufacturer",
          MAX_TEMPLATE_MANUFACTURER_LENGTH,
        );
  const token = claimed.processingAttemptToken!;
  try {
    const metadata = await storage.getObjectEntityMetadata(claimed.uploadObjectPath!);
    if (metadata.size !== claimed.declaredSize) {
      throw new TemplateLifecycleError(
        "Uploaded bytes do not match the declared sample size.",
        422,
        "INVALID_UPLOAD",
      );
    }
    const bytes = await storage.downloadObjectBytesBounded(
      claimed.uploadObjectPath!,
      MAX_TEMPLATE_SOURCE_BYTES,
    );
    assertPdfBytes(bytes);
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const analysis = await packetEngine.analyzePdf(bytes, manufacturer);
    if (
      !Array.isArray(analysis.pages) ||
      analysis.pages.length < 1 ||
      analysis.pages.length > 100
    ) {
      throw new TemplateLifecycleError(
        "PDF analysis returned an unsupported page count.",
        422,
        "PROCESSING_LIMIT",
      );
    }
    const [updated] = await db
      .update(manufacturerTemplateDraftsTable)
      .set({
        status: "ready",
        manufacturer,
        manufacturerCanonical: manufacturer ? canonicalManufacturer(manufacturer) : null,
        analysis: analysis.pages,
        manualRedactions: null,
        sourceSha256,
        sourceGeneration: metadata.generation ?? null,
        processingAttemptToken: null,
        processingStartedAt: null,
        failureMessage: null,
        revision: claimed.revision + 1,
        updatedById: user.id,
        updatedByName: user.name,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(manufacturerTemplateDraftsTable.id, claimed.id),
          eq(manufacturerTemplateDraftsTable.revision, claimed.revision),
          eq(manufacturerTemplateDraftsTable.processingAttemptToken, token),
          eq(manufacturerTemplateDraftsTable.status, "analyzing"),
        ),
      )
      .returning();
    if (!updated) {
      throw new TemplateLifecycleError("Template draft changed during analysis.", 409, "DRAFT_CONFLICT");
    }
    return { draft: updated, analysisWarnings: analysis.warnings };
  } catch (error) {
    const message = cleanError(error);
    await db
      .update(manufacturerTemplateDraftsTable)
      .set({
        status: "failed",
        processingAttemptToken: null,
        processingStartedAt: null,
        failureMessage: message,
        revision: claimed.revision + 1,
        updatedById: user.id,
        updatedByName: user.name,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(manufacturerTemplateDraftsTable.id, claimed.id),
          eq(manufacturerTemplateDraftsTable.revision, claimed.revision),
          eq(manufacturerTemplateDraftsTable.processingAttemptToken, token),
        ),
      );
    if (error instanceof TemplateLifecycleError) throw error;
    if (error instanceof ObjectNotFoundError) {
      throw new TemplateLifecycleError(
        "The uploaded source sample is unavailable. Upload it again.",
        422,
        "SOURCE_SAMPLE_MISSING",
      );
    }
    throw new TemplateLifecycleError(message, 422, "ANALYSIS_FAILED");
  }
}

export async function updateDraftRedactions(
  draftId: number,
  value: unknown,
  user: TemplateUser,
) {
  const current = await getDraft(draftId);
  if (!current) throw new TemplateLifecycleError("Template draft not found.", 404, "DRAFT_NOT_FOUND");
  assertTemplateDraftReady(current.status, Boolean(current.analysis), "redactions");
  const analysis = current.analysis;
  if (!analysis) throw new TemplateLifecycleError("Analyze the sample before editing redactions.", 409, "DRAFT_NOT_READY");
  const manualRedactions = validateManualRedactions(analysis, value);
  const [updated] = await db
    .update(manufacturerTemplateDraftsTable)
    .set({
      manualRedactions,
      revision: current.revision + 1,
      updatedById: user.id,
      updatedByName: user.name,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(manufacturerTemplateDraftsTable.id, draftId),
        eq(manufacturerTemplateDraftsTable.revision, current.revision),
        eq(manufacturerTemplateDraftsTable.status, "ready"),
        sql`${manufacturerTemplateDraftsTable.analysis} IS NOT NULL`,
      ),
    )
    .returning();
  if (!updated) throw new TemplateLifecycleError("Template draft changed; reload it and retry.", 409, "DRAFT_CONFLICT");
  return updated;
}

async function bytesForDraft(draft: ManufacturerTemplateDraft): Promise<Buffer> {
  const sample = await sampleForDraft(draft);
  const path = sourcePathForDraft(draft, sample);
  if (!path) {
    throw new TemplateLifecycleError(
      "This template has no retained source sample. Upload a replacement sample to preview it.",
      404,
      "SOURCE_SAMPLE_MISSING",
    );
  }
  try {
    if (draft.uploadObjectPath && draft.sourceGeneration) {
      const metadata = await storage.getObjectEntityMetadata(path);
      if (metadata.generation && metadata.generation !== draft.sourceGeneration) {
        throw new TemplateLifecycleError(
          "The uploaded sample changed after analysis. Analyze it again.",
          409,
          "DRAFT_CONFLICT",
        );
      }
    }
    const bytes = await storage.downloadObjectBytesBounded(path, MAX_TEMPLATE_SOURCE_BYTES);
    assertPdfBytes(bytes);
    return bytes;
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new TemplateLifecycleError(
        "The original source sample is no longer available. Upload a replacement sample.",
        404,
        "SOURCE_SAMPLE_MISSING",
      );
    }
    throw error;
  }
}

export async function renderTemplateSourcePage(draftId: number, pageNumber: number) {
  const draft = await getDraft(draftId);
  if (!draft) throw new TemplateLifecycleError("Template draft not found.", 404, "DRAFT_NOT_FOUND");
  const page = integerValue(pageNumber, "pageNumber");
  if (!draft.analysis?.some((candidate) => candidate.pageNumber === page)) {
    throw new TemplateLifecycleError("Source page is outside the analyzed document.", 400, "INVALID_PAGE");
  }
  return packetEngine.renderPdfPreview(await bytesForDraft(draft), page, { dpi: 140 });
}

export async function renderTemplatePreview(
  draftId: number,
  pageNumber: number,
  value: unknown,
) {
  const draft = await getDraft(draftId);
  if (!draft) throw new TemplateLifecycleError("Template draft not found.", 404, "DRAFT_NOT_FOUND");
  if (!draft.analysis) {
    throw new TemplateLifecycleError("Analyze the sample before previewing it.", 409, "DRAFT_NOT_READY");
  }
  const page = integerValue(pageNumber, "pageNumber");
  if (!draft.analysis.some((candidate) => candidate.pageNumber === page)) {
    throw new TemplateLifecycleError("Preview page is outside the analyzed document.", 400, "INVALID_PAGE");
  }
  const redactions = value === undefined ? draft.manualRedactions ?? {} : validateManualRedactions(draft.analysis, value);
  const bytes = await bytesForDraft(draft);
  const sanitized = await packetEngine.generateSanitizedPacket({
    bytes,
    manufacturer: draft.manufacturer,
    pageDimensions: draft.analysis.map(({ pageNumber, width, height }) => ({
      pageNumber,
      width,
      height,
    })),
    redactionsByPage: Object.fromEntries(
      Object.entries(redactions).map(([key, rects]) => [
        Number(key),
        rects,
      ]),
    ),
    pageOrder: [page],
  });
  const output = sanitized.pages[0]?.pngBytes;
  if (!output) throw new TemplateLifecycleError("Preview rendering returned no page.", 422, "PREVIEW_FAILED");
  return Buffer.from(output);
}

function saveString(value: unknown, field: string, maxLength: number): string {
  return asTrimmedString(value, field, maxLength);
}

export async function saveTemplateDraft(
  draftId: number,
  input: TemplateSaveInput,
  user: TemplateUser,
) {
  const current = await getDraft(draftId);
  if (!current) throw new TemplateLifecycleError("Template draft not found.", 404, "DRAFT_NOT_FOUND");
  assertTemplateDraftReady(current.status, Boolean(current.analysis));
  const analysis = current.analysis;
  if (!analysis) {
    throw new TemplateLifecycleError(
      "Analyze the sample successfully before saving the template.",
      409,
      "DRAFT_NOT_READY",
    );
  }
  const name = saveString(input.name ?? current.name, "name", MAX_TEMPLATE_NAME_LENGTH);
  const manufacturer = saveString(
    input.manufacturer ?? current.manufacturer,
    "manufacturer",
    MAX_TEMPLATE_MANUFACTURER_LENGTH,
  );
  const productType = saveString(
    input.productType ?? current.productType,
    "productType",
    MAX_TEMPLATE_PRODUCT_TYPE_LENGTH,
  );
  const eligibleProductTypes = normalizeTemplateEligibleProductTypes(
    input.eligibleProductTypes ??
      (current.eligibleProductTypes.length > 0
        ? current.eligibleProductTypes
        : current.productType
          ? [current.productType]
          : []),
    productType,
    false,
  );
  const active =
    input.active === undefined
      ? current.active
      : typeof input.active === "boolean"
        ? input.active
        : (() => {
            throw new TemplateLifecycleError("active must be a boolean.");
          })();
  if (
    input.expectedDraftRevision !== undefined &&
    integerValue(input.expectedDraftRevision, "expectedDraftRevision") !== current.revision
  ) {
    throw new TemplateLifecycleError("Template draft changed; reload it and retry.", 409, "DRAFT_CONFLICT");
  }
  const redactions = input.manualRedactions === undefined
    ? current.manualRedactions
    : validateManualRedactions(analysis, input.manualRedactions);
  const pages = pagesFromAnalysis(
    analysis,
    validateManualRedactions(analysis, redactions ?? {}, true),
  );
  const canonical = canonicalManufacturer(manufacturer);

  // Copy first to a unique immutable key. If the database transaction below
  // conflicts, the orphan is removed best-effort; no existing sample is ever
  // overwritten or deleted.
  let immutablePath: string | null = null;
  let sourceSha256: string | null = null;
  let sourceBytes: Buffer | null = null;
  if (current.uploadObjectPath) {
    try {
      const metadata = await storage.getObjectEntityMetadata(current.uploadObjectPath);
      if (
        current.sourceGeneration &&
        metadata.generation &&
        metadata.generation !== current.sourceGeneration
      ) {
        throw new TemplateLifecycleError(
          "The uploaded sample changed after analysis. Analyze it again.",
          409,
          "DRAFT_CONFLICT",
        );
      }
      sourceBytes = await storage.downloadObjectBytesBounded(
        current.uploadObjectPath,
        MAX_TEMPLATE_SOURCE_BYTES,
      );
      assertPdfBytes(sourceBytes);
      sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
      if (current.sourceSha256 && sourceSha256 !== current.sourceSha256) {
        throw new TemplateLifecycleError(
          "The uploaded sample changed after analysis. Analyze it again.",
          409,
          "DRAFT_CONFLICT",
        );
      }
      immutablePath = `/objects/manufacturer-template-samples/${randomUUID()}.pdf`;
      await storage.copyObjectEntityImmutable(
        current.uploadObjectPath,
        immutablePath,
        current.sourceGeneration ?? undefined,
      );
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw new TemplateLifecycleError(
          "The uploaded source sample is unavailable. Upload it again.",
          422,
          "SOURCE_SAMPLE_MISSING",
        );
      }
      throw error;
    }
  }

  let committed = false;
  try {
    const outcome = await db.transaction(async (tx) => {
      const templateLockId = current.originalTemplateId ?? current.templateId;
      if (templateLockId !== null) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`manufacturer_template_id:${templateLockId}`}))`,
        );
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`manufacturer_template:${canonical}`}))`,
      );
      const [draft] = await tx
        .select()
        .from(manufacturerTemplateDraftsTable)
        .where(eq(manufacturerTemplateDraftsTable.id, draftId))
        .for("update");
      if (!draft || draft.status === "cancelled") {
        throw new TemplateLifecycleError("Template draft is no longer available.", 409, "DRAFT_CONFLICT");
      }
      if (draft.revision !== current.revision) {
        throw new TemplateLifecycleError(
          "Template draft changed in another session. Reload before saving.",
          409,
          "DRAFT_CONFLICT",
        );
      }
      assertTemplateDraftReady(draft.status, Boolean(draft.analysis));
      assertTemplateDraftIdentity(
        draft.templateId,
        draft.originalTemplateId,
        draft.sourceSampleId,
        draft.baseTemplateUpdatedAt,
        draft.uploadObjectPath,
        draft.status,
        Boolean(draft.analysis),
      );
      const existingTemplate = draft.templateId
        ? (
            await tx
              .select()
              .from(manufacturerRedactionTemplatesTable)
              .where(eq(manufacturerRedactionTemplatesTable.id, draft.templateId))
              .for("update")
          )[0]
        : null;
      if (draft.templateId && !existingTemplate) {
        throw new TemplateLifecycleError("Template not found.", 404, "TEMPLATE_NOT_FOUND");
      }
      assertTemplateBaseUnchanged(
        draft.templateId,
        draft.baseTemplateUpdatedAt,
        existingTemplate?.updatedAt ?? null,
      );
      const [conflict] = await tx
        .select({ id: manufacturerRedactionTemplatesTable.id })
        .from(manufacturerRedactionTemplatesTable)
        .where(
          and(
            eq(manufacturerRedactionTemplatesTable.manufacturerCanonical, canonical),
            sql`${manufacturerRedactionTemplatesTable.eligibleProductTypes} && ARRAY[${sql.join(
              eligibleProductTypes.map((category) => sql`${category}`),
              sql`, `,
            )}]::text[]`,
          ),
        )
        .limit(1);
      if (conflict && conflict.id !== existingTemplate?.id) {
        throw new TemplateLifecycleError(
          "A template already exists for this manufacturer and an overlapping eligible product type.",
          409,
          "TEMPLATE_CONFLICT",
        );
      }
      let template: ManufacturerRedactionTemplate;
      if (existingTemplate) {
        const [updated] = await tx
          .update(manufacturerRedactionTemplatesTable)
          .set({
            manufacturer,
            manufacturerCanonical: canonical,
            productType,
            eligibleProductTypes,
            name,
            active,
            pages,
            ...(immutablePath ? {} : {}),
            updatedById: user.id,
            updatedByName: user.name,
            updatedAt: new Date(),
          })
          .where(eq(manufacturerRedactionTemplatesTable.id, existingTemplate.id))
          .returning();
        template = updated!;
      } else {
        const [created] = await tx
          .insert(manufacturerRedactionTemplatesTable)
          .values({
            manufacturer,
            manufacturerCanonical: canonical,
            productType,
            eligibleProductTypes,
            name,
            active,
            pages,
            createdById: user.id,
            createdByName: user.name,
            updatedById: user.id,
            updatedByName: user.name,
          })
          .returning();
        template = created!;
      }
      let sample: ManufacturerTemplateSample | null = null;
      if (immutablePath) {
        [sample] = await tx
          .insert(manufacturerTemplateSamplesTable)
          .values({
            templateId: template.id,
            objectPath: immutablePath,
            originalName: current.originalName ?? "template-sample.pdf",
            declaredSize: sourceBytes?.length ?? current.declaredSize ?? 0,
            sha256: sourceSha256 ?? current.sourceSha256 ?? "",
            createdById: user.id,
            createdByName: user.name,
          })
          .returning();
        const [withSample] = await tx
          .update(manufacturerRedactionTemplatesTable)
          .set({ sourceSampleId: sample!.id, updatedAt: new Date() })
          .where(eq(manufacturerRedactionTemplatesTable.id, template.id))
          .returning();
        template = withSample!;
      }
      await tx
        .update(manufacturerTemplateDraftsTable)
        .set({
          templateId: template.id,
          sourceSampleId: sample?.id ?? draft.sourceSampleId,
          uploadObjectPath: null,
          name,
          manufacturer,
          manufacturerCanonical: canonical,
          productType,
          eligibleProductTypes,
          active,
          analysis: current.analysis,
          manualRedactions: redactions,
          status: "ready",
          revision: draft.revision + 1,
          updatedById: user.id,
          updatedByName: user.name,
          updatedAt: new Date(),
        })
        .where(eq(manufacturerTemplateDraftsTable.id, draft.id));
      return { template, sample: sample ?? null };
    });
    committed = true;
    const persisted = await getTemplateWithSample(outcome.template.id);
    return { ...persisted!, created: current.templateId === null };
  } catch (error) {
    if (immutablePath && !committed) {
      await storage.deleteObjectEntity(immutablePath).catch(() => undefined);
    }
    throw error;
  }
}

export async function cancelTemplateDraft(draftId: number, user: TemplateUser) {
  const [updated] = await db
    .update(manufacturerTemplateDraftsTable)
    .set({
      status: "cancelled",
      processingAttemptToken: null,
      processingStartedAt: null,
      revision: sql`${manufacturerTemplateDraftsTable.revision} + 1`,
      updatedById: user.id,
      updatedByName: user.name,
      updatedAt: new Date(),
    })
    .where(eq(manufacturerTemplateDraftsTable.id, draftId))
    .returning({ id: manufacturerTemplateDraftsTable.id });
  if (!updated) throw new TemplateLifecycleError("Template draft not found.", 404, "DRAFT_NOT_FOUND");
}