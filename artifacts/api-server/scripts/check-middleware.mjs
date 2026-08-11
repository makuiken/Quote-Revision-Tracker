#!/usr/bin/env node
/**
 * Integration check for two middleware behaviors:
 *   1. Public signoff PUT rejects payloads > 500 KB with 413
 *   2. Per-IP rate limiter is isolated — different X-Forwarded-For IPs each
 *      get their own quota (proves trust proxy is wired up)
 *
 * Run against the local dev server:
 *   node artifacts/api-server/scripts/check-middleware.mjs
 *
 * Or against a deployed instance:
 *   BASE_URL=https://your-domain.replit.app node artifacts/api-server/scripts/check-middleware.mjs
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const ENDPOINT = `${BASE_URL}/api/public/signoff/nonexistent-token-for-middleware-check`;

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function put(extraKb = 0, ip = null) {
  const payload = JSON.stringify({
    customerName: "Test",
    signatureType: "drawn",
    signatureData: "data:image/png;base64,abc" + "x".repeat(extraKb * 1024),
  });
  const headers = { "Content-Type": "application/json" };
  if (ip) headers["X-Forwarded-For"] = ip;
  const res = await fetch(ENDPOINT, { method: "PUT", headers, body: payload });
  return res.status;
}

// ── Test 1: payload cap ──────────────────────────────────────────────────────
console.log("\n[1] Payload cap (500 KB limit on public signoff PUT)");

const smallStatus = await put(1);             // ~1 KB  → must NOT be 413
const largeStatus = await put(600);           // ~600 KB → must be 413

assert(
  "Small payload reaches handler (404 token-not-found, not 413)",
  smallStatus === 404,
  `got ${smallStatus}`,
);
assert(
  "600 KB payload is rejected before DB with 413",
  largeStatus === 413,
  `got ${largeStatus}`,
);

// ── Test 2: per-IP isolation (trust proxy) ───────────────────────────────────
console.log("\n[2] Per-IP rate limit isolation (trust proxy)");

// Exhaust IP-A's quota (11 requests, well over the 10/min limit)
const ipA = "10.0.0.1";
const ipB = "10.0.0.2";

let ipAGot429 = false;
for (let i = 0; i < 12; i++) {
  const s = await put(0, ipA);
  if (s === 429) { ipAGot429 = true; break; }
}

// IP-B should still be under its own fresh quota
const ipBFirst = await put(0, ipB);

assert(
  "IP-A hits 429 after exceeding its per-minute quota",
  ipAGot429,
  "never got 429 — rate limiter may not be firing",
);
assert(
  "IP-B is unaffected by IP-A's exhausted quota (404, not 429)",
  ipBFirst === 404,
  `got ${ipBFirst}`,
);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
