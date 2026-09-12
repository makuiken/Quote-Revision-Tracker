import assert from "node:assert/strict";
import test from "node:test";
import { changedManifestProductTypes } from "./manifestScope";

test("manifest changes invalidate only changed type page sequences", () => {
  const before = [
    { packetId: 1, pageNumber: 1, pageOrder: 1, productType: "windows" },
    { packetId: 2, pageNumber: 1, pageOrder: 2, productType: "interiorDoors" },
  ];
  assert.deepEqual(changedManifestProductTypes(before, [...before]), []);
  assert.deepEqual(
    changedManifestProductTypes(before, [
      { packetId: 1, pageNumber: 2, pageOrder: 1, productType: "windows" },
      before[1]!,
    ]),
    ["windows"],
  );
  // Moving a Doors page around a Windows page changes quote-wide placement,
  // but neither scoped product type's own sequence.
  assert.deepEqual(
    changedManifestProductTypes(before, [
      { ...before[1]!, pageOrder: 1 },
      { ...before[0]!, pageOrder: 2 },
    ]),
    [],
  );
});