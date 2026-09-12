import assert from "node:assert/strict";
import test from "node:test";
import {
  manifestBudgetAllows,
  MAX_SIGNOFF_PACKET_SOURCE_BYTES,
} from "./documentBudget";

test("manifest preflight rejects oversize assembly before mutations", () => {
  assert.equal(manifestBudgetAllows(500, [MAX_SIGNOFF_PACKET_SOURCE_BYTES]), true);
  assert.equal(manifestBudgetAllows(501, [1]), false);
  assert.equal(manifestBudgetAllows(1, [MAX_SIGNOFF_PACKET_SOURCE_BYTES + 1]), false);
});