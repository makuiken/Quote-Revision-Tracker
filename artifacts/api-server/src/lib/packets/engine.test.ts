import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";

import {
  classifyPacketPage,
  detectPacketProfile,
  findAdministrativeRegions,
  isNormalizedRect,
} from "./profiles";
import { rasterBoundsForNormalizedRect } from "./engine";

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