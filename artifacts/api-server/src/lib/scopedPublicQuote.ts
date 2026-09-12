import type { Quote } from "@workspace/db";

export type ScopedPublicQuote = Pick<
  Quote,
  "id" | "quoteNumber" | "customerName" | "projectName" | "jobAddress" | "categories" | "specs" | "notes"
> & { displayName: string };

/** Strict field allowlist for scoped public snapshots and old snapshot reads. */
export function projectScopedPublicQuote(
  quote: Pick<Quote, "id" | "quoteNumber" | "customerName" | "projectName" | "jobAddress" | "specs" | "notes"> & {
    categories: string[];
  },
  productTypes?: string[],
): ScopedPublicQuote {
  const specs = quote.specs ?? {};
  const categories = productTypes ?? quote.categories;
  const keys: Record<string, string | undefined> = {
    windows: "window",
    doors: "door",
    interiorDoors: "interiorDoor",
    exteriorDoors: "exteriorDoor",
    trim: "trimDescription",
    millwork: "millworkDescription",
  };
  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    customerName: quote.customerName,
    projectName: quote.projectName,
    jobAddress: quote.jobAddress,
    categories,
    specs: Object.fromEntries(
      categories
        .map((type) => [keys[type], (specs as Record<string, unknown>)[keys[type]!]])
        .filter(([key]) => Boolean(key)),
    ),
    displayName: quote.projectName ? `${quote.customerName} - ${quote.projectName}` : quote.customerName,
    notes: quote.notes,
  };
}