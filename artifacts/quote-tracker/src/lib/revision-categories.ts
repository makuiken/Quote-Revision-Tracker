// Shared labels for revision category tags. Mirrors the quote category ids
// used across the API ("doors" is the legacy pre-split category).
export const CATEGORY_LABELS: Record<string, string> = {
  doors: "Doors (Legacy)",
  interiorDoors: "Interior Doors",
  exteriorDoors: "Exterior Doors",
  windows: "Windows",
  // Display label renamed to "Moulding"; the stored key stays `trim`.
  trim: "Moulding",
  millwork: "Millwork",
};

export function categoryLabel(id: string): string {
  return CATEGORY_LABELS[id] ?? id;
}
