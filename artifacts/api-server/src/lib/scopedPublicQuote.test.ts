import assert from "node:assert/strict";
import test from "node:test";
import { projectScopedPublicQuote } from "./scopedPublicQuote";

test("public scoped quote projection cannot leak legacy token or employee metadata", () => {
  const projected = projectScopedPublicQuote({
    id: 7, quoteNumber: "Q-7", customerName: "Customer", projectName: "Project",
    jobAddress: "Address", categories: ["windows"], specs: { window: { brand: "A" } },
    notes: null, shareToken: "legacy-whole-quote-token", createdById: "employee-id",
  } as never, ["windows"]);
  assert.equal("shareToken" in projected, false);
  assert.equal("createdById" in projected, false);
  assert.deepEqual(projected.categories, ["windows"]);
});