import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { Quote, Revision, Signoff } from "@workspace/db";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM_MARGIN = 48;
const MAX_COMBINED_PACKET_PAGES = 500;
const MAX_COMBINED_PACKET_SOURCE_BYTES = 100 * 1024 * 1024;
const COMBINED_DOCUMENT_DEADLINE_MS = 60_000;
const COLORS = {
  brand: rgb(0.08, 0.27, 0.20),
  navy: rgb(0.08, 0.15, 0.24),
  gold: rgb(0.69, 0.48, 0.19),
  text: rgb(0.12, 0.14, 0.17),
  muted: rgb(0.38, 0.41, 0.44),
  border: rgb(0.82, 0.84, 0.84),
  panel: rgb(0.97, 0.98, 0.97),
  panelBlue: rgb(0.95, 0.97, 0.99),
  white: rgb(1, 1, 1),
  success: rgb(0.11, 0.39, 0.25),
} as const;

let fonts: Promise<{ regular: Uint8Array; bold: Uint8Array }> | undefined;

function loadFonts() {
  fonts ??= Promise.all([
    readFile(new URL("./assets/fonts/DejaVuSans.ttf", import.meta.url)),
    readFile(new URL("./assets/fonts/DejaVuSans-Bold.ttf", import.meta.url)),
  ]).then(([regular, bold]) => ({ regular, bold }));
  return fonts;
}

// Must remain byte-for-byte text-equivalent to signoff-document.tsx. Changes
// require a deliberate SIGNOFF_CONTENT_VERSION bump and paired UI change.
export const CUSTOMER_APPROVAL_TERMS_BULLETS = [
  "It is the responsibility of the purchaser to ensure all measurements, colors, specifications, hardware, etc. are correct.",
  "Prior to Kuiken Brothers placing the order, a signature along with a 50% deposit will be required.",
  "Cancellation or changes requested once the order has been submitted may not be possible and will incur additional fees.",
  "Units may not be returned for credit.",
  "Once received by Kuiken Brothers, windows stored for more than 2 weeks will incur a storage fee.",
] as const;
export const CUSTOMER_APPROVAL_DISCLAIMER =
  "I have reviewed all quoted line-item in detail and agree that the product specifications, unit handing, divided lite patterns, and pricing are accurate, and I approve the project for order. I acknowledge that additional charges, tax or Terms and Conditions may apply.";
export const CUSTOMER_APPROVAL_TERMS = [
  ...CUSTOMER_APPROVAL_TERMS_BULLETS.map((term) => `- ${term}`),
  "",
  "Customer Approval",
  CUSTOMER_APPROVAL_DISCLAIMER,
].join("\n");
export const ATTACHMENT_INCLUSION_STATEMENT =
  "The approved manufacturer packet pages attached to this document are included as part of this approval.";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function displayLabel(key: string): string {
  const label = key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

function displayValue(value: unknown): string {
  const stringValue = String(value ?? "").trim();
  return stringValue
    ? stringValue.charAt(0).toUpperCase() + stringValue.slice(1)
    : "";
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

type SpecificationSection = {
  title: string;
  value: unknown;
};

function specificationSections(quote: Quote): SpecificationSection[] {
  const specs = quote.specs ?? {};
  const active = new Set(quote.categories ?? []);
  const sections: SpecificationSection[] = [];
  if (active.has("windows")) sections.push({ title: "Windows", value: specs.window });
  if (active.has("interiorDoors")) {
    sections.push({ title: "Interior Doors", value: specs.interiorDoor });
  }
  if (active.has("exteriorDoors")) {
    sections.push({ title: "Exterior Doors", value: specs.exteriorDoor });
  }
  // Keep pre-split quotes readable and legally complete.
  if (active.has("doors")) sections.push({ title: "Doors", value: specs.door });
  if (active.has("trim")) sections.push({ title: "Moulding", value: specs.trimDescription });
  if (active.has("millwork")) {
    sections.push({ title: "Millwork", value: specs.millworkDescription });
  }
  return sections;
}

function specificationEntries(value: unknown): Array<{ label: string; value: string }> {
  if (typeof value === "string") {
    return isPresent(value)
      ? [{ label: "Details", value: displayValue(value) }]
      : [{ label: "Details", value: "No specific details." }];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => isPresent(entryValue))
      .map(([key, entryValue]) => ({
        label: displayLabel(key),
        value: displayValue(entryValue),
      }));
    return entries.length ? entries : [{ label: "Details", value: "No specific details." }];
  }
  return [{ label: "Details", value: "No specific details." }];
}

function revisionCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    doors: "Doors (Legacy)",
    interiorDoors: "Interior Doors",
    exteriorDoors: "Exterior Doors",
    windows: "Windows",
    trim: "Moulding",
    millwork: "Millwork",
  };
  return labels[category] ?? category;
}

