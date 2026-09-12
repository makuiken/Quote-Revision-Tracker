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
const BODY_SIZE = 10;
const LEADING = 14;
const MAX_COMBINED_PACKET_PAGES = 500;
const MAX_COMBINED_PACKET_SOURCE_BYTES = 100 * 1024 * 1024;
const COMBINED_DOCUMENT_DEADLINE_MS = 60_000;
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
export const CUSTOMER_APPROVAL_TERMS = [
  "- It is the responsibility of the purchaser to ensure all measurements, colors, specifications, hardware, etc. are correct.",
  "- Prior to Kuiken Brothers placing the order, a signature along with a 50% deposit will be required.",
  "- Cancellation or changes requested once the order has been submitted may not be possible and will incur additional fees.",
  "- Units may not be returned for credit.",
  "- Once received by Kuiken Brothers, windows stored for more than 2 weeks will incur a storage fee.",
  "",
  "Customer Approval",
  "I have reviewed all quoted line-item in detail and agree that the product specifications, unit handing, divided lite patterns, and pricing are accurate, and I approve the project for order. I acknowledge that additional charges, tax or Terms and Conditions may apply.",
].join("\n");
export const ATTACHMENT_INCLUSION_STATEMENT =
  "The approved manufacturer packet pages attached to this document are included as part of this approval.";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function visibleSpecificationLines(quote: Quote): string[] {
  const specs = quote.specs ?? {};
  const active = new Set(quote.categories);
  const sections: Array<[string, unknown]> = [];
  if (active.has("windows")) sections.push(["Windows", specs.window]);
  if (active.has("interiorDoors")) sections.push(["Interior Doors", specs.interiorDoor]);
  if (active.has("exteriorDoors")) sections.push(["Exterior Doors", specs.exteriorDoor]);
  if (active.has("doors")) sections.push(["Doors", specs.door]);
  if (active.has("trim")) sections.push(["Trim", specs.trimDescription]);
  if (active.has("millwork")) sections.push(["Millwork", specs.millworkDescription]);
  return sections.flatMap(([title, value]) => {
    const details =
      typeof value === "string"
        ? value.trim()
          ? [value.trim().charAt(0).toUpperCase() + value.trim().slice(1)]
          : []
        : value && typeof value === "object"
          ? Object.entries(value as Record<string, unknown>)
              .filter(([, entryValue]) => Boolean(entryValue))
              .map(([key, entryValue]) => {
                const label = key.replace(/([A-Z])/g, " $1").trim();
                return `${label.charAt(0).toUpperCase() + label.slice(1)}: ${
                  String(entryValue).charAt(0).toUpperCase() +
                  String(entryValue).slice(1)
                }`;
              })
          : [];
    return [title, ...(details.length ? details : ["No specific details."])];
  });
}

function wrap(font: PDFFont, value: string, width: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, BODY_SIZE) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function assertPdfWinAnsi(font: PDFFont, values: string[]): void {
  for (const value of values) {
    // Newlines are layout delimiters and are never drawn by pdf-lib as a glyph.
    // Encoding a whole multi-line block would reject U+000A even though every
    // rendered line is valid Helvetica/WinAnsi text.
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

function textPages(
  pdf: PDFDocument,
  font: PDFFont,
  headingFont: PDFFont,
  title: string,
  text: string,
): PDFPage[] {
  const pages: PDFPage[] = [];
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = PAGE_HEIGHT - MARGIN;
  const brandPage = () => {
    page.drawText("KUIKEN BROTHERS", {
      x: MARGIN, y, size: 15, font: headingFont, color: rgb(0.12, 0.27, 0.21),
    });
    y -= 26;
  };
  brandPage();
  const startPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN;
    brandPage();
  };
  page.drawText(title, {
    x: MARGIN,
    y,
    size: 16,
    font: headingFont,
    color: rgb(0.08, 0.15, 0.26),
  });
  y -= 28;
  for (const rawLine of text.split("\n")) {
    const lines = rawLine ? wrap(font, rawLine, PAGE_WIDTH - MARGIN * 2) : [""];
    for (const line of lines) {
      if (y < MARGIN) startPage();
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font });
      y -= LEADING;
    }
    y -= rawLine ? 2 : 6;
  }
  return pages;
}

function dataUrlBytes(data: string): Uint8Array | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(data);
  if (!match) return null;
  return Uint8Array.from(Buffer.from(match[1]!, "base64"));
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
  const approvalTerms =
    input.approvedPacketPages?.length || input.approvedPacketPdf
      ? `${CUSTOMER_APPROVAL_TERMS}\n\n${ATTACHMENT_INCLUSION_STATEMENT}`
      : CUSTOMER_APPROVAL_TERMS;

  const quoteText = [
    `Quote number: ${input.quote.quoteNumber}`,
    `Customer: ${input.quote.customerName}`,
    `Project: ${input.quote.projectName}`,
    `Job address: ${input.quote.jobAddress}`,
    "",
    "Complete specifications",
    ...visibleSpecificationLines(input.quote),
  ]
    .filter(Boolean)
    .join("\n");
  const revisionText = input.revisions.length
    ? input.revisions
        .map(
          (revision) =>
            `${revision.createdAt.toISOString()} — ${revision.authorName}\n${revision.note}`,
        )
        .join("\n\n")
    : "No included revisions.";
  assertPdfWinAnsi(font, [
    quoteText,
    revisionText,
    approvalTerms,
    input.signoff?.customerName ?? "",
    input.signoff?.stakeholderRole ?? "",
    input.signoff?.signatureType === "typed"
      ? input.signoff.signatureData
      : "",
  ]);
  textPages(pdf, font, headingFont, "Quote & Specifications", quoteText);

  textPages(pdf, font, headingFont, "Included Revisions", revisionText);
  textPages(pdf, font, headingFont, "Terms & Conditions", approvalTerms);

  const signaturePage = textPages(
    pdf,
    font,
    headingFont,
    "Customer Signature",
    [
      input.signoff
        ? `Signed by: ${input.signoff.customerName}\nRole: ${input.signoff.stakeholderRole}\nSigned at: ${input.signoff.signedAt.toISOString()}\nSignature type: ${input.signoff.signatureType}`
        : "Awaiting customer signature.",
    ].join("\n"),
  )[0]!;
  if (input.signoff?.signatureType === "typed") {
    signaturePage.drawText(input.signoff.signatureData, {
      x: MARGIN,
      y: 610,
      size: 20,
      font: headingFont,
      color: rgb(0.1, 0.1, 0.1),
    });
  } else if (input.signoff) {
    const imageBytes = dataUrlBytes(input.signoff.signatureData);
    if (imageBytes) {
      try {
        const signature = await pdf.embedPng(imageBytes);
        const scale = Math.min(220 / signature.width, 80 / signature.height, 1);
        signaturePage.drawImage(signature, {
          x: MARGIN,
          y: 560,
          width: signature.width * scale,
          height: signature.height * scale,
        });
      } catch (error) {
        throw new Error(
          `Validated signature image could not be embedded: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    } else {
      throw new Error("Validated drawn signature was not a PNG data URL.");
    }
  }

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
  } else if (input.approvedPacketPdf) {
    const packet = await PDFDocument.load(input.approvedPacketPdf, {
      ignoreEncryption: false,
    });
    const copied = await pdf.copyPages(packet, packet.getPageIndices());
    copied.forEach((page) => pdf.addPage(page));
  }

  const bytes = await pdf.save();
  return { bytes, sha256: sha256(bytes) };
}