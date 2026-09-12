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