import type {
  ManufacturerRedactionTemplatePage,
  PacketPageAnalysis,
  PacketRedaction,
} from "@workspace/db";

export function canonicalManufacturer(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export type TemplateMatchFeedbackCode =
  | "no_active_match"
  | "layout_incompatible";

export function templateNoActiveMatchFeedback(
  manufacturer: string | null,
  productType: string | null,
): string {
  const identity = [
    manufacturer?.trim()
      ? `manufacturer "${manufacturer.trim()}"`
      : "the uploaded manufacturer",
    productType
      ? `product type "${productType}"`
      : "the uploaded product type",
  ].join(" and ");
  return `[template:no_active_match] No active redaction template matched ${identity}; review redactions manually.`;
}

export function templateLayoutMismatchFeedback(templateName: string): string {
  return `[template:layout_incompatible] Active redaction template "${templateName}" was found, but its page count, page numbers, or dimensions do not match this upload; no template boxes were applied. Review redactions manually.`;
}

type ManufacturerTemplateOption = {
  manufacturer: string;
  manufacturerCanonical?: string | null;
  productType: string;
};

export type ManufacturerTemplateEligibility = {
  manufacturer: string;
  manufacturerCanonical?: string | null;
  eligibleProductTypes: readonly string[];
};

export function expandTemplateOptions<T extends ManufacturerTemplateEligibility>(
  templates: readonly T[],
): ManufacturerTemplateOption[] {
  return templates.flatMap(({ manufacturer, manufacturerCanonical, eligibleProductTypes }) =>
    eligibleProductTypes.map((productType) => ({
      manufacturer,
      manufacturerCanonical,
      productType,
    })),
  );
}

/**
 * The template key is canonicalized by the API, but old/imported rows can
 * still have display values that differ in case or whitespace. Keep the first
 * active display value for each canonical manufacturer/category pair so the
 * upload dropdown cannot offer the same choice twice.
 */
export function deduplicateTemplateOptions<T extends ManufacturerTemplateOption>(
  options: readonly T[],
): T[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const manufacturer = canonicalManufacturer(
      option.manufacturerCanonical || option.manufacturer,
    );
    const key = `${option.productType}:${manufacturer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Returns only template boxes whose 1-based page number and analyzed
 * dimensions match exactly. The template must describe the complete packet
 * layout; returning a partial set of boxes would make an incompatible upload
 * look like a successful automatic match.
 */
export function matchingTemplateRedactions(
  analysis: PacketPageAnalysis[],
  pages: ManufacturerRedactionTemplatePage[],
): Record<string, PacketRedaction[]> | null {
  if (analysis.length === 0 || pages.length === 0 || analysis.length !== pages.length) {
    return null;
  }

  const analyzedPages = new Map(analysis.map((page) => [page.pageNumber, page]));
  const templatePageNumbers = new Set<number>();
  for (const templatePage of pages) {
    if (templatePageNumbers.has(templatePage.pageNumber)) {
      return null;
    }
    templatePageNumbers.add(templatePage.pageNumber);
    const analyzedPage = analyzedPages.get(templatePage.pageNumber);
    if (
      !analyzedPage ||
      analyzedPage.width !== templatePage.width ||
      analyzedPage.height !== templatePage.height
    ) {
      return null;
    }
  }

  if (templatePageNumbers.size !== analyzedPages.size) return null;

  const redactions: Record<string, PacketRedaction[]> = {};
  for (const templatePage of pages) {
    if (templatePage.rects.length > 0) {
      redactions[String(templatePage.pageNumber)] = templatePage.rects;
    }
  }
  return Object.keys(redactions).length > 0 ? redactions : null;
}