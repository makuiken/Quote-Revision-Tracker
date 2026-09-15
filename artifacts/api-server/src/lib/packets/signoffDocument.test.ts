import { hashApprovedManifest } from "./manifestHash";

test("manifest fingerprints cover sanitized bytes and exact page sequence", () => {
  const a = {
    packetId: 1,
    pageNumber: 1,
    pageOrder: 0,
    sanitizedPdfSha256: "a",
  };
  const b = {
    packetId: 2,
    pageNumber: 1,
    pageOrder: 1,
    sanitizedPdfSha256: "b",
  };
  assert.equal(
    hashApprovedManifest([a, b]),
    hashApprovedManifest([{ ...a }, { ...b }]),
  );
  assert.notEqual(hashApprovedManifest([a, b]), hashApprovedManifest([b, a]));
  assert.notEqual(
    hashApprovedManifest([a]),
    hashApprovedManifest([{ ...a, sanitizedPdfSha256: "changed" }]),
  );
});
import assert from "node:assert/strict";
import test from "node:test";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
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
    scope: { included: ["windows"], notIncluded: ["millwork"] },
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
  const text = [];
  for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
    const content = await (await loaded.getPage(pageNumber)).getTextContent();
    text.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
  }
  assert.match(text.join(" "), /Jan 1, 2026/);
  assert.match(text.join(" "), /February 2, 2026/);
  assert.match(text.join(" "), /Included:\s+Windows/);
  assert.match(text.join(" "), /Not included:\s+Millwork/);
});

test("scoped PDF keeps canonical included specs and revisions only", async () => {
  const document = await createSignedPacketDocument({
    quote: {
      ...quote,
      categories: ["windows", "exteriorDoors"],
      specs: {
        window: { brand: "Included Windows Brand" },
        exteriorDoor: { brand: "Excluded Exterior Brand" },
      },
    },
    scope: { included: ["windows"], notIncluded: ["exteriorDoors"] },
    revisions: [
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        authorName: "Sales Team",
        note: "Included windows revision",
        categories: ["windows"],
        excludedFromSignoff: false,
      } as never,
      {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        authorName: "Sales Team",
        note: "Unrelated exterior revision",
        categories: ["exteriorDoors"],
        excludedFromSignoff: false,
      } as never,
      {
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        authorName: "Sales Team",
        note: "Excluded windows revision",
        categories: ["windows"],
        excludedFromSignoff: true,
      } as never,
    ],
    approvedPacketPages: [],
  });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: document.bytes }).promise;
  const text = [];
  for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
    const content = await (await loaded.getPage(pageNumber)).getTextContent();
    text.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
  }
  const allText = text.join(" ");
  assert.match(allText, /Included windows revision/);
  assert.match(allText, /Included Windows Brand/i);
  assert.doesNotMatch(allText, /Unrelated exterior revision/);
  assert.doesNotMatch(allText, /Excluded windows revision/);
  assert.doesNotMatch(allText, /Excluded Exterior Brand/i);
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
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: document.bytes }).promise;
  const text = [];
  for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
    const content = await (await loaded.getPage(pageNumber)).getTextContent();
    text.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
  }
  const allText = text.join(" ");
  assert.match(allText, /Kuiken Brothers/);
  assert.match(allText, /KB-2026-0142/);
  assert.match(allText, /Andersen/);
  assert.match(allText, /North Ridge Renovation/);
  const resources = parsed.getPage(0).node.Resources();
  const xObjects = resources?.lookup(PDFName.of("XObject"), PDFDict);
  assert.ok(
    xObjects && xObjects.keys().length > 0,
    "the branded logo image is embedded",
  );
});

test("keeps approved manufacturer pages as unchanged trailing pages", async () => {
  const packet = await PDFDocument.create();
  const packetPage = packet.addPage([420, 595]);
  const packetFont = await packet.embedFont(StandardFonts.Helvetica);
  packetPage.drawText("PACKET CONTENT", {
    x: 24,
    y: 540,
    font: packetFont,
    size: 18,
  });
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
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: document.bytes }).promise;
  const content = await (
    await loaded.getPage(loaded.numPages)
  ).getTextContent();
  assert.match(
    content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    /PACKET CONTENT/,
  );
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
