import assert from "node:assert/strict";
import test from "node:test";
import { canonicalManufacturer, matchingTemplateRedactions } from "./templates";

test("canonical manufacturer matching trims, folds case, and collapses whitespace", () => {
  assert.equal(canonicalManufacturer("  ACME   Windows "), "acme windows");
});

test("template boxes require exact page number and dimensions", () => {
  const pages = [
    { pageNumber: 1, width: 612, height: 792, pageType: "quote" as const, suggestedRects: [] },
    { pageNumber: 2, width: 612, height: 792, pageType: "quote" as const, suggestedRects: [] },
  ];
  const template = [
    { pageNumber: 1, width: 612, height: 792, rects: [{ x: 10, y: 20, width: 30, height: 40 }] },
    { pageNumber: 2, width: 600, height: 792, rects: [{ x: 1, y: 1, width: 2, height: 2 }] },
  ];
  assert.deepEqual(matchingTemplateRedactions(pages, template), {
    "1": [{ x: 10, y: 20, width: 30, height: 40 }],
  });
  assert.equal(
    matchingTemplateRedactions(
      [{ ...pages[0]!, width: 600 }],
      template,
    ),
    null,
  );
});