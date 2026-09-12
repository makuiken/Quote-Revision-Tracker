import { hashApprovedManifest } from "./manifestHash";

test("manifest fingerprints cover sanitized bytes and exact page sequence", () => {
  const a = { packetId: 1, pageNumber: 1, pageOrder: 0, sanitizedPdfSha256: "a" };
  const b = { packetId: 2, pageNumber: 1, pageOrder: 1, sanitizedPdfSha256: "b" };
  assert.equal(hashApprovedManifest([a, b]), hashApprovedManifest([{ ...a }, { ...b }]));
  assert.notEqual(hashApprovedManifest([a, b]), hashApprovedManifest([b, a]));
  assert.notEqual(hashApprovedManifest([a]), hashApprovedManifest([{ ...a, sanitizedPdfSha256: "changed" }]));
});
import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import type { Quote } from "@workspace/db";

import { createSignedPacketDocument } from "./signoffDocument";

const quote = {
  id: 1,
  quoteNumber: "Q-1",
  customerName: "Customer",
  projectName: "Project",
  jobAddress: "Address",
  categories: [],
  specs: {},
} as unknown as Quote;

test("rejects an oversized manifest before parsing repeated packet PDFs", async () => {
  const entries = Array.from({ length: 501 }, () => ({
    pdfBytes: new Uint8Array([0]),
    pageNumber: 1,
  }));
  await assert.rejects(
    createSignedPacketDocument({
      quote,
      revisions: [],
      approvedPacketPages: entries,
    }),
    /500-page document limit/,
  );
});

test("renders an unsigned document containing multiline terms", async () => {
  const document = await createSignedPacketDocument({
    quote,
    revisions: [],
    approvedPacketPages: [],
  });
  assert.ok(document.bytes.byteLength > 100);
});

test("scoped signed PDF keeps the locked prepared date separate from signing day", async () => {
  const document = await createSignedPacketDocument({
    quote,
    revisions: [],
    approvedPacketPages: [],
    documentDate: new Date("2026-01-01T00:00:00.000Z"),
    signoff: {
      customerName: "Customer",
      stakeholderRole: "Homeowner",
      signatureType: "typed",
      signatureData: "Customer",
      signedAt: new Date("2026-02-02T00:00:00.000Z"),
    },
  });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: document.bytes }).promise;
  const content = await (await loaded.getPage(1)).getTextContent();
  const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
  assert.match(text, /January 1, 2026/);
  assert.match(text, /February 2, 2026/);
});

test("renders branded cards, categorized specifications, and complete revisions", async () => {
  const document = await createSignedPacketDocument({
    quote: {
      ...quote,
      quoteNumber: "KB-2026-0142",
      customerName: "José García",
      projectName: "North Ridge Renovation",
      jobAddress: "12 Main Street, Ridgefield, NJ 07657",
      categories: ["windows", "exteriorDoors", "millwork"],
      specs: {
        window: {
          brand: "Andersen",
          series: "A-Series",
          dividedLites: "6 over 6",
          hardwareFinish: "Satin nickel",
        },
        exteriorDoor: {
          brand: "TruStile",
          seriesStyle: "TS-5500",
          lockPrep: "Multi-point",
        },
        millworkDescription: "Custom casing\nwith returns and backband",
      },
    },
    revisions: [
      {
        id: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        authorName: "Sales Team",
        note: "First line of the complete revision note.\nSecond line remains visible in the PDF.",
        categories: ["windows"],
        excludedFromSignoff: false,
      } as never,
    ],
  });
  const parsed = await PDFDocument.load(document.bytes);
  assert.ok(parsed.getPageCount() >= 2, "long-form cards should paginate");
  assert.equal(parsed.getPage(0).getWidth(), 612);
  assert.equal(parsed.getPage(0).getHeight(), 792);
});

test("keeps approved manufacturer pages as unchanged trailing pages", async () => {
  const packet = await PDFDocument.create();
  packet.addPage([420, 595]);
  const packetBytes = await packet.save();
  const document = await createSignedPacketDocument({
    quote,
    revisions: [],
    approvedPacketPages: [{ pdfBytes: packetBytes, pageNumber: 1 }],
  });
  const parsed = await PDFDocument.load(document.bytes);
  const lastPage = parsed.getPage(parsed.getPageCount() - 1);
  assert.equal(lastPage.getWidth(), 420);
  assert.equal(lastPage.getHeight(), 595);
});

test("embeds a drawn signature and Unicode auto-revision content", async () => {
  const document = await createSignedPacketDocument({
    quote: { ...quote, customerName: "José García" },
    revisions: [
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        authorName: "System",
        note: "notes: (blank) → Edited after typed signature",
      } as never,
    ],
    signoff: {
      customerName: "José García",
      stakeholderRole: "Homeowner",
      signatureType: "drawn",
      // A valid opaque one-pixel PNG; PDF embedding verifies the drawn path.
      signatureData:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9NwAAAABJRU5ErkJggg==",
      signedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  assert.ok(document.bytes.byteLength > 100);
});