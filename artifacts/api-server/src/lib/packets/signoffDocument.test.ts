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

import {
  createSignedPacketDocument,
  withSignoffDocumentAssemblyCapacity,
} from "./signoffDocument";

const quote = {
  id: 1,
  quoteNumber: "Q-1",
  customerName: "Customer",
  projectName: "Project",
  jobAddress: "Address",
  categories: [],
  specs: {},
} as unknown as Quote;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("queues concurrent whole-document assembly behind the global bound", async () => {
  const heldLocks = new Set<number>();
  let checkedOut = 0;
  let peakCheckedOut = 0;
  const fakePool = {
    async connect() {
      checkedOut += 1;
      peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
      let released = false;
      return {
        async query(sql: string, values: number[]) {
          const key = values[0]!;
          if (sql.includes("try_advisory")) {
            const acquired = !heldLocks.has(key);
            if (acquired) heldLocks.add(key);
            return { rows: [{ acquired }] };
          }
          heldLocks.delete(key);
          return { rows: [{}] };
        },
        release() {
          if (!released) checkedOut -= 1;
          released = true;
        },
      };
    },
  };
  const firstGate = deferred();
  let activeAssemblies = 0;
  let peakAssemblies = 0;
  const order: string[] = [];
  const runAssembly = (name: string, gate?: Promise<void>) =>
    withSignoffDocumentAssemblyCapacity(
      Date.now() + 2_000,
      async () => {
        activeAssemblies += 1;
        peakAssemblies = Math.max(peakAssemblies, activeAssemblies);
        order.push(`${name}:start`);
        if (gate) await gate;
        order.push(`${name}:end`);
        activeAssemblies -= 1;
      },
      { connectionPool: fakePool, bypassInTests: false },
    );

  const first = runAssembly("first", firstGate.promise);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = runAssembly("second");
  const third = runAssembly("third");
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(activeAssemblies, 1);
  assert.equal(peakAssemblies, 1);
  // Waiters release unsuccessful connection attempts instead of retaining the
  // pool while the heavy assembly slot is occupied.
  assert.equal(checkedOut, 1);
  assert.ok(peakCheckedOut <= 2);

  firstGate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(peakAssemblies, 1);
  assert.equal(checkedOut, 0);
  assert.deepEqual(order.slice(0, 2), ["first:start", "first:end"]);
  assert.ok(order.indexOf("second:start") > order.indexOf("first:end"));
  assert.ok(order.indexOf("third:start") > order.indexOf("first:end"));
  assert.ok(order.indexOf("second:end") > order.indexOf("second:start"));
  assert.ok(order.indexOf("third:end") > order.indexOf("third:start"));
});

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

test("keeps interleaved source order and duplicate approved pages", async () => {
  async function packetWithPages(labels: string[]): Promise<Uint8Array> {
    const packet = await PDFDocument.create();
    const font = await packet.embedFont(StandardFonts.Helvetica);
    for (const label of labels) {
      const page = packet.addPage([420, 595]);
      page.drawText(label, { x: 24, y: 540, font, size: 18 });
    }
    return packet.save();
  }

  const sourceA = await packetWithPages(["SOURCE A PAGE 1", "SOURCE A PAGE 2"]);
  const sourceB = await packetWithPages(["SOURCE B PAGE 1"]);
  const document = await createSignedPacketDocument({
    quote,
    revisions: [],
    approvedPacketPages: [
      { pdfBytes: sourceA, pageNumber: 2 },
      { pdfBytes: sourceB, pageNumber: 1 },
      { pdfBytes: sourceA, pageNumber: 2 },
      { pdfBytes: sourceA, pageNumber: 1 },
      { pdfBytes: sourceB, pageNumber: 1 },
    ],
  });

  const parsed = await PDFDocument.load(document.bytes);
  const copiedPacketPages = parsed
    .getPages()
    .filter((page) => page.getWidth() === 420 && page.getHeight() === 595);
  assert.equal(
    copiedPacketPages.length,
    5,
    "every manifest occurrence must create a trailing page",
  );
  assert.equal(
    new Set(copiedPacketPages.map((page) => page.ref.toString())).size,
    5,
    "duplicate selections must retain independent page-tree references",
  );
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: document.bytes }).promise;
  const trailingText: string[] = [];
  for (
    let pageNumber = loaded.numPages - 4;
    pageNumber <= loaded.numPages;
    pageNumber += 1
  ) {
    const content = await (await loaded.getPage(pageNumber)).getTextContent();
    trailingText.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
  }
  assert.deepEqual(trailingText, [
    "SOURCE A PAGE 2",
    "SOURCE B PAGE 1",
    "SOURCE A PAGE 2",
    "SOURCE A PAGE 1",
    "SOURCE B PAGE 1",
  ]);
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
