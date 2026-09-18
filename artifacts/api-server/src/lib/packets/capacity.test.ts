import assert from "node:assert/strict";
import test from "node:test";

import { pdfCapacityConfiguration } from "./capacity";

test("defaults reserve three database connections for requests and recovery", () => {
  assert.deepEqual(pdfCapacityConfiguration({}, 5), {
    packetSlots: 1,
    signoffSlots: 1,
    poolMax: 5,
    availableLongLivedConnections: 2,
  });
});

test("unsafe combined renderer configuration is rejected", () => {
  assert.throws(
    () =>
      pdfCapacityConfiguration(
        {
          PACKET_WORKER_GLOBAL_SLOTS: "2",
          SIGNOFF_RENDERER_GLOBAL_SLOTS: "2",
        },
        5,
      ),
    /Unsafe PDF capacity/,
  );
});