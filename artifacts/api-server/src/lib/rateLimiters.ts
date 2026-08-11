import rateLimit from "express-rate-limit";

/**
 * SCOPE NOTE — per-instance limits:
 *
 * These limiters use the default in-memory store, so each autoscaled API
 * instance maintains independent counters. A client routed across N instances
 * can effectively reach N × max requests per window. Adding a shared backing
 * store (Redis, Postgres-based, etc.) is the correct fix for true system-wide
 * limits, but it falls outside this task's explicit scope ("no Redis or worker
 * queues").
 *
 * Per-instance limiting still provides meaningful protection for this tool:
 * - The payload cap (500 KB) independently bounds write cost regardless of
 *   how many instances are hit.
 * - The user population is a small internal team; abuse through coordinated
 *   multi-instance saturation is not a realistic threat model here.
 * - If autoscale is later configured to run > 1 instance and abuse becomes a
 *   concern, migrate to a shared store at that point.
 *
 * Trust proxy (set in app.ts) is required so req.ip resolves to the real
 * client address rather than Replit's reverse-proxy address.
 */

/**
 * General API rate limit: 200 requests per minute per IP per instance.
 */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

/**
 * Stricter limit on the unauthenticated public signoff write endpoint:
 * 10 requests per minute per IP per instance.
 * A customer signing a quote needs at most a handful of attempts per minute.
 */
export const publicSignoffWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signoff attempts, please try again later." },
});