function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function splitLongWord(font: PDFFont, word: string, size: number, width: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const character of word) {
    const candidate = current + character;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces.length ? pieces : [""];
}

/**
 * Wraps one visual line while retaining explicit line breaks. A character
 * fallback prevents a quote number, URL, or unusual product identifier from
 * escaping a card's bounds.
 */
function wrapLine(font: PDFFont, value: string, size: number, width: number): string[] {
  const line = value.replace(/\t/g, "    ").trim();
  if (!line) return [""];
  const words = line.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(...splitLongWord(font, word, size, width));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function wrappedLines(
  font: PDFFont,
  value: string,
  size: number,
  width: number,
): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => wrapLine(font, line, size, width));
}

function assertPdfFontCanEncode(font: PDFFont, values: string[]): void {
  for (const value of values) {
    for (const line of value.replace(/\t/g, "    ").split(/\r?\n/)) {
      try {
        font.encodeText(line);
      } catch {
        throw new Error(
          "The signed document contains characters unsupported by the embedded PDF font. Use supported Latin characters or configure a Unicode font before signing.",
        );
      }
    }
  }
}

class BrandedDocumentLayout {
  readonly pages: PDFPage[] = [];
  private page: PDFPage;
  private y: number;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly quoteNumber: string,
  ) {
    this.page = this.createPage();
    this.y = PAGE_HEIGHT - 76;
  }

  private createPage(): PDFPage {
    const page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    page.drawRectangle({
      x: 0,
      y: PAGE_HEIGHT - 6,
      width: PAGE_WIDTH,
      height: 6,
      color: COLORS.brand,
    });
    page.drawText("KUIKEN BROTHERS", {
      x: MARGIN,
      y: PAGE_HEIGHT - 38,
      size: 14,
      font: this.bold,
      color: COLORS.brand,
    });
    page.drawText("CUSTOMER SIGNOFF", {
      x: PAGE_WIDTH - MARGIN - 116,
      y: PAGE_HEIGHT - 36,
      size: 8,
      font: this.bold,
      color: COLORS.muted,
    });
    page.drawLine({
      start: { x: MARGIN, y: PAGE_HEIGHT - 54 },
      end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 54 },
      thickness: 1,
      color: COLORS.border,
    });
    return page;
  }

  startPage(): void {
    this.page = this.createPage();
    this.y = PAGE_HEIGHT - 76;
  }

  private ensureSpace(height: number): void {
    if (this.y - height < BOTTOM_MARGIN) this.startPage();
  }

  private card(
    height: number,
    options: { color?: typeof COLORS.panel; border?: typeof COLORS.border } = {},
  ): number {
    this.ensureSpace(height);
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - height,
      width: CONTENT_WIDTH,
      height,
      color: options.color ?? COLORS.panel,
      borderColor: options.border ?? COLORS.border,
      borderWidth: 0.8,
    });
    const top = this.y;
    this.y -= height + 16;
    return top;
  }

  drawTitle(title: string, subtitle: string): void {
    this.ensureSpace(72);
    this.page.drawText(title, {
      x: MARGIN,
      y: this.y,
      size: 22,
      font: this.bold,
      color: COLORS.navy,
    });
    this.y -= 25;
    this.page.drawText(subtitle, {
      x: MARGIN,
      y: this.y,
      size: 9,
      font: this.regular,
      color: COLORS.muted,
    });
    this.y -= 20;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 2,
      color: COLORS.gold,
    });
    this.y -= 20;
  }

  drawSectionHeading(title: string, kicker?: string): void {
    this.ensureSpace(38);
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - 3,
      width: 4,
      height: 22,
      color: COLORS.gold,
    });
    this.page.drawText(title, {
      x: MARGIN + 12,
      y: this.y,
      size: 13,
      font: this.bold,
      color: COLORS.navy,
    });
    if (kicker) {
      const kickerWidth = this.regular.widthOfTextAtSize(kicker, 8);
      this.page.drawText(kicker, {
        x: PAGE_WIDTH - MARGIN - kickerWidth,
        y: this.y + 1,
        size: 8,
        font: this.regular,
        color: COLORS.muted,
      });
    }
    this.y -= 29;
  }

  drawParagraph(
    value: string,
    options: {
      font?: PDFFont;
      size?: number;
      leading?: number;
      color?: typeof COLORS.text;
      italic?: boolean;
      gap?: number;
    } = {},
  ): void {
    const font = options.font ?? this.regular;
    const size = options.size ?? 9.5;
    const leading = options.leading ?? 13;
    const lines = wrappedLines(font, value, size, CONTENT_WIDTH);
    this.ensureSpace(lines.length * leading + (options.gap ?? 7));
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y,
        size,
        font,
        color: options.color ?? COLORS.text,
      });
      this.y -= leading;
    }
    this.y -= options.gap ?? 7;
  }

  drawQuoteDetails(quote: Quote, documentDate: Date): void {
    const fields = [
      { label: "Quote number", value: quote.quoteNumber || "—" },
      { label: "Prepared", value: formatDate(documentDate) },
      { label: "Customer", value: quote.customerName || "—" },
      { label: "Project", value: quote.projectName || "—" },
      { label: "Job address", value: quote.jobAddress || "—" },
    ];
    const columns = 2;
    const innerWidth = CONTENT_WIDTH - 32;
    const columnGap = 22;
    const columnWidth = (innerWidth - columnGap) / columns;
    const rows: Array<typeof fields> = [];
    for (let index = 0; index < fields.length; index += columns) {
      rows.push(fields.slice(index, index + columns));
    }
    const rowHeights = rows.map((row) =>
      Math.max(
        ...row.map(
          (field) =>
            24 + wrappedLines(this.regular, field.value, 10.5, columnWidth).length * 13,
        ),
        42,
      ),
    );
    const height = 18 + rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0) + 18;
    const top = this.card(height, { color: COLORS.panelBlue });
    let rowTop = top - 18;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      const rowHeight = rowHeights[rowIndex]!;
      row.forEach((field, columnIndex) => {
        const x = MARGIN + 16 + columnIndex * (columnWidth + columnGap);
        this.page.drawText(field.label.toUpperCase(), {
          x,
          y: rowTop,
          size: 7.5,
          font: this.bold,
          color: COLORS.muted,
        });
        const valueLines = wrappedLines(this.regular, field.value, 10.5, columnWidth);
        valueLines.forEach((line, lineIndex) => {
          this.page.drawText(line, {
            x,
            y: rowTop - 15 - lineIndex * 13,
            size: 10.5,
            font: lineIndex === 0 && field.label === "Quote number" ? this.bold : this.regular,
            color: COLORS.text,
          });
        });
      });
      rowTop -= rowHeight;
      if (rowIndex < rows.length - 1) {
        this.page.drawLine({
          start: { x: MARGIN + 16, y: rowTop + 9 },
          end: { x: PAGE_WIDTH - MARGIN - 16, y: rowTop + 9 },
          thickness: 0.5,
          color: COLORS.border,
        });
      }
    }
  }

  drawSpecCard(title: string, entries: Array<{ label: string; value: string }>): void {
    const innerWidth = CONTENT_WIDTH - 32;
    const gap = 20;
    const columnWidth = (innerWidth - gap) / 2;
    const rows: Array<Array<{ label: string; value: string }>> = [];
    for (let index = 0; index < entries.length; index += 2) {
      rows.push(entries.slice(index, index + 2));
    }
    const rowHeights = rows.map((row) =>
      Math.max(
        31,
        ...row.map((entry) => {
          const labelLines = wrappedLines(this.bold, entry.label.toUpperCase(), 7.2, columnWidth);
          const valueLines = wrappedLines(this.regular, entry.value, 9.2, columnWidth);
          return 11 + labelLines.length * 9 + valueLines.length * 12;
        }),
      ),
    );
    const height = 30 + rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0) + 14;
    const top = this.card(height, { color: COLORS.panel });
    this.page.drawRectangle({
      x: MARGIN,
      y: top - 27,
      width: CONTENT_WIDTH,
      height: 27,
      color: COLORS.brand,
    });
    this.page.drawText(title.toUpperCase(), {
      x: MARGIN + 16,
      y: top - 18,
      size: 9.5,
      font: this.bold,
      color: COLORS.white,
    });
    let rowTop = top - 44;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      const rowHeight = rowHeights[rowIndex]!;
      row.forEach((entry, columnIndex) => {
        const x = MARGIN + 16 + columnIndex * (columnWidth + gap);
        const labelLines = wrappedLines(this.bold, entry.label.toUpperCase(), 7.2, columnWidth);
        labelLines.forEach((line, lineIndex) => {
          this.page.drawText(line, {
            x,
            y: rowTop - lineIndex * 9,
            size: 7.2,
            font: this.bold,
            color: COLORS.muted,
          });
        });
        const valueLines = wrappedLines(this.regular, entry.value, 9.2, columnWidth);
        valueLines.forEach((line, lineIndex) => {
          this.page.drawText(line, {
            x,
            y: rowTop - labelLines.length * 9 - 7 - lineIndex * 12,
            size: 9.2,
            font: this.regular,
            color: COLORS.text,
          });
        });
      });
      rowTop -= rowHeight;
      if (rowIndex < rows.length - 1) {
        this.page.drawLine({
          start: { x: MARGIN + 16, y: rowTop + 7 },
          end: { x: PAGE_WIDTH - MARGIN - 16, y: rowTop + 7 },
          thickness: 0.5,
          color: COLORS.border,
        });
      }
    }
  }

  drawCallout(value: string, options: { color?: typeof COLORS.panel; label?: string } = {}): void {
    const label = options.label;
    const labelHeight = label ? 15 : 0;
    const lines = wrappedLines(this.regular, value, 9.2, CONTENT_WIDTH - 34);
    const height = 18 + labelHeight + lines.length * 13 + 13;
    const top = this.card(height, { color: options.color ?? COLORS.panelBlue });
    if (label) {
      this.page.drawText(label.toUpperCase(), {
        x: MARGIN + 16,
        y: top - 17,
        size: 7.5,
        font: this.bold,
        color: COLORS.brand,
      });
    }
    lines.forEach((line, index) => {
      this.page.drawText(line, {
        x: MARGIN + 16,
        y: top - 17 - labelHeight - index * 13,
        size: 9.2,
        font: this.regular,
        color: COLORS.text,
      });
    });
  }

  drawBulletList(items: readonly string[]): void {
    const linesByItem = items.map((item) => wrappedLines(this.regular, item, 9.2, CONTENT_WIDTH - 32));
    const height = 18 + linesByItem.reduce((sum, lines) => sum + Math.max(1, lines.length) * 13 + 5, 0) + 14;
    const top = this.card(height, { color: COLORS.panel });
    let itemTop = top - 20;
    for (const lines of linesByItem) {
      this.page.drawCircle({ x: MARGIN + 18, y: itemTop + 3, size: 2.1, color: COLORS.gold });
      lines.forEach((line, index) => {
        this.page.drawText(line, {
          x: MARGIN + 29,
          y: itemTop - index * 13,
          size: 9.2,
          font: this.regular,
          color: COLORS.text,
        });
      });
      itemTop -= Math.max(1, lines.length) * 13 + 5;
    }
  }

  drawRevisions(revisions: Revision[]): void {
    const included = revisions.filter((revision) => !revision.excludedFromSignoff);
    this.drawSectionHeading(
      "Included revisions",
      `${included.length} ${included.length === 1 ? "update" : "updates"}`,
    );
    if (!included.length) {
      this.drawCallout("No included revisions.", { color: COLORS.panel });
      return;
    }
    included.forEach((revision, index) => {
      const noteLines = wrappedLines(this.regular, revision.note, 9.2, CONTENT_WIDTH - 40);
      const tags = (revision.categories ?? []).map(revisionCategoryLabel);
      const tagHeight = tags.length ? 18 : 0;
      const height = 36 + tagHeight + Math.max(1, noteLines.length) * 13 + 17;
      const top = this.card(height, { color: COLORS.white });
      this.page.drawCircle({
        x: MARGIN + 20,
        y: top - 20,
        size: 10,
        color: COLORS.brand,
      });
      const indexText = String(index + 1);
      const indexWidth = this.bold.widthOfTextAtSize(indexText, 7.5);
      this.page.drawText(indexText, {
        x: MARGIN + 20 - indexWidth / 2,
        y: top - 23,
        size: 7.5,
        font: this.bold,
        color: COLORS.white,
      });
      const header = `${revision.authorName}  •  ${formatDateTime(revision.createdAt)}`;
      this.page.drawText(header, {
        x: MARGIN + 38,
        y: top - 18,
        size: 8.5,
        font: this.bold,
        color: COLORS.navy,
      });
      let noteTop = top - 36;
      if (tags.length) {
        const tagText = tags.join("  ·  ");
        this.page.drawText(tagText, {
          x: MARGIN + 38,
          y: noteTop,
          size: 7.2,
          font: this.bold,
          color: COLORS.brand,
        });
        noteTop -= 17;
      }
      noteLines.forEach((line, lineIndex) => {
        this.page.drawText(line, {
          x: MARGIN + 20,
          y: noteTop - lineIndex * 13,
          size: 9.2,
          font: this.regular,
          color: COLORS.text,
        });
      });
    });
  }

  drawTerms(hasManifest: boolean): void {
    this.drawSectionHeading("Terms & Conditions");
    this.drawBulletList(CUSTOMER_APPROVAL_TERMS_BULLETS);
    if (hasManifest) {
      this.drawCallout(ATTACHMENT_INCLUSION_STATEMENT, {
        color: COLORS.panelBlue,
        label: "Approved packet",
      });
    }
    this.drawSectionHeading("Customer approval");
    this.drawCallout(CUSTOMER_APPROVAL_DISCLAIMER, {
      color: rgb(0.99, 0.98, 0.94),
      label: "Approval statement",
    });
  }

  async drawSignature(
    signoff: Pick<
      Signoff,
      "customerName" | "stakeholderRole" | "signatureType" | "signatureData" | "signedAt"
    > | undefined,
    pdf: PDFDocument,
  ): Promise<void> {
    const image =
      signoff?.signatureType === "drawn"
        ? await (async () => {
            const bytes = dataUrlBytes(signoff.signatureData);
            if (!bytes) throw new Error("Validated drawn signature was not a PNG data URL.");
            try {
              return await pdf.embedPng(bytes);
            } catch (error) {
              throw new Error(
                `Validated signature image could not be embedded: ${error instanceof Error ? error.message : "unknown error"}`,
              );
            }
          })()
        : null;
    const signed = Boolean(signoff);
    const height = signed ? 190 : 164;
    const top = this.card(height, {
      color: signed ? rgb(0.95, 0.98, 0.95) : COLORS.panel,
      border: signed ? rgb(0.62, 0.78, 0.67) : COLORS.border,
    });
    if (signed) {
      this.page.drawText("ELECTRONICALLY SIGNED", {
        x: MARGIN + 18,
        y: top - 21,
        size: 9,
        font: this.bold,
        color: COLORS.success,
      });
      this.page.drawText(
        `${signoff!.customerName}  •  ${signoff!.stakeholderRole || "Other"}`,
        {
          x: MARGIN + 18,
          y: top - 40,
          size: 10,
          font: this.bold,
          color: COLORS.navy,
        },
      );
      this.page.drawText(`Signed ${formatDateTime(signoff!.signedAt)}`, {
        x: MARGIN + 18,
        y: top - 56,
        size: 8.5,
        font: this.regular,
        color: COLORS.muted,
      });
      if (signoff!.signatureType === "typed") {
        this.page.drawText(signoff!.signatureData, {
          x: MARGIN + 18,
          y: top - 99,
          size: 22,
          font: this.bold,
          color: COLORS.text,
        });
      } else if (image) {
        const scale = Math.min(220 / image.width, 70 / image.height, 1);
        this.page.drawImage(image, {
          x: MARGIN + 18,
          y: top - 117,
          width: image.width * scale,
          height: image.height * scale,
        });
      }
      this.page.drawLine({
        start: { x: MARGIN + 18, y: top - 124 },
        end: { x: MARGIN + 270, y: top - 124 },
        thickness: 1,
        color: COLORS.navy,
      });
      this.page.drawText("AUTHORIZED SIGNATURE", {
        x: MARGIN + 18,
        y: top - 139,
        size: 7.5,
        font: this.bold,
        color: COLORS.muted,
      });
    } else {
      this.page.drawText("AWAITING CUSTOMER SIGNATURE", {
        x: MARGIN + 18,
        y: top - 22,
        size: 9,
        font: this.bold,
        color: COLORS.navy,
      });
      this.page.drawText("The customer will complete this approval electronically.", {
        x: MARGIN + 18,
        y: top - 41,
        size: 8.5,
        font: this.regular,
        color: COLORS.muted,
      });
      this.page.drawLine({
        start: { x: MARGIN + 18, y: top - 100 },
        end: { x: MARGIN + 330, y: top - 100 },
        thickness: 1,
        color: COLORS.navy,
      });
      this.page.drawLine({
        start: { x: MARGIN + 360, y: top - 100 },
        end: { x: PAGE_WIDTH - MARGIN - 18, y: top - 100 },
        thickness: 1,
        color: COLORS.navy,
      });
      this.page.drawText("AUTHORIZED SIGNATURE", {
        x: MARGIN + 18,
        y: top - 115,
        size: 7.5,
        font: this.bold,
        color: COLORS.muted,
      });
      this.page.drawText("DATE", {
        x: MARGIN + 360,
        y: top - 115,
        size: 7.5,
        font: this.bold,
        color: COLORS.muted,
      });
    }
  }

  drawAttachmentDivider(): void {
    this.drawSectionHeading("Approved manufacturer pages");
    this.drawParagraph(
      "The following pages are the approved, sanitized manufacturer pages included with this customer signoff packet. They are reproduced after the signed approval sections without alteration.",
      { size: 9.2, leading: 13 },
    );
    this.drawCallout(ATTACHMENT_INCLUSION_STATEMENT, {
      color: COLORS.panelBlue,
      label: "Included in approval",
    });
  }

  finishFooters(): void {
    for (const page of this.pages) {
      page.drawLine({
        start: { x: MARGIN, y: 37 },
        end: { x: PAGE_WIDTH - MARGIN, y: 37 },
        thickness: 0.6,
        color: COLORS.border,
      });
      page.drawText("Kuiken Brothers  •  Customer signoff packet", {
        x: MARGIN,
        y: 24,
        size: 7,
        font: this.regular,
        color: COLORS.muted,
      });
      const quoteText = `Quote ${this.quoteNumber}`;
      const quoteWidth = this.regular.widthOfTextAtSize(quoteText, 7);
      page.drawText(quoteText, {
        x: PAGE_WIDTH - MARGIN - quoteWidth,
        y: 24,
        size: 7,
        font: this.regular,
        color: COLORS.muted,
      });
    }
  }
}

