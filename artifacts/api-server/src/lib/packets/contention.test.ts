import assert from "node:assert/strict";
import test from "node:test";

import { MIN_FREE_DB_CONNECTIONS, pdfCapacityConfiguration } from "./capacity";
import {
  refreshProcessingLease,
} from "./recovery";
import { tryAcquirePacketWorkerSlot } from "./packetCapacity";
import { acquireGlobalRendererSlot } from "./signoffDocumentHtml";
import { createBoundedWorkerQueue } from "./workerClient";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("real PDF slot paths preserve pool capacity, priority, and token-fenced leases", async () => {
  const capacity = pdfCapacityConfiguration({}, 5);
  const heldLocks = new Set<number>();
  let checkedOut = 0;
  let peakCheckedOut = 0;
  const fakePool = {
    async connect() {
      checkedOut++;
      peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
      let released = false;
      return {
        async query(_sql: string, values: number[]) {
          const key = values[0]!;
          if (_sql.includes("try_advisory")) {
            const acquired = !heldLocks.has(key);
            if (acquired) heldLocks.add(key);
            return { rows: [{ acquired }] };
          }
          heldLocks.delete(key);
          return { rows: [{}] };
        },
        release() {
          if (!released) checkedOut--;
          released = true;
        },
      };
    },
  };

  const packetSlot = await tryAcquirePacketWorkerSlot(
    fakePool,
    7_472_657_400,
    capacity.packetSlots,
  );
  assert.ok(packetSlot);
  const releaseSignoff = await acquireGlobalRendererSlot(Date.now() + 1_000, {
    connectionPool: fakePool,
    bypassInTests: false,
  });
  assert.equal(peakCheckedOut, 2);
  assert.equal(capacity.poolMax - checkedOut, MIN_FREE_DB_CONNECTIONS);

  const queue = createBoundedWorkerQueue(1);
  const largeAnalysisGate = deferred();
  const order: string[] = [];
  const analysis = queue.run(async () => {
    await largeAnalysisGate.promise;
    order.push("large-analysis");
  }, "high");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const previews = [1, 2].map((page) =>
    queue.run(async () => { order.push(`original-preview-${page}`); }),
  );
  const finalization = queue.run(async () => { order.push("packet-finalization"); }, "high");

  const token = "attempt-token";
  let durableToken = token;
  let refreshedAt = "";
  await refreshProcessingLease(
    async (_quoteId, _packetId, suppliedToken, values) => {
      if (suppliedToken !== durableToken) return false;
      refreshedAt = (values.processingStartedAt as Date).toISOString();
      return true;
    },
    1, 2, token, {
      status: "processing",
      processingStartedAt: new Date(Date.UTC(2026, 8, 18, 12)),
    },
  );
  assert.equal(refreshedAt, "2026-09-18T12:00:00.000Z");
  durableToken = "replacement-token";
  await assert.rejects(
    refreshProcessingLease(async (_q, _p, suppliedToken) => suppliedToken === durableToken, 1, 2, token, {
      status: "processing",
      processingStartedAt: new Date(),
    }),
    /superseded/,
  );

  largeAnalysisGate.resolve();
  await Promise.all([analysis, finalization, ...previews]);
  assert.ok(order.indexOf("packet-finalization") < order.indexOf("original-preview-1"));
  assert.ok(order.indexOf("packet-finalization") < order.indexOf("original-preview-2"));

  await packetSlot.release();
  await releaseSignoff();
  assert.equal(checkedOut, 0);
});