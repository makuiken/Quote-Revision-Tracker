export type PacketProfile = "andersen" | "marvin" | "trustile" | "reeb" | "unknown";

export type PacketPageType = "first" | "continuation" | "summary" | "drawing" | "unknown";

export interface NormalizedRect {
  /** Left edge as a fraction of the unrotated page width. */
  x: number;
  /** Top edge as a fraction of the unrotated page height. */
  y: number;
  width: number;
  height: number;
}

export interface PageRegion {
  kind: "logo" | "header" | "footer" | "titleBlock";
  label: string;
  bounds: NormalizedRect;
  confidence: number;
  /**
   * Only true for a tight dealer/admin identity match. Product logos, drawings,
   * and broad headers are intentionally review-only.
   */
  suggested: boolean;
}

export interface TextLine {
  text: string;
  bounds: NormalizedRect;
}

// TruStile must precede Marvin: TruStile literature can correctly say
// "a Marvin brand" while still using a TruStile quotation/drawing layout.
const PROFILE_PATTERNS: ReadonlyArray<readonly [PacketProfile, RegExp]> = [
  ["trustile", /\btru[\s-]?stile\b/i],
  ["andersen", /\bandersen\b/i],
  ["marvin", /\bmarvin\b|\bultrex\b|\bbright view mesh\b/i],
  ["reeb", /\breeb\b|\btherma-tru\b/i],
];

/**
 * A selected manufacturer always wins over document text. This makes a
 * reviewer/admin correction durable even when a document mentions a parent
 * company or multiple product brands.
 */
export function detectPacketProfile(manufacturer: string | undefined, text: string): PacketProfile {
  const selectedManufacturer = manufacturer?.trim() ?? "";
  for (const [profile, pattern] of PROFILE_PATTERNS) {
    if (pattern.test(selectedManufacturer)) return profile;
  }
  for (const [profile, pattern] of PROFILE_PATTERNS) {
    if (pattern.test(text)) return profile;
  }
  return "unknown";
}

export function classifyPacketPage(
  pageNumber: number,
  pageCount: number,
  text: string,
  profile: PacketProfile,
): PacketPageType {
  if (pageNumber === 1) return "first";

  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  if (
    profile === "trustile" &&
    /\b(elevation|architectural drawing|drawing number|scale\s*:|section view)\b/.test(normalized)
  ) {
    return "drawing";
  }

  if (
    /\b(quote summary|purchase approval|sign[\s/-]?off|project subtotal|project total|grand total|terms and conditions|warrant(?:y|ies))\b/.test(
      normalized,
    ) ||
    (pageNumber === pageCount && /\b(total|warrant)/.test(normalized))
  ) {
    return "summary";
  }

  return normalized.length > 0 ? "continuation" : "unknown";
}

/**
 * Returns narrow, text-backed administrative candidates. Company-name text is
 * deliberately not a target: a customer can keep its dealer branding while
 * removing source-system quote IDs, dates, contacts, and signature fields.
 */
export function findAdministrativeRegions(lines: readonly TextLine[]): PageRegion[] {
  const adminFields: ReadonlyArray<readonly [RegExp, string]> = [
    [
      /\b(?:quote|quotation)(?:\s*(?:#|number\b|id\b)|\s+[a-z]{2,}[0-9][a-z0-9-]*)/i,
      "quote identifier",
    ],
    [/\b(?:created|print(?:ed)?|quote|submitted|latest update)\s+date\b/i, "administrative date"],
    [/\b(?:processed|generated)\s+on\b/i, "generated timestamp"],
    [/\b(?:sales\s*rep(?:\s*name)?|salesperson|account\s*manager|owner)\b/i, "administrative contact"],
    [/\b(?:phone(?:\s*\([^)]*\))?|e-?mail|shipping\s+contact|contact\s+name)\b/i, "administrative contact"],
    [
      /^\s*(?:purchase\s+approval(?:\s*\/\s*sign\s*off)?|seller\s*:|buyer\s*:|signature\s*:)/i,
      "source approval field",
    ],
    [/^\s*sold\s+by\s*:/i, "source seller field"],
  ];

  const regions: PageRegion[] = [];
  const add = (line: TextLine, label: string) => {
    if (regions.some((region) => region.bounds === line.bounds)) return;
    regions.push({
      kind: "header",
      label,
      bounds: line.bounds,
      confidence: 0.9,
      suggested: true,
    });
  };

  for (const line of lines) {
    const match = adminFields.find(([pattern]) => pattern.test(line.text));
    if (match) add(line, match[1]);
  }

  // Dates are only candidates when visually adjacent to an explicit
  // administrative date/timestamp label. This avoids broad date removal from
  // specifications, warranty terms, and product-body content.
  const dateOnly = /^\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|UTC)?)?\s*$/i;
  const dateAnchors = regions.filter((region) =>
    /administrative date|generated timestamp/.test(region.label),
  );
  for (const line of lines) {
    if (!dateOnly.test(line.text)) continue;
    const centerX = line.bounds.x + line.bounds.width / 2;
    const centerY = line.bounds.y + line.bounds.height / 2;
    const adjacent = dateAnchors.some((anchor) => {
      const anchorX = anchor.bounds.x + anchor.bounds.width / 2;
      const anchorY = anchor.bounds.y + anchor.bounds.height / 2;
      return Math.abs(centerX - anchorX) <= 0.12 && Math.abs(centerY - anchorY) <= 0.1;
    });
    if (adjacent) add(line, "administrative date value");
  }
  return regions;
}

/** @deprecated Use findAdministrativeRegions. */
export const findAdminIdentityRegions = findAdministrativeRegions;

export function drawingTitleBlockRegion(pageType: PacketPageType): PageRegion | undefined {
  if (pageType !== "drawing") return undefined;
  return {
    kind: "titleBlock",
    label: "drawing title block (manual review required)",
    bounds: { x: 0.67, y: 0.76, width: 0.31, height: 0.21 },
    confidence: 0.55,
    suggested: false,
  };
}

export function isNormalizedRect(value: NormalizedRect): boolean {
  const values = [value.x, value.y, value.width, value.height];
  return (
    values.every((part) => Number.isFinite(part)) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.width > 0 &&
    value.height > 0 &&
    value.x + value.width <= 1 &&
    value.y + value.height <= 1
  );
}