function dataUrlBytes(data: string): Uint8Array | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(data);
  if (!match) return null;
  return Uint8Array.from(Buffer.from(match[1]!, "base64"));
}

async function appendApprovedPages(
  pdf: PDFDocument,
  input: {
    approvedPacketPdf?: Uint8Array | null;
    approvedPacketPages?: Array<{ pdfBytes: Uint8Array; pageNumber: number }>;
  },
  assertWithinDeadline: () => void,
): Promise<boolean> {
  if (input.approvedPacketPages?.length) {
    if (input.approvedPacketPages.length > MAX_COMBINED_PACKET_PAGES) {
      throw new Error("Approved packet manifest exceeds the 500-page document limit.");
    }
    const documents = new Map<Uint8Array, PDFDocument>();
    let totalSourceBytes = 0;
    for (const selectedPage of input.approvedPacketPages) {
      assertWithinDeadline();
      let packet = documents.get(selectedPage.pdfBytes);
      if (!packet) {
        totalSourceBytes += selectedPage.pdfBytes.byteLength;
        if (totalSourceBytes > MAX_COMBINED_PACKET_SOURCE_BYTES) {
          throw new Error("Approved packet sources exceed the 100 MiB document limit.");
        }
        packet = await PDFDocument.load(selectedPage.pdfBytes, {
          ignoreEncryption: false,
        });
        documents.set(selectedPage.pdfBytes, packet);
      }
      if (
        !Number.isInteger(selectedPage.pageNumber) ||
        selectedPage.pageNumber < 1 ||
        selectedPage.pageNumber > packet.getPageCount()
      ) {
        throw new Error("Approved packet manifest contains an unavailable page.");
      }
      const [copied] = await pdf.copyPages(packet, [selectedPage.pageNumber - 1]);
      pdf.addPage(copied!);
    }
    return true;
  }
  if (!input.approvedPacketPdf) return false;
  if (input.approvedPacketPdf.byteLength > MAX_COMBINED_PACKET_SOURCE_BYTES) {
    throw new Error("Approved packet sources exceed the 100 MiB document limit.");
  }
  const packet = await PDFDocument.load(input.approvedPacketPdf, {
    ignoreEncryption: false,
  });
  if (packet.getPageCount() > MAX_COMBINED_PACKET_PAGES) {
    throw new Error("Approved packet manifest exceeds the 500-page document limit.");
  }
  const copied = await pdf.copyPages(packet, packet.getPageIndices());
  copied.forEach((page) => pdf.addPage(page));
  return copied.length > 0;
}

