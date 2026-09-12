import type {
  ManufacturerRedactionTemplatePage,
  PacketPageAnalysis,
  PacketRedaction,
} from "@workspace/db";

export function canonicalManufacturer(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/**
 * Returns only template boxes whose 1-based page number and analyzed
 * dimensions match exactly. A null result means the template cannot safely
 * prefill this analysis.
 */
export function matchingTemplateRedactions(
  analysis: PacketPageAnalysis[],
  pages: ManufacturerRedactionTemplatePage[],
): Record<string, PacketRedaction[]> | null {
  const redactions: Record<string, PacketRedaction[]> = {};
  for (const templatePage of pages) {
    const analyzedPage = analysis.find(
      (page) =>
        page.pageNumber === templatePage.pageNumber &&
        page.width === templatePage.width &&
        page.height === templatePage.height,
    );
    if (analyzedPage && templatePage.rects.length > 0) {
      redactions[String(analyzedPage.pageNumber)] = templatePage.rects;
    }
  }
  return Object.keys(redactions).length > 0 ? redactions : null;
}