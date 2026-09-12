import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, degrees } from "pdf-lib";

import {
  classifyPacketPage,
  detectPacketProfile,
  findAdministrativeRegions,
  isNormalizedRect,
} from "./profiles";
import { analyzePdf, rasterBoundsForNormalizedRect, textLinesFromContent } from "./engine";

test("recognizes supplied-manufacturer layouts without treating product text as branding", () => {
  assert.equal(detectPacketProfile(undefined, "400 Series Andersen window"), "andersen");
  assert.equal(detectPacketProfile("Marvin", "Product availability and pricing subject to change"), "marvin");
  assert.equal(detectPacketProfile(undefined, "Therma-Tru Energy Star Charts"), "reeb");
  assert.equal(detectPacketProfile("TruStile", "TruStile, a Marvin brand"), "trustile");
  assert.equal(detectPacketProfile(undefined, "TruStile, a Marvin brand"), "trustile");
  assert.equal(detectPacketProfile(undefined, "unrelated quote"), "unknown");
});

test("suggests narrow administrative fields, not the dealer company name", () => {
  const regions = findAdministrativeRegions([
    {
      text: "Kuiken Brothers Company, Inc.",
      bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.03 },
    },
    {
      text: "Quote #: CNRZHQY",
      bounds: { x: 0.1, y: 0.3, width: 0.2, height: 0.03 },
    },
    {
      text: "Quotation SQAP005760-2",
      bounds: { x: 0.1, y: 0.35, width: 0.2, height: 0.03 },
    },
    {
      text: "This report was generated on 9/3/2026 9:14:00 AM",
      bounds: { x: 0.1, y: 0.4, width: 0.35, height: 0.03 },
    },
    {
      text: "Manufacturer: Marvin",
      bounds: { x: 0.1, y: 0.5, width: 0.2, height: 0.03 },
    },
    {
      text: "A signature along with a 50% deposit will be required.",
      bounds: { x: 0.1, y: 0.6, width: 0.45, height: 0.03 },
    },
  ]);
  assert.equal(regions.length, 3);
  assert.deepEqual(
    regions.map((region) => region.label),
    ["quote identifier", "quote identifier", "generated timestamp"],
  );
  assert.ok(regions.every((region) => region.suggested));
});

test("does not suggest prices, totals, technical brands, or warranty terms", () => {
  const regions = findAdministrativeRegions(
    [
      { text: "Unit Price: $1,027.66", bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.03 } },
      { text: "Project Total: $12,345.00", bounds: { x: 0.1, y: 0.2, width: 0.25, height: 0.03 } },
      { text: "Marvin Ultimate Awning, Ultrex frame", bounds: { x: 0.1, y: 0.3, width: 0.35, height: 0.03 } },
      { text: "Terms and Conditions may apply.", bounds: { x: 0.1, y: 0.4, width: 0.3, height: 0.03 } },
      { text: "Manufacturer's Warranty: ten years", bounds: { x: 0.1, y: 0.5, width: 0.35, height: 0.03 } },
    ],
    { profile: "marvin", pageType: "summary" },
  );
  assert.deepEqual(regions, []);
});

test("recognizes only explicit split manufacturer identifiers", () => {
  const trustileRegions = findAdministrativeRegions(
    [
      { text: "Quotation", bounds: { x: 0.4, y: 0.05, width: 0.15, height: 0.03 } },
      { text: "SQAP005760-2", bounds: { x: 0.4, y: 0.09, width: 0.2, height: 0.03 } },
      { text: "TS4000", bounds: { x: 0.4, y: 0.2, width: 0.1, height: 0.03 } },
    ],
    { profile: "trustile", pageType: "first" },
  );
  assert.deepEqual(trustileRegions.map((region) => region.label), ["quote identifier"]);

  const reebRegions = findAdministrativeRegions(
    [
      { text: "Project Information (ID #10668758 Revision", bounds: { x: 0.07, y: 0.15, width: 0.35, height: 0.03 } },
      { text: "#15244052)", bounds: { x: 0.07, y: 0.19, width: 0.12, height: 0.03 } },
      { text: "Unit Total: $3,690.53", bounds: { x: 0.07, y: 0.3, width: 0.25, height: 0.03 } },
    ],
    { profile: "reeb", pageType: "first" },
  );
  assert.deepEqual(reebRegions.map((region) => region.label), ["project identifier", "project identifier"]);
});

test("keeps same-baseline columns in separate text rectangles", () => {
  const lines = textLinesFromContent(
    [
      { str: "SOLD BY:", width: 57.276, height: 12, transform: [12, 0, 0, 12, 188.2, 514.676] },
      { str: "SOLD TO:", width: 57.264, height: 12, transform: [12, 0, 0, 12, 436.6, 514.676] },
    ],
    { left: 0, bottom: 0, right: 792, top: 612, width: 792, height: 612 },
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.bounds.x < 0.25);
  assert.ok(lines[1]!.bounds.x > 0.5);
});

test("maps rotated text against a non-zero CropBox in top-left coordinates", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 500]);
  page.setCropBox(100, 50, 400, 300);
  page.setRotation(degrees(90));
  page.drawText("Quote #: CROP-42", { x: 120, y: 280, size: 12 });

  const analysis = await analyzePdf(Buffer.from(await document.save()));
  const pageAnalysis = analysis.pages[0]!;
  const region = pageAnalysis.regions.find((candidate) => candidate.label === "quote identifier");
  assert.equal(pageAnalysis.width, 400);
  assert.equal(pageAnalysis.height, 300);
  assert.equal(pageAnalysis.rotation, 90);
  assert.ok(region);
  // The 1.5 point text safety pad is intentional; the unpadded origin is
  // (120 - 100) / 400 and the top is 350 - (280 + 12), both in page space.
  assert.ok(Math.abs(region.bounds.x - 0.04625) < 0.001);
  assert.ok(Math.abs(region.bounds.y - 0.1883333333) < 0.001);
});

test("classifies drawings and summaries while preserving normal continuation pages", () => {
  assert.equal(classifyPacketPage(1, 17, "Quotation", "trustile"), "first");
  assert.equal(classifyPacketPage(4, 17, "Architectural Drawing Scale: 1/4", "trustile"), "drawing");
  assert.equal(classifyPacketPage(17, 17, "TERMS AND CONDITIONS Project Total", "marvin"), "summary");
  assert.equal(classifyPacketPage(2, 21, "Unit Size and hardware details", "andersen"), "continuation");
});

test("requires normalized in-page redaction rectangles", () => {
  assert.equal(isNormalizedRect({ x: 0, y: 0, width: 1, height: 1 }), true);
  assert.equal(isNormalizedRect({ x: -0.1, y: 0, width: 0.2, height: 0.2 }), false);
  assert.equal(isNormalizedRect({ x: 0.9, y: 0, width: 0.2, height: 0.2 }), false);
});

test("raster redaction covers fractional right and bottom edge pixels", () => {
  // At 101px, this starts at 10.9px and ends at 11.1px. The old
  // floor(origin)+ceil(width) implementation stopped at pixel 11, leaking the
  // pixel intersecting the right/bottom edge.
  const bounds = rasterBoundsForNormalizedRect(
    { x: 10.9 / 101, y: 10.9 / 101, width: 0.2 / 101, height: 0.2 / 101 },
    101,
    101,
  );
  assert.deepEqual(bounds, { left: 10, top: 10, width: 2, height: 2 });

  const canvas = createCanvas(101, 101);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(11, 11, 1, 1); // the old calculation left this edge pixel visible
  context.fillStyle = "#ffffff";
  context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
  assert.deepEqual([...context.getImageData(11, 11, 1, 1).data], [255, 255, 255, 255]);
});