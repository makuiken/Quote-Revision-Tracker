import { Router, type IRouter } from "express";
import { pool, assertSchemaCompatible, SCHEMA_RELEASE_ID } from "@workspace/db";
import {
  HealthCheckResponse,
  ReadinessCheckResponse,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { recordOperationalFailure } from "../lib/operationalSignals";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const CACHE_MS = 5_000;
let cached:
  | { expiresAt: number; response: ReturnType<typeof ReadinessCheckResponse.parse> }
  | undefined;
let readinessInFlight:
  | Promise<ReturnType<typeof ReadinessCheckResponse.parse>>
  | undefined;

async function checkDatabaseReady(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
    await client.query("SELECT 1");
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function runReadinessCheck() {
  const [database, schema, objectStorage] = await Promise.allSettled([
    checkDatabaseReady(),
    assertSchemaCompatible(5_000),
    storage.checkReady(),
  ]);
  if (objectStorage.status === "rejected") recordOperationalFailure("storage");
  return ReadinessCheckResponse.parse({
    status:
      database.status === "fulfilled" &&
      schema.status === "fulfilled" &&
      objectStorage.status === "fulfilled"
        ? "ready"
        : "not_ready",
    schemaRelease: SCHEMA_RELEASE_ID,
    checks: {
      api: "ok",
      database: database.status === "fulfilled" ? "ok" : "unavailable",
      schema: schema.status === "fulfilled" ? "ok" : "incompatible",
      objectStorage: objectStorage.status === "fulfilled" ? "ok" : "unavailable",
    },
  });
}

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (req, res) => {
  if (cached && cached.expiresAt > Date.now()) {
    res.status(cached.response.status === "ready" ? 200 : 503).json(cached.response);
    return;
  }

  readinessInFlight ??= runReadinessCheck().finally(() => {
    readinessInFlight = undefined;
  });
  const response = await readinessInFlight;
  cached = { expiresAt: Date.now() + CACHE_MS, response };
  if (response.status !== "ready") {
    req.log.warn(
      {
        signal: "readiness_failed",
        checks: response.checks,
        schemaRelease: SCHEMA_RELEASE_ID,
      },
      "Dependency readiness check failed",
    );
  }
  res.status(response.status === "ready" ? 200 : 503).json(response);
});

export default router;
