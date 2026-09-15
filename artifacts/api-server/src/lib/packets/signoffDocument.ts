import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { Quote, Revision, Signoff } from "@workspace/db";
import { renderSignoffDocumentHtmlPdf } from "./signoffDocumentHtml";

const MAX_COMBINED_PACKET_PAGES = 500;
const MAX_COMBINED_PACKET_SOURCE_BYTES = 100 * 1024 * 1024;
const COMBINED_DOCUMENT_DEADLINE_MS = 60_000;

// Keep these exports available to the versioning code and tests. The actual
// presentation lives in @workspace/signoff-document and is rendered by the
// offline Chromium print path.
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

type SignoffQuote = Pick<
  Quote,
  | "quoteNumber"
  | "customerName"
  | "projectName"
  | "jobAddress"
  | "categories"
  | "specs"
  | "notes"
>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertValidSignature(signoff: SignoffDocumentInput["signoff"]): void {
  if (!signoff || signoff.signatureType !== "drawn") return;
  if (
    !/^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(signoff.signatureData)
  ) {
    throw new Error("Validated drawn signature was not a PNG data URL.");
  }
}

function normalizedSignoff(
  signoff: SignoffDocumentInput["signoff"],
): SignoffDocumentInput["signoff"] & { signatureType: "typed" | "drawn" } {
  if (!signoff) return signoff as never;
  if (signoff.signatureType !== "typed" && signoff.signatureType !== "drawn") {
    throw new Error("Signoff signature type is invalid.");
  }
  return {
    ...signoff,
    signatureType: signoff.signatureType,
  };
}

async function appendApprovedPages(
  pdf: PDFDocument,
  input: {
    approvedPacketPdf?: Uint8Array | null;
    approvedPacketPages?: Array<{ pdfBytes: Uint8Array; pageNumber: number }>;
  },
  assertWithinDeadline: () => void,
): Promise<void> {
  if (input.approvedPacketPages?.length) {
    if (input.approvedPacketPages.length > MAX_COMBINED_PACKET_PAGES) {
      throw new Error(
        "Approved packet manifest exceeds the 500-page document limit.",
      );
    }
    const documents = new Map<Uint8Array, PDFDocument>();
    let totalSourceBytes = 0;
    for (const selectedPage of input.approvedPacketPages) {
      assertWithinDeadline();
      let packet = documents.get(selectedPage.pdfBytes);
      if (!packet) {
        totalSourceBytes += selectedPage.pdfBytes.byteLength;
        if (totalSourceBytes > MAX_COMBINED_PACKET_SOURCE_BYTES) {
          throw new Error(
            "Approved packet sources exceed the 100 MiB document limit.",
          );
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
        throw new Error(
          "Approved packet manifest contains an unavailable page.",
        );
      }
      const [copied] = await pdf.copyPages(packet, [
        selectedPage.pageNumber - 1,
      ]);
      pdf.addPage(copied!);
    }
    return;
  }
  if (!input.approvedPacketPdf) return;
  if (input.approvedPacketPdf.byteLength > MAX_COMBINED_PACKET_SOURCE_BYTES) {
    throw new Error(
      "Approved packet sources exceed the 100 MiB document limit.",
    );
  }
  const packet = await PDFDocument.load(input.approvedPacketPdf, {
    ignoreEncryption: false,
  });
  if (packet.getPageCount() > MAX_COMBINED_PACKET_PAGES) {
    throw new Error(
      "Approved packet manifest exceeds the 500-page document limit.",
    );
  }
  const copied = await pdf.copyPages(packet, packet.getPageIndices());
  copied.forEach((page) => pdf.addPage(page));
}

type SignoffDocumentInput = {
  quote: SignoffQuote;
  revisions: Revision[];
  signoff?: Pick<
    Signoff,
    | "customerName"
    | "stakeholderRole"
    | "signatureType"
    | "signatureData"
    | "signedAt"
  >;
  approvedPacketPdf?: Uint8Array | null;
  approvedPacketPages?: Array<{ pdfBytes: Uint8Array; pageNumber: number }>;
  scope?: { included: string[]; notIncluded: string[] };
  /** Locked request creation time for unsigned scoped preview rendering. */
  documentDate?: Date;
};

/**
 * Render the same React presentation used by SignoffDocument in an offline
 * Chromium page, then append captured manufacturer pages without rewriting
 * their bytes. All inputs must already be captured under the caller's quote
 * or approval lock; this function never reloads mutable quote/token state.
 */
export async function createSignedPacketDocument(
  input: SignoffDocumentInput,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const deadline = Date.now() + COMBINED_DOCUMENT_DEADLINE_MS;
  const assertWithinDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error(
        "Combined signoff document generation exceeded its time limit.",
      );
    }
  };
  if ((input.approvedPacketPages?.length ?? 0) > MAX_COMBINED_PACKET_PAGES) {
    throw new Error(
      "Approved packet manifest exceeds the 500-page document limit.",
    );
  }
  assertValidSignature(input.signoff);
  const signoff = normalizedSignoff(input.signoff);
  const documentDate = input.documentDate ?? signoff?.signedAt ?? new Date();
  const hasManifest = Boolean(
    input.approvedPacketPages?.length || input.approvedPacketPdf,
  );

  const htmlPdf = await renderSignoffDocumentHtmlPdf({
    quote: input.quote,
    revisions: input.revisions,
    signoff,
    hasManifest,
    productTypes: input.scope?.included,
    notIncludedProductTypes: input.scope?.notIncluded,
    preparedAt: documentDate.toISOString(),
  });
  assertWithinDeadline();

  const pdf = await PDFDocument.load(htmlPdf, { ignoreEncryption: false });
  await appendApprovedPages(pdf, input, assertWithinDeadline);
  const bytes = await pdf.save();
  return { bytes, sha256: sha256(bytes) };
}
