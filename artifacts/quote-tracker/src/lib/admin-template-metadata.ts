import type { TemplateDraft, TemplateRecord } from "@/lib/template-drafts-api";

export type TemplateMetadataValues = {
  name: string;
  manufacturer: string;
  productType: string;
  eligibleProductTypes: string[];
  active: boolean;
};

type TemplateMetadataTemplate = Pick<
  TemplateRecord,
  "name" | "manufacturer" | "productType" | "eligibleProductTypes" | "active"
>;

type TemplateMetadataDraft = Pick<
  TemplateDraft,
  | "name"
  | "manufacturer"
  | "productType"
  | "eligibleProductTypes"
  | "active"
  | "id"
>;

function eligibleProductTypesFor(
  value: Pick<TemplateMetadataTemplate, "productType" | "eligibleProductTypes">,
) {
  const values = value.eligibleProductTypes?.filter(Boolean) ?? [];
  return values.length > 0 &&
    value.productType &&
    !values.includes(value.productType)
    ? [value.productType, ...values]
    : values.length > 0
      ? values
      : value.productType
        ? [value.productType]
        : [];
}

export function metadataValuesForTemplate(
  template: TemplateMetadataTemplate,
): TemplateMetadataValues {
  const eligibleTypes = eligibleProductTypesFor(template);
  return {
    name: template.name,
    manufacturer: template.manufacturer,
    productType: template.productType || eligibleTypes[0] || "",
    eligibleProductTypes: eligibleTypes,
    active: template.active,
  };
}

export function metadataValuesForDraft({
  draft,
  selectedTemplate,
  persistedMetadata,
  persistedDraftId,
}: {
  draft: TemplateMetadataDraft;
  selectedTemplate?: TemplateMetadataTemplate | null;
  persistedMetadata?: TemplateMetadataValues | null;
  persistedDraftId?: number | null;
}): TemplateMetadataValues {
  // A persisted form belongs to a particular server draft. Never apply
  // metadata from the standalone/new form or another draft to an edit draft.
  const restored =
    persistedDraftId === draft.id ? (persistedMetadata ?? null) : null;
  const draftEligibleTypes = eligibleProductTypesFor({
    productType: draft.productType ?? selectedTemplate?.productType ?? "",
    eligibleProductTypes:
      draft.eligibleProductTypes ??
      (selectedTemplate ? eligibleProductTypesFor(selectedTemplate) : []),
  });

  return {
    name: restored?.name || draft.name || selectedTemplate?.name || "",
    manufacturer:
      restored?.manufacturer ||
      draft.manufacturer ||
      selectedTemplate?.manufacturer ||
      "",
    productType:
      restored?.productType ||
      draft.productType ||
      selectedTemplate?.productType ||
      draftEligibleTypes[0] ||
      "",
    eligibleProductTypes: restored?.eligibleProductTypes?.length
      ? restored.eligibleProductTypes
      : draftEligibleTypes,
    active:
      restored?.active ?? draft.active ?? selectedTemplate?.active ?? true,
  };
}
