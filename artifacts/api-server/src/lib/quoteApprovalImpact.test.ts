import assert from "node:assert/strict";
import test from "node:test";
import { quoteApprovalImpact } from "./quoteApprovalImpact";

test("quote no-op and typed spec edits preserve unrelated coverage", () => {
  assert.deepEqual(quoteApprovalImpact({
    beforeCategories: ["windows", "interiorDoors"],
    afterCategories: ["windows", "interiorDoors"],
    changedSpecTypes: [], sharedChanged: false, hasChanges: false,
  }), []);
  assert.deepEqual(quoteApprovalImpact({
    beforeCategories: ["windows", "interiorDoors"],
    afterCategories: ["windows", "interiorDoors"],
    changedSpecTypes: ["windows"], sharedChanged: false, hasChanges: true,
  }), ["windows"]);
});

test("shared or category changes invalidate affected quote scope", () => {
  assert.deepEqual(quoteApprovalImpact({
    beforeCategories: ["windows", "interiorDoors"],
    afterCategories: ["windows", "interiorDoors"],
    changedSpecTypes: [], sharedChanged: true, hasChanges: true,
  }), ["windows", "interiorDoors"]);
  assert.deepEqual(quoteApprovalImpact({
    beforeCategories: ["windows", "interiorDoors"],
    afterCategories: ["windows"],
    changedSpecTypes: [], sharedChanged: false, hasChanges: true,
  }), ["windows", "interiorDoors"]);
});