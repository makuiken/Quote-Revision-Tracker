import { monitorEventLoopDelay } from "node:perf_hooks";
import { hostname } from "node:os";
import { pool } from "@workspace/db";
import { logger } from "./logger";

type FailureKind = "packet_processing" | "packet_recovery" | "storage" | "http_timeout";
const failures: Record<FailureKind, number> = {
  packet_processing: 0,
  packet_recovery: 0,
  storage: 0,
  http_timeout: 0,
};
const http = { total: 0, serverErrors: 0, clientErrors: 0, durationMs: 0 };
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
let timer: NodeJS.Timeout | undefined;
let reportInFlight = false;
const replicaId = `${hostname()}:${process.pid}`;

export function recordOperationalFailure(kind: FailureKind): void {
  failures[kind] += 1;
}

export function recordHttpResponse(statusCode: number, durationMs: number): void {
  http.total += 1;
  http.durationMs += durationMs;
  if (statusCode >= 500) http.serverErrors += 1;
  else if (statusCode >= 400) http.clientErrors += 1;
}

async function loadJobSignals(): Promise<Record<string, number>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
    const result = await client.query<{
      failed_packets: string;
      queued_packets: string;
      processing_packets: string;
      pending_attachment_cleanup: string;
    }>(`SELECT
      (SELECT count(*) FROM manufacturer_packets WHERE status = 'failed') AS failed_packets,
      (SELECT count(*) FROM manufacturer_packets WHERE status = 'queued') AS queued_packets,
      (SELECT count(*) FROM manufacturer_packets WHERE status = 'processing') AS processing_packets,
      (SELECT count(*) FROM attachment_uploads WHERE status = 'delete_pending') AS pending_attachment_cleanup`);
    await client.query("COMMIT");
    const row = result.rows[0];
    return row
      ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
      : {};
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function report(): Promise<void> {
  if (reportInFlight) {
    logger.warn({ signal: "operational_summary_skipped", replicaId }, "Previous operational summary is still running");
    return;
  }
  reportInFlight = true;
  try {
  const snapshot = {
    ...http,
    averageDurationMs: http.total ? Math.round(http.durationMs / http.total) : 0,
  };
  http.total = 0;
  http.serverErrors = 0;
  http.clientErrors = 0;
  http.durationMs = 0;
  const failureSnapshot = { ...failures };
  for (const key of Object.keys(failures) as FailureKind[]) failures[key] = 0;

  let jobs: Record<string, number> | undefined;
  try {
    jobs = await loadJobSignals();
  } catch (err) {
    logger.error({ err, signal: "operational_summary" }, "Operational job-state query failed");
  }

  const memory = process.memoryUsage();
  logger.info({
    signal: "operational_summary",
    replicaId,
    scopes: {
      http: "replica_interval",
      failures: "replica_interval",
      jobs: "global_database_gauge",
      resources: "replica",
    },
    http: snapshot,
    failures: failureSnapshot,
    jobs,
    resources: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopDelayMeanMs: Math.round(Number(eventLoop.mean) / 1_000_000),
      eventLoopDelayMaxMs: Math.round(Number(eventLoop.max) / 1_000_000),
    },
  }, "Operational summary");
  eventLoop.reset();
  } finally {
    reportInFlight = false;
  }
}

export function startOperationalReporting(): void {
  if (timer) return;
  eventLoop.enable();
  timer = setInterval(() => void report(), 60_000);
  timer.unref();
}