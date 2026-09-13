import assert from "node:assert/strict";
import test from "node:test";

const {
  assertTemplateBaseUnchanged,
  assertTemplateDraftIdentity,
  assertTemplateDraftReady,
  normalizeTemplateEligibleProductTypes,
  normalizeTemplateProductType,
  QUOTE_PRODUCT_TYPES,
  validateManualRedactions,
  serializeTemplate,
} = await import("./templateLifecycleValidation");

const analysis = [
  {
    pageNumber: 1,
    width: 600,
    height: 400,
    pageType: "cover" as const,
    suggestedRects: [],
  },
];

test("template redactions are bounded by analyzed page geometry", () => {
  assert.deepEqual(
    validateManualRedactions(analysis, {
      "1": [{ x: 0, y: 0, width: 600, height: 400, reason: "admin field" }],
    }, true),
    {
      "1": [{ x: 0, y: 0, width: 600, height: 400, reason: "admin field" }],
    },
  );
});

test("template redactions reject unknown pages and boxes outside bounds", () => {
  assert.throws(
    () => validateManualRedactions(analysis, { "2": [] }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("not in the analysis"),
  );
  assert.throws(
    () =>
      validateManualRedactions(analysis, {
        "1": [{ x: 590, y: 0, width: 20, height: 10 }],
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("inside page bounds"),
  );
});

test("empty geometry cannot be saved as a template", () => {
  assert.throws(
    () => validateManualRedactions(analysis, { "1": [] }, true),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("at least one manual redaction"),
  );
});

test("template state guards allow only analyzed ready drafts", () => {
  for (const status of ["awaiting_upload", "analyzing", "failed"]) {
    assert.throws(
      () => assertTemplateDraftReady(status, true),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("before saving"),
    );
    assert.throws(
      () => assertTemplateDraftReady(status, true, "redactions"),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("before editing redactions"),
    );
  }
  assert.throws(
    () => assertTemplateDraftReady("cancelled", true),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("cancelled"),
  );
  assert.throws(
    () => assertTemplateDraftReady("ready", false),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("before saving"),
  );
  assert.doesNotThrow(() => assertTemplateDraftReady("ready", true));
});

test("edit saves use the server-captured template base", () => {
  const base = new Date("2025-01-01T00:00:00.000Z");
  assert.doesNotThrow(() => assertTemplateBaseUnchanged(12, base, new Date(base)));
  assert.throws(
    () => assertTemplateBaseUnchanged(12, null, new Date(base)),
    (error: unknown) =>
      error instanceof Error &&
      error.message.toLowerCase().includes("reopen the template"),
  );
  assert.throws(
    () =>
      assertTemplateBaseUnchanged(
        12,
        base,
        new Date("2025-01-02T00:00:00.000Z"),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("changed after the draft was opened"),
  );
  assert.doesNotThrow(() => assertTemplateBaseUnchanged(null, null, null));
});

test("detached edit drafts cannot fall back to template creation", () => {
  assert.doesNotThrow(() =>
    assertTemplateDraftIdentity(
      12,
      12,
      5,
      new Date("2025-01-01T00:00:00.000Z"),
      null,
      "ready",
      true,
    ),
  );
  assert.throws(
    () =>
      assertTemplateDraftIdentity(
        null,
        12,
        5,
        new Date("2025-01-01T00:00:00.000Z"),
        null,
        "ready",
        true,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("no longer exists"),
  );
  assert.throws(
    () =>
      assertTemplateDraftIdentity(
        null,
        null,
        5,
        new Date("2025-01-01T00:00:00.000Z"),
        "/objects/manufacturer-template-staging/replacement.pdf",
        "ready",
        true,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("detached"),
  );
  assert.throws(
    () =>
      assertTemplateDraftIdentity(null, null, null, null, null, "ready", true),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("detached"),
  );
  assert.doesNotThrow(() =>
    assertTemplateDraftIdentity(
      null,
      null,
      null,
      null,
      "/objects/manufacturer-template-staging/new.pdf",
      "ready",
      true,
    ),
  );
});

test("template product types use the quote category catalog", () => {
  assert.deepEqual(QUOTE_PRODUCT_TYPES, [
    "doors",
    "interiorDoors",
    "exteriorDoors",
    "windows",
    "trim",
    "millwork",
  ]);
  assert.equal(normalizeTemplateProductType(" interiorDoors "), "interiorDoors");
  assert.equal(normalizeTemplateProductType("millwork"), "millwork");
  assert.throws(
    () => normalizeTemplateProductType("interiorDoor"),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("interiorDoors") &&
      "code" in error &&
      error.code === "INVALID_PRODUCT_TYPE",
  );
  assert.deepEqual(
    normalizeTemplateEligibleProductTypes(
      ["windows", "interiorDoors", "windows"],
      "windows",
    ),
    ["windows", "interiorDoors"],
  );
  assert.throws(
    () =>
      normalizeTemplateEligibleProductTypes(
        ["windows", "interiorDoor"],
        "windows",
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("interiorDoors"),
  );
});

test("legacy templates serialize with an explicit missing source", () => {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const template = serializeTemplate(
    {
      id: 9,
      manufacturer: "Legacy Maker",
      manufacturerCanonical: "legacy maker",
      productType: "windows",
      eligibleProductTypes: ["windows"],
      name: "Legacy",
      active: true,
      pages: [],
      sourceSampleId: null,
      createdById: "admin",
      createdByName: "Admin",
      updatedById: "admin",
      updatedByName: "Admin",
      createdAt: now,
      updatedAt: now,
    },
    null,
  );
  assert.equal(template.sourceAvailable, false);
  assert.equal(template.source, null);
});