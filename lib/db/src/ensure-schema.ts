import { pool } from "./index";

/**
 * Idempotent schema reconciliation, run at API server startup.
 *
 * Each statement must be safe to run repeatedly (IF NOT EXISTS / no-ops on an
 * up-to-date database). Add a statement here whenever the Drizzle schema gains
 * a column or index, so a database that predates the change is repaired
 * automatically instead of failing at query time.
 */
const RECONCILIATION_STATEMENTS: string[] = [
  // quotes.share_token was added after the initial schema; older databases lack it.
  `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS share_token text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS quotes_share_token_unique ON quotes (share_token)`,
];

export async function ensureSchema(): Promise<void> {
  for (const statement of RECONCILIATION_STATEMENTS) {
    await pool.query(statement);
  }
}
