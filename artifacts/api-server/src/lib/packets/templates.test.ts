import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalManufacturer,
  deduplicateTemplateOptions,
  expandTemplateOptions,
  matchingTemplateRedactions,
  templateLayoutMismatchFeedback,
  templateNoActiveMatchFeedback,
} from "./templates";

test("canonical manufacturer matching trims, folds case, and collapses whitespace", () => {
  assert.equal(canonicalManufacturer("  ACME   Windows "), "acme windows");
});

test("template processing feedback persists distinct no-match reasons", () => {
  assert.match(
    templateNoActiveMatchFeedback(" ACME ", "windows"),
    /^\[template:no_active_match\].*manufacturer "ACME".*product type "windows"/,
  );
  assert.match(
    templateLayoutMismatchFeedback("ACME standard"),
    /^\[template:layout_incompatible\].*page count, page numbers, or dimensions/,
  );
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
  assert.deepEqual(
    matchingTemplateRedactions(
      pages,
      template.map((page) => ({ ...page, width: 612 })),
    ),
    {
      "1": [{ x: 10, y: 20, width: 30, height: 40 }],
      "2": [{ x: 1, y: 1, width: 2, height: 2 }],
    },
  );
  // A single incompatible page invalidates the complete match rather than
  // applying only the boxes that happen to line up.
  assert.equal(matchingTemplateRedactions(pages, template), null);
  assert.equal(
    matchingTemplateRedactions(
      [{ ...pages[0]!, width: 600 }],
      template,
    ),
    null,
  );
});

test("template options deduplicate by canonical manufacturer and product type", () => {
  const options = deduplicateTemplateOptions([
    { manufacturer: "Acme", manufacturerCanonical: "acme", productType: "windows" },
    { manufacturer: " ACME  ", manufacturerCanonical: "acme", productType: "windows" },
    { manufacturer: "Acme", manufacturerCanonical: "acme", productType: "doors" },
    { manufacturer: "Other", manufacturerCanonical: null, productType: "windows" },
  ]);

  assert.deepEqual(options, [
    { manufacturer: "Acme", manufacturerCanonical: "acme", productType: "windows" },
    { manufacturer: "Acme", manufacturerCanonical: "acme", productType: "doors" },
    { manufacturer: "Other", manufacturerCanonical: null, productType: "windows" },
  ]);
});

test("one template expands into an option for every eligible product type", () => {
  assert.deepEqual(
    expandTemplateOptions([
      {
        manufacturer: "Door Maker",
        manufacturerCanonical: "door maker",
        eligibleProductTypes: ["interiorDoors", "exteriorDoors"],
      },
    ]),
    [
      {
        manufacturer: "Door Maker",
        manufacturerCanonical: "door maker",
        productType: "interiorDoors",
      },
      {
        manufacturer: "Door Maker",
        manufacturerCanonical: "door maker",
        productType: "exteriorDoors",
      },
    ],
  );
});