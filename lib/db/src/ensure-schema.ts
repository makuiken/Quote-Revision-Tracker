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

  // Private per-user drafts of revision notes. One resumable draft per user
  // per quote; drafts never touch signoff state or the document version.
  `CREATE TABLE IF NOT EXISTS revision_drafts (
    id serial PRIMARY KEY,
    quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    author_id text NOT NULL,
    note text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT revision_drafts_quote_author_unique UNIQUE (quote_id, author_id)
  )`,

  // Revision category tags: optional subset of the quote's categories;
  // null/empty means the entry applies to the whole quote.
  `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS categories text[]`,
  `ALTER TABLE revision_drafts ADD COLUMN IF NOT EXISTS categories text[]`,

  // Signer identity: pre-existing signoffs remain readable as "Other", while
  // all new signoffs must send an explicit role through API validation.
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS stakeholder_role text NOT NULL DEFAULT 'Other'`,
  // A signoff records immutable packet/PDF snapshot identifiers. Paths remain
  // private and are never emitted by public token routes.
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS signed_packet_id integer`,
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS signed_packet_sha256 text`,
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS signed_document_object_path text`,
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS signed_document_sha256 text`,

  // Admin-managed dropdown option lists for product spec fields.
  `CREATE TABLE IF NOT EXISTS field_options (
    id serial PRIMARY KEY,
    category text NOT NULL,
    field text NOT NULL,
    "values" text[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT field_options_category_field_unique UNIQUE (category, field)
  )`,

  // Dependent dropdowns: option lists can be scoped to a parent field+value
  // (e.g. Series options per Brand). Flat lists keep '' in both columns, so
  // uniqueness moves from (category, field) to (category, field, parent_value).
  `ALTER TABLE field_options ADD COLUMN IF NOT EXISTS parent_field text NOT NULL DEFAULT ''`,
  `ALTER TABLE field_options ADD COLUMN IF NOT EXISTS parent_value text NOT NULL DEFAULT ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS field_options_category_field_parent_value_unique
    ON field_options (category, field, parent_value)`,
  `ALTER TABLE field_options DROP CONSTRAINT IF EXISTS field_options_category_field_unique`,

  // Two-level dependent dropdowns: a scoped list can additionally be keyed by
  // a second-level ancestor (e.g. Color options per Brand+Series). Flat and
  // one-level rows keep '' sentinels in the grand columns. Uniqueness must
  // include the field columns too — the old (category, field, parent_value)
  // key ambiguously collided lists scoped to different parent fields.
  `ALTER TABLE field_options ADD COLUMN IF NOT EXISTS grand_field text NOT NULL DEFAULT ''`,
  `ALTER TABLE field_options ADD COLUMN IF NOT EXISTS grand_value text NOT NULL DEFAULT ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS field_options_scope_unique
    ON field_options (category, field, parent_field, parent_value, grand_field, grand_value)`,
  `DROP INDEX IF EXISTS field_options_category_field_parent_value_unique`,

  // Manufacturer source packets are durable processing jobs. Object bytes live
  // in App Storage only; these paths and review decisions are metadata.
  `CREATE TABLE IF NOT EXISTS manufacturer_packets (
    id serial PRIMARY KEY,
    quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    manufacturer text,
    detected_manufacturer text,
    original_name text NOT NULL,
    declared_size integer NOT NULL DEFAULT 0,
    upload_object_path text NOT NULL UNIQUE,
    source_object_path text UNIQUE,
    sanitized_pdf_object_path text UNIQUE,
    sanitized_pdf_sha256 text,
    sanitized_page_object_paths jsonb,
    analysis jsonb,
    manual_redactions jsonb,
    status text NOT NULL DEFAULT 'awaiting_upload',
    page_count integer,
    attempt_count integer NOT NULL DEFAULT 0,
    processing_attempt_token text,
    processing_started_at timestamptz,
    failure_message text,
    approved_at timestamptz,
    approved_by_id text,
    approved_by_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS manufacturer_packets_quote_id_idx
    ON manufacturer_packets (quote_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS manufacturer_packets_recovery_idx
    ON manufacturer_packets (status, processing_started_at)
    WHERE status IN ('queued', 'processing')`,
  `ALTER TABLE manufacturer_packets ADD COLUMN IF NOT EXISTS detected_manufacturer text`,
  `ALTER TABLE manufacturer_packets ADD COLUMN IF NOT EXISTS declared_size integer NOT NULL DEFAULT 0`,
  `ALTER TABLE manufacturer_packets ADD COLUMN IF NOT EXISTS processing_attempt_token text`,
  `CREATE TABLE IF NOT EXISTS manufacturer_packet_manifest (
    id serial PRIMARY KEY,
    quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    packet_id integer NOT NULL REFERENCES manufacturer_packets(id) ON DELETE CASCADE,
    page_number integer NOT NULL,
    page_order integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT manufacturer_packet_manifest_order_unique UNIQUE (quote_id, page_order),
    CONSTRAINT manufacturer_packet_manifest_page_unique UNIQUE (quote_id, packet_id, page_number)
  )`,
  `CREATE INDEX IF NOT EXISTS manufacturer_packet_manifest_quote_order_idx
    ON manufacturer_packet_manifest (quote_id, page_order)`,
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