export async function createSignedPacketDocument(input: {
  quote: Quote;
  revisions: Revision[];
  signoff?: Pick<
    Signoff,
    "customerName" | "stakeholderRole" | "signatureType" | "signatureData" | "signedAt"
  >;
  approvedPacketPdf?: Uint8Array | null;
  approvedPacketPages?: Array<{ pdfBytes: Uint8Array; pageNumber: number }>;
}): Promise<{ bytes: Uint8Array; sha256: string }> {
  const deadline = Date.now() + COMBINED_DOCUMENT_DEADLINE_MS;
  const assertWithinDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error("Combined signoff document generation exceeded its time limit.");
    }
  };
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const embeddedFonts = await loadFonts();
  const font = await pdf.embedFont(embeddedFonts.regular, { subset: true });
  const headingFont = await pdf.embedFont(embeddedFonts.bold, { subset: true });
  const layout = new BrandedDocumentLayout(
    pdf,
    font,
    headingFont,
    input.quote.quoteNumber,
  );
  const documentDate = input.signoff?.signedAt ?? new Date();
  const sections = specificationSections(input.quote);
  const includedRevisions = input.revisions.filter((revision) => !revision.excludedFromSignoff);
  const hasManifest = Boolean(input.approvedPacketPages?.length || input.approvedPacketPdf);
  const textValues = [
    input.quote.quoteNumber,
    input.quote.customerName,
    input.quote.projectName,
    input.quote.jobAddress,
    CUSTOMER_APPROVAL_TERMS,
    CUSTOMER_APPROVAL_DISCLAIMER,
    ATTACHMENT_INCLUSION_STATEMENT,
    ...sections.flatMap((section) => [
      section.title,
      ...specificationEntries(section.value).flatMap((entry) => [entry.label, entry.value]),
    ]),
    ...includedRevisions.flatMap((revision) => [
      revision.authorName,
      revision.note,
      ...(revision.categories ?? []).map(revisionCategoryLabel),
    ]),
    input.signoff?.customerName ?? "",
    input.signoff?.stakeholderRole ?? "",
    input.signoff?.signatureType === "typed" ? input.signoff.signatureData : "",
  ];
  assertPdfFontCanEncode(font, textValues);

  layout.drawTitle(
    "Customer signoff document",
    input.signoff ? `Signed ${formatDate(input.signoff.signedAt)}` : `Prepared ${formatDate(documentDate)}`,
  );
  layout.drawQuoteDetails(input.quote, documentDate);
  layout.drawSectionHeading("Final specifications", `${sections.length} ${sections.length === 1 ? "category" : "categories"}`);
  layout.drawParagraph(
    "By signing this document, you are approving the specifications exactly as detailed below. Any subsequent changes will require a new signoff.",
    { size: 9.2, leading: 13, color: COLORS.muted },
  );
  if (sections.length) {
    for (const section of sections) {
      layout.drawSpecCard(section.title, specificationEntries(section.value));
    }
  } else {
    layout.drawCallout("No product categories have been specified.", { color: COLORS.panel });
  }
  layout.drawRevisions(input.revisions);
  layout.drawTerms(hasManifest);
  await layout.drawSignature(input.signoff, pdf);

  if (hasManifest) {
    layout.drawAttachmentDivider();
    // Manufacturer pages intentionally begin on their own native pages. Do
    // not stamp our header/footer onto them: the approved bytes are legal
    // attachments and must remain unchanged.
    await appendApprovedPages(pdf, input, assertWithinDeadline);
  }
  layout.finishFooters();

  const bytes = await pdf.save();
  return { bytes, sha256: sha256(bytes) };
}