import { pool } from "./index";

/**
 * Idempotent schema reconciliation, run at API server startup.
 *
 * Each statement must be safe to run repeatedly (IF NOT EXISTS / no-ops on an
 * up-to-date database). Add a statement here whenever the Drizzle schema gains
 * a column or index, so a database that predates the change is repaired
 * automatically instead of failing at query time.
 *
 * A Postgres advisory lock ensures that simultaneous cold-starts (autoscale)
 * don't race on DDL — only one instance runs reconciliation at a time; the
 * others wait and then see a no-op database.
 */
const ADVISORY_LOCK_KEY = 7_472_657_361; // stable arbitrary key for this app

const RECONCILIATION_STATEMENTS: string[] = [
  // quotes.share_token was added after the initial schema; older databases lack it.
  `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS share_token text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS quotes_share_token_unique ON quotes (share_token)`,
  // Archive support: quotes can be archived (kept, not deleted) with a reason.
  `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS archived_at timestamptz`,
  `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS archive_reason text`,
  `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS archived_by_id text`,
  `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS archived_by_name text`,

  // ---------- Performance indexes ----------
  // Foreign-key columns: without indexes, FK-constrained deletes and joins do
  // full table scans.
  `CREATE INDEX IF NOT EXISTS revisions_quote_id_idx ON revisions (quote_id)`,
  `CREATE INDEX IF NOT EXISTS attachments_quote_id_idx ON attachments (quote_id)`,
  // Recent-activity query orders by revisions.created_at DESC.
  `CREATE INDEX IF NOT EXISTS revisions_created_at_idx ON revisions (created_at DESC)`,
  // Quote list filtered by archived status (partial index covers active quotes).
  `CREATE INDEX IF NOT EXISTS quotes_archived_at_null_idx ON quotes (created_at DESC) WHERE archived_at IS NULL`,
  // "My quotes" scope filters by created_by_id.
  `CREATE INDEX IF NOT EXISTS quotes_created_by_id_idx ON quotes (created_by_id)`,
  // Default quote list sort.
  `CREATE INDEX IF NOT EXISTS quotes_created_at_idx ON quotes (created_at DESC)`,

  // Per-revision signoff exclusion: hides an entry on the signoff document only.
  `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS excluded_from_signoff boolean NOT NULL DEFAULT false`,
];

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    // Advisory lock: at most one instance runs DDL at a time. The lock is
    // automatically released when the client is returned to the pool.
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      for (const statement of RECONCILIATION_STATEMENTS) {
        await client.query(statement);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
