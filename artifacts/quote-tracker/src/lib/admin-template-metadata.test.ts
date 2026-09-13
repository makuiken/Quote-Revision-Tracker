import assert from "node:assert/strict";
import test from "node:test";
import {
  metadataValuesForDraft,
  metadataValuesForTemplate,
} from "./admin-template-metadata";

test("inactive edit keeps its inactive state through hydration and save initialization", () => {
  const template = {
    name: "Inactive template",
    manufacturer: "Acme",
    productType: "doors",
    eligibleProductTypes: ["doors"],
    active: false,
  };
  const seeded = metadataValuesForTemplate(template);
  const hydrated = metadataValuesForDraft({
    draft: {
      id: 41,
      name: template.name,
      manufacturer: template.manufacturer,
      productType: template.productType,
      eligibleProductTypes: template.eligibleProductTypes,
      active: false,
    },
    selectedTemplate: template,
    persistedDraftId: null,
    persistedMetadata: {
      ...seeded,
      active: true,
    },
  });

  assert.equal(seeded.active, false);
  assert.equal(hydrated.active, false);
  const saveInput = { active: hydrated.active };
  assert.equal(
    saveInput.active,
    false,
    "the values sent by save must retain the inactive edit state",
  );
});
