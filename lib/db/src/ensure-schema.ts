import { pool } from "./index";

/**
 * Idempotent schema reconciliation, run at API server startup in development.
 *
 * Each statement must be safe to run repeatedly (IF NOT EXISTS / no-ops on an
 * up-to-date database). Add a statement here whenever the Drizzle schema gains
 * a column or index, so a database that predates the change is repaired
 * automatically instead of failing at query time.
 *
 * Production deliberately does not call this function: DDL/DML reconciliation
 * belongs in the publish/schema-application step, not an API cold start.
 */
const ADVISORY_LOCK_KEY = 7_472_657_361; // stable arbitrary key for this app
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "30s";

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

  // Quote attachment uploads are server-issued capabilities. Pending and
  // delete-pending rows survive long enough for bounded storage cleanup.
  `CREATE TABLE IF NOT EXISTS attachment_uploads (
    id text PRIMARY KEY,
    quote_id integer REFERENCES quotes(id) ON DELETE SET NULL,
    object_path text NOT NULL UNIQUE,
    final_object_path text,
    original_name text NOT NULL,
    declared_size integer NOT NULL,
    declared_content_type text NOT NULL,
    created_by_id text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS attachment_uploads_cleanup_idx
    ON attachment_uploads (status, expires_at)`,
  `ALTER TABLE attachment_uploads ADD COLUMN IF NOT EXISTS final_object_path text`,
  `UPDATE attachment_uploads
      SET final_object_path = object_path
    WHERE final_object_path IS NULL`,
  `ALTER TABLE attachment_uploads ALTER COLUMN final_object_path SET NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS attachment_uploads_final_object_path_unique
    ON attachment_uploads (final_object_path)`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS upload_session_id text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS attachments_upload_session_id_unique
    ON attachments (upload_session_id)`,
  `DO $$ BEGIN
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_upload_session_id_attachment_uploads_id_fk
      FOREIGN KEY (upload_session_id) REFERENCES attachment_uploads(id) ON DELETE RESTRICT;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,

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
  // Separate current-validity state from immutable legacy evidence. Existing
  // rows begin as current whole-quote legacy approvals; mutations change only
  // this state, never the signature/document fields.
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS legacy_status text NOT NULL DEFAULT 'signed'`,
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS legacy_invalidated_at timestamptz`,
  `ALTER TABLE signoffs ADD COLUMN IF NOT EXISTS legacy_invalidation_reason text`,

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
  // Product type is nullable only for explicitly legacy/unclassified packets.
  // New API writes require it and scoped approval creation rejects unclassified
  // pages rather than silently assigning a category.
  `ALTER TABLE manufacturer_packets ADD COLUMN IF NOT EXISTS product_type text`,
  `ALTER TABLE manufacturer_packets ADD COLUMN IF NOT EXISTS applied_redaction_template_id integer`,
  `ALTER TABLE manufacturer_packets ADD COLUMN IF NOT EXISTS applied_redaction_template_name text`,
  // Administrator-managed snapshots of analyzed packet redactions.
  `CREATE TABLE IF NOT EXISTS manufacturer_redaction_templates (
    id serial PRIMARY KEY,
    manufacturer text NOT NULL,
    manufacturer_canonical text NOT NULL,
    product_type text NOT NULL,
     eligible_product_types text[] NOT NULL DEFAULT '{}',
    name text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    pages jsonb NOT NULL,
    created_by_id text NOT NULL,
    created_by_name text NOT NULL,
    updated_by_id text NOT NULL,
    updated_by_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT manufacturer_redaction_templates_key_unique
      UNIQUE (manufacturer_canonical, product_type)
  )`,
  `ALTER TABLE manufacturer_redaction_templates ADD COLUMN IF NOT EXISTS manufacturer text NOT NULL DEFAULT ''`,
  // Multi-category templates retain product_type as the legacy primary key.
  // Backfill every old row so lookup can safely use category overlap.
  `ALTER TABLE manufacturer_redaction_templates
     ADD COLUMN IF NOT EXISTS eligible_product_types text[]`,
  `UPDATE manufacturer_redaction_templates
     SET eligible_product_types = ARRAY[product_type]
     WHERE eligible_product_types IS NULL OR cardinality(eligible_product_types) = 0`,
  `ALTER TABLE manufacturer_redaction_templates
     ALTER COLUMN eligible_product_types SET DEFAULT '{}'`,
  `ALTER TABLE manufacturer_redaction_templates
     ALTER COLUMN eligible_product_types SET NOT NULL`,
  `CREATE INDEX IF NOT EXISTS manufacturer_redaction_templates_eligible_types_gin_idx
     ON manufacturer_redaction_templates USING gin (eligible_product_types)`,
  // Standalone template authoring keeps source PDFs as immutable artifacts.
  // Existing templates intentionally remain source-less when their original
  // packet sample was never retained.
  `CREATE TABLE IF NOT EXISTS manufacturer_template_samples (
     id serial PRIMARY KEY,
     template_id integer REFERENCES manufacturer_redaction_templates(id) ON DELETE SET NULL,
     object_path text NOT NULL UNIQUE,
     original_name text NOT NULL,
     declared_size integer NOT NULL,
     sha256 text NOT NULL,
     created_by_id text NOT NULL,
     created_by_name text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE manufacturer_redaction_templates
     ADD COLUMN IF NOT EXISTS source_sample_id integer`,
  `CREATE INDEX IF NOT EXISTS manufacturer_redaction_templates_source_sample_idx
     ON manufacturer_redaction_templates (source_sample_id)`,
  `CREATE INDEX IF NOT EXISTS manufacturer_template_samples_template_idx
     ON manufacturer_template_samples (template_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS manufacturer_template_drafts (
     id serial PRIMARY KEY,
     template_id integer REFERENCES manufacturer_redaction_templates(id) ON DELETE SET NULL,
      original_template_id integer,
     source_sample_id integer REFERENCES manufacturer_template_samples(id) ON DELETE SET NULL,
     upload_object_path text UNIQUE,
     original_name text,
     declared_size integer,
     source_sha256 text,
     source_generation text,
     base_template_updated_at timestamptz,
     manufacturer text,
     manufacturer_canonical text,
     product_type text,
      eligible_product_types text[] NOT NULL DEFAULT '{}',
     name text,
     active boolean NOT NULL DEFAULT true,
     analysis jsonb,
     manual_redactions jsonb,
     status text NOT NULL DEFAULT 'awaiting_upload',
     attempt_count integer NOT NULL DEFAULT 0,
     processing_attempt_token text,
     processing_started_at timestamptz,
     failure_message text,
     revision integer NOT NULL DEFAULT 0,
     created_by_id text NOT NULL,
     created_by_name text NOT NULL,
     updated_by_id text NOT NULL,
     updated_by_name text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE manufacturer_template_drafts
     ADD COLUMN IF NOT EXISTS eligible_product_types text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE manufacturer_template_drafts
     ADD COLUMN IF NOT EXISTS base_template_updated_at timestamptz`,
  `ALTER TABLE manufacturer_template_drafts
     ADD COLUMN IF NOT EXISTS original_template_id integer`,
  `UPDATE manufacturer_template_drafts
     SET original_template_id = template_id
     WHERE original_template_id IS NULL AND template_id IS NOT NULL`,
  `UPDATE manufacturer_template_drafts
     SET eligible_product_types = ARRAY[product_type]
     WHERE cardinality(eligible_product_types) = 0 AND product_type IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS manufacturer_template_drafts_status_idx
     ON manufacturer_template_drafts (status, processing_started_at)`,
  `CREATE INDEX IF NOT EXISTS manufacturer_template_drafts_template_idx
     ON manufacturer_template_drafts (template_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS manufacturer_redaction_templates_active_key_idx
    ON manufacturer_redaction_templates (manufacturer_canonical, product_type)
    WHERE active = true`,
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
  // Scoped signoff links and immutable approval snapshots. Keep these additive:
  // existing whole-quote signoffs/links stay valid legacy records.
  `CREATE TABLE IF NOT EXISTS scoped_approval_requests (
    id serial PRIMARY KEY,
    quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    product_types text[] NOT NULL,
    snapshot jsonb NOT NULL,
    document_version text NOT NULL,
    status text NOT NULL DEFAULT 'open',
    created_by_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    signed_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS scoped_approval_requests_quote_created_idx
    ON scoped_approval_requests (quote_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS scoped_approvals (
    id serial PRIMARY KEY,
    request_id integer NOT NULL UNIQUE REFERENCES scoped_approval_requests(id) ON DELETE RESTRICT,
    quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    product_types text[] NOT NULL,
    snapshot jsonb NOT NULL,
    document_version text NOT NULL,
    customer_name text NOT NULL,
    stakeholder_role text NOT NULL,
    signature_type text NOT NULL,
    signature_data text NOT NULL,
    signed_document_object_path text NOT NULL UNIQUE,
    signed_document_sha256 text NOT NULL,
    signed_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS scoped_approvals_quote_signed_idx
    ON scoped_approvals (quote_id, signed_at DESC)`,
  `CREATE TABLE IF NOT EXISTS scoped_approval_coverage (
    id serial PRIMARY KEY,
    quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    product_type text NOT NULL,
    approval_id integer REFERENCES scoped_approvals(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'open',
    invalidated_at timestamptz,
    invalidation_reason text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT scoped_approval_coverage_quote_type_unique UNIQUE (quote_id, product_type)
  )`,
  `CREATE INDEX IF NOT EXISTS scoped_approval_coverage_quote_status_idx
    ON scoped_approval_coverage (quote_id, status)`,
  // Cross-replica coordination for immutable unsigned document cache misses.
  // Leases make crashed builders recoverable without holding a quote lock.
  `CREATE TABLE IF NOT EXISTS unsigned_document_builds (
    id serial PRIMARY KEY,
    quote_id integer NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    document_version text NOT NULL,
    object_path text NOT NULL,
    claim_token text NOT NULL,
    lease_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT unsigned_document_builds_quote_version_unique
      UNIQUE (quote_id, document_version)
  )`,
  `CREATE INDEX IF NOT EXISTS unsigned_document_builds_lease_idx
    ON unsigned_document_builds (lease_until)`,
];

/**
 * The API's production preflight contract. Keep this list deliberately
 * independent from RECONCILIATION_STATEMENTS: checking production must remain
 * read-only, and must not accidentally grow a repair path.
 */
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  users: ["id", "clerk_user_id", "name", "email", "role", "status", "created_at"],
  quotes: [
    "id", "quote_number", "customer_name", "project_name", "job_address",
    "categories", "specs", "notes", "share_token", "created_by_id",
    "created_by_name", "archived_at", "archive_reason", "archived_by_id",
    "archived_by_name", "created_at", "updated_at",
  ],
  revisions: [
    "id", "quote_id", "author_id", "author_name", "note", "categories",
    "excluded_from_signoff", "created_at",
  ],
  revision_drafts: [
    "id", "quote_id", "author_id", "note", "categories", "created_at", "updated_at",
  ],
  signoffs: [
    "id", "quote_id", "customer_name", "stakeholder_role", "signature_type",
    "signature_data", "signed_packet_id", "signed_packet_sha256",
    "signed_document_object_path", "signed_document_sha256", "legacy_status",
    "legacy_invalidated_at", "legacy_invalidation_reason", "signed_at",
  ],
  attachments: [
    "id", "quote_id", "name", "object_path", "content_type", "size",
    "upload_session_id", "uploaded_by_id", "uploaded_by_name", "created_at",
  ],
  attachment_uploads: [
    "id", "quote_id", "object_path", "final_object_path", "original_name", "declared_size",
    "declared_content_type", "created_by_id", "status", "expires_at",
    "created_at", "updated_at",
  ],
  manufacturer_packets: [
    "id", "quote_id", "manufacturer", "product_type", "detected_manufacturer",
    "original_name", "declared_size", "upload_object_path", "source_object_path",
    "sanitized_pdf_object_path", "sanitized_pdf_sha256", "sanitized_page_object_paths",
    "analysis", "manual_redactions", "applied_redaction_template_id",
    "applied_redaction_template_name", "status", "page_count", "attempt_count",
    "processing_attempt_token", "processing_started_at", "failure_message",
    "approved_at", "approved_by_id", "approved_by_name", "created_at", "updated_at",
  ],
  manufacturer_redaction_templates: [
    "id", "manufacturer", "manufacturer_canonical", "product_type",
    "eligible_product_types", "name", "active", "pages", "source_sample_id",
    "created_by_id", "created_by_name", "updated_by_id", "updated_by_name",
    "created_at", "updated_at",
  ],
  manufacturer_template_samples: [
    "id", "template_id", "object_path", "original_name", "declared_size", "sha256",
    "created_by_id", "created_by_name", "created_at",
  ],
  manufacturer_template_drafts: [
    "id", "template_id", "original_template_id", "source_sample_id",
    "upload_object_path", "original_name", "declared_size", "source_sha256",
    "source_generation", "base_template_updated_at", "manufacturer",
    "manufacturer_canonical", "product_type", "eligible_product_types", "name",
    "active", "analysis", "manual_redactions", "status", "attempt_count",
    "processing_attempt_token", "processing_started_at", "failure_message",
    "revision", "created_by_id", "created_by_name", "updated_by_id",
    "updated_by_name", "created_at", "updated_at",
  ],
  scoped_approval_requests: [
    "id", "quote_id", "token", "product_types", "snapshot", "document_version",
    "status", "created_by_id", "created_at", "signed_at",
  ],
  scoped_approvals: [
    "id", "request_id", "quote_id", "product_types", "snapshot", "document_version",
    "customer_name", "stakeholder_role", "signature_type", "signature_data",
    "signed_document_object_path", "signed_document_sha256", "signed_at",
  ],
  scoped_approval_coverage: [
    "id", "quote_id", "product_type", "approval_id", "status", "invalidated_at",
    "invalidation_reason", "updated_at",
  ],
  manufacturer_packet_manifest: [
    "id", "quote_id", "packet_id", "page_number", "page_order", "created_at",
  ],
  field_options: [
    "id", "category", "field", "parent_field", "parent_value", "grand_field",
    "grand_value", "values", "updated_at",
  ],
  unsigned_document_builds: [
    "id", "quote_id", "document_version", "object_path", "claim_token",
    "lease_until", "created_at", "updated_at",
  ],
};

type RequiredIndex = {
  table: string;
  columns: readonly string[];
  unique: boolean;
  /** Set for indexes created by reconciliation, where the name is part of
   * the compatibility contract (for example, a partial index). */
  name?: string;
};

const REQUIRED_INDEXES: readonly RequiredIndex[] = [
  // Primary keys and unique constraints/indexes used to enforce identity and
  // idempotency.
  { table: "users", columns: ["id"], unique: true },
  { table: "quotes", columns: ["id"], unique: true },
  { table: "revisions", columns: ["id"], unique: true },
  { table: "revision_drafts", columns: ["id"], unique: true },
  { table: "signoffs", columns: ["id"], unique: true },
  { table: "attachments", columns: ["id"], unique: true },
  { table: "attachment_uploads", columns: ["id"], unique: true },
  { table: "manufacturer_packets", columns: ["id"], unique: true },
  { table: "manufacturer_redaction_templates", columns: ["id"], unique: true },
  { table: "manufacturer_template_samples", columns: ["id"], unique: true },
  { table: "manufacturer_template_drafts", columns: ["id"], unique: true },
  { table: "scoped_approval_requests", columns: ["id"], unique: true },
  { table: "scoped_approvals", columns: ["id"], unique: true },
  { table: "scoped_approval_coverage", columns: ["id"], unique: true },
  { table: "manufacturer_packet_manifest", columns: ["id"], unique: true },
  { table: "field_options", columns: ["id"], unique: true },
  { table: "unsigned_document_builds", columns: ["id"], unique: true },
  { table: "users", columns: ["clerk_user_id"], unique: true },
  { table: "quotes", columns: ["share_token"], unique: true, name: "quotes_share_token_unique" },
  { table: "revision_drafts", columns: ["quote_id", "author_id"], unique: true },
  { table: "signoffs", columns: ["quote_id"], unique: true },
  { table: "attachment_uploads", columns: ["object_path"], unique: true },
  { table: "attachment_uploads", columns: ["final_object_path"], unique: true },
  { table: "attachments", columns: ["upload_session_id"], unique: true },
  { table: "manufacturer_packets", columns: ["upload_object_path"], unique: true },
  { table: "manufacturer_packets", columns: ["source_object_path"], unique: true },
  { table: "manufacturer_packets", columns: ["sanitized_pdf_object_path"], unique: true },
  {
    table: "manufacturer_redaction_templates",
    columns: ["manufacturer_canonical", "product_type"],
    unique: true,
  },
  { table: "manufacturer_template_samples", columns: ["object_path"], unique: true },
  { table: "manufacturer_template_drafts", columns: ["upload_object_path"], unique: true },
  { table: "scoped_approval_requests", columns: ["token"], unique: true },
  { table: "scoped_approvals", columns: ["request_id"], unique: true },
  { table: "scoped_approvals", columns: ["signed_document_object_path"], unique: true },
  {
    table: "scoped_approval_coverage",
    columns: ["quote_id", "product_type"],
    unique: true,
  },
  {
    table: "manufacturer_packet_manifest",
    columns: ["quote_id", "page_order"],
    unique: true,
  },
  {
    table: "manufacturer_packet_manifest",
    columns: ["quote_id", "packet_id", "page_number"],
    unique: true,
  },
  {
    table: "field_options",
    columns: [
      "category", "field", "parent_field", "parent_value", "grand_field", "grand_value",
    ],
    unique: true,
  },
  {
    table: "unsigned_document_builds",
    columns: ["quote_id", "document_version"],
    unique: true,
  },

  // Only correctness-critical indexes belong in the startup compatibility
  // contract. Development reconciliation may add performance indexes, but a
  // missing optimization must not make a correctly declared production
  // schema unavailable.
  {
    table: "unsigned_document_builds",
    columns: ["lease_until"],
    unique: false,
    name: "unsigned_document_builds_lease_idx",
  },
];

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    // DDL and its data backfills are one unit. If a later compatibility repair
    // fails, rollback prevents a half-upgraded development database.
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    // Transaction-scoped advisory locking avoids leaking a session lock if a
    // statement or connection fails. The lock timeout bounds cold-start waits.
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
    for (const statement of RECONCILIATION_STATEMENTS) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

type TableRow = { table_name: string };
type ColumnRow = { table_name: string; column_name: string };
type IndexRow = {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_valid: boolean;
  predicate: string | null;
  definition: string;
  columns: string[] | null;
};
type ColumnContractRow = {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
};
type ForeignKeyRow = {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
  delete_rule: string;
};

const REQUIRED_COLUMN_CONTRACTS: readonly {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
}[] = [
  { table: "quotes", column: "id", type: "int4", nullable: false },
  { table: "quotes", column: "archived_at", type: "timestamptz", nullable: true },
  { table: "manufacturer_packets", column: "quote_id", type: "int4", nullable: false },
  { table: "manufacturer_packets", column: "status", type: "text", nullable: false },
  { table: "manufacturer_packets", column: "attempt_count", type: "int4", nullable: false },
  { table: "manufacturer_packets", column: "processing_attempt_token", type: "text", nullable: true },
  { table: "manufacturer_packets", column: "processing_started_at", type: "timestamptz", nullable: true },
  { table: "manufacturer_packets", column: "sanitized_page_object_paths", type: "jsonb", nullable: true },
  { table: "scoped_approval_requests", column: "snapshot", type: "jsonb", nullable: false },
  { table: "scoped_approval_requests", column: "document_version", type: "text", nullable: false },
  { table: "scoped_approvals", column: "signed_document_object_path", type: "text", nullable: false },
  { table: "scoped_approvals", column: "signed_document_sha256", type: "text", nullable: false },
  { table: "unsigned_document_builds", column: "quote_id", type: "int4", nullable: false },
  { table: "unsigned_document_builds", column: "document_version", type: "text", nullable: false },
  { table: "unsigned_document_builds", column: "object_path", type: "text", nullable: false },
  { table: "unsigned_document_builds", column: "claim_token", type: "text", nullable: false },
  { table: "unsigned_document_builds", column: "lease_until", type: "timestamptz", nullable: false },
  { table: "attachment_uploads", column: "id", type: "text", nullable: false },
  { table: "attachment_uploads", column: "quote_id", type: "int4", nullable: true },
  { table: "attachment_uploads", column: "object_path", type: "text", nullable: false },
  { table: "attachment_uploads", column: "final_object_path", type: "text", nullable: false },
  { table: "attachment_uploads", column: "original_name", type: "text", nullable: false },
  { table: "attachment_uploads", column: "declared_size", type: "int4", nullable: false },
  { table: "attachment_uploads", column: "declared_content_type", type: "text", nullable: false },
  { table: "attachment_uploads", column: "created_by_id", type: "text", nullable: false },
  { table: "attachment_uploads", column: "status", type: "text", nullable: false },
  { table: "attachment_uploads", column: "expires_at", type: "timestamptz", nullable: false },
  { table: "attachment_uploads", column: "created_at", type: "timestamptz", nullable: false },
  { table: "attachment_uploads", column: "updated_at", type: "timestamptz", nullable: false },
  { table: "attachments", column: "upload_session_id", type: "text", nullable: true },
];

const REQUIRED_FOREIGN_KEYS: readonly {
  table: string;
  column: string;
  foreignTable: string;
  foreignColumn: string;
  deleteRule: string;
}[] = [
  {
    table: "attachment_uploads",
    column: "quote_id",
    foreignTable: "quotes",
    foreignColumn: "id",
    deleteRule: "SET NULL",
  },
  {
    table: "attachments",
    column: "upload_session_id",
    foreignTable: "attachment_uploads",
    foreignColumn: "id",
    deleteRule: "RESTRICT",
  },
  {
    table: "manufacturer_packets",
    column: "quote_id",
    foreignTable: "quotes",
    foreignColumn: "id",
    deleteRule: "CASCADE",
  },
  {
    table: "unsigned_document_builds",
    column: "quote_id",
    foreignTable: "quotes",
    foreignColumn: "id",
    deleteRule: "CASCADE",
  },
  {
    table: "scoped_approvals",
    column: "request_id",
    foreignTable: "scoped_approval_requests",
    foreignColumn: "id",
    deleteRule: "RESTRICT",
  },
];

/**
 * Verify the schema that the production API is allowed to use.
 *
 * This function intentionally contains SELECTs only. Production schema
 * changes must be applied before publishing; an API instance must never race
 * other instances while attempting DDL or a data backfill.
 */
export async function assertSchemaCompatible(): Promise<void> {
  const client = await pool.connect();
  const requiredTables = Object.keys(REQUIRED_COLUMNS);
  try {
    const tables = await client.query<TableRow>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name = ANY($1::text[])`,
      [requiredTables],
    );
    const actualTables = new Set(tables.rows.map((row) => row.table_name));
    const missingTables = requiredTables.filter((table) => !actualTables.has(table));

    const columns = await client.query<ColumnRow>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [requiredTables],
    );
    const actualColumns = new Set(
      columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    const missingColumns = requiredTables
      .filter((table) => actualTables.has(table))
      .flatMap((table) =>
        REQUIRED_COLUMNS[table]
          .filter((column) => !actualColumns.has(`${table}.${column}`))
          .map((column) => `${table}.${column}`),
      );

    // pg_index is used instead of index names alone so a renamed equivalent
    // unique constraint remains valid. Named reconciliation indexes still
    // require their name because their partial/opclass behavior is important.
    const indexes = await client.query<IndexRow>(
      `SELECT table_class.relname AS table_name,
              index_class.relname AS index_name,
              index_info.indisunique AS is_unique,
              index_info.indisvalid AS is_valid,
              pg_get_expr(index_info.indpred, index_info.indrelid) AS predicate,
              pg_get_indexdef(index_info.indexrelid) AS definition,
              array_agg(attribute.attname::text ORDER BY index_columns.ordinality)
                FILTER (WHERE attribute.attname IS NOT NULL) AS columns
         FROM pg_index AS index_info
         JOIN pg_class AS table_class
           ON table_class.oid = index_info.indrelid
         JOIN pg_namespace AS table_namespace
           ON table_namespace.oid = table_class.relnamespace
         JOIN pg_class AS index_class
           ON index_class.oid = index_info.indexrelid
         LEFT JOIN LATERAL unnest(index_info.indkey) WITH ORDINALITY
           AS index_columns(attnum, ordinality) ON true
         LEFT JOIN pg_attribute AS attribute
           ON attribute.attrelid = table_class.oid
          AND attribute.attnum = index_columns.attnum
        WHERE table_namespace.nspname = 'public'
          AND table_class.relname = ANY($1::text[])
        GROUP BY table_class.relname, index_class.relname, index_info.indisunique,
                 index_info.indisvalid, index_info.indpred, index_info.indrelid,
                 index_info.indexrelid`,
      [requiredTables],
    );
    const missingIndexes = REQUIRED_INDEXES.filter((required) => {
      return !indexes.rows.some((actual) => {
        const columnsMatch =
          (actual.columns ?? []).join(",") === required.columns.join(",");
        return (
          actual.table_name === required.table &&
          actual.is_unique === required.unique &&
          actual.is_valid &&
          actual.predicate === null &&
          columnsMatch &&
          (!required.name || actual.index_name === required.name)
        );
      });
    }).map((required) => {
      const identity = `${required.table}(${required.columns.join(", ")})`;
      return required.name ? `${required.name} ${identity}` : identity;
    });

    const columnContracts = await client.query<ColumnContractRow>(
      `SELECT table_name, column_name, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            SELECT contract.table_name, contract.column_name
              FROM unnest($1::text[], $2::text[])
                   AS contract(table_name, column_name)
          )`,
      [
        REQUIRED_COLUMN_CONTRACTS.map((contract) => contract.table),
        REQUIRED_COLUMN_CONTRACTS.map((contract) => contract.column),
      ],
    );
    const missingColumnContracts = REQUIRED_COLUMN_CONTRACTS.filter((required) => {
      return !columnContracts.rows.some(
        (actual) =>
          actual.table_name === required.table &&
          actual.column_name === required.column &&
          actual.udt_name === required.type &&
          (actual.is_nullable === "YES") === required.nullable,
      );
    }).map(
      (required) =>
        `${required.table}.${required.column} ${required.type} ${required.nullable ? "NULL" : "NOT NULL"}`,
    );

    const foreignKeys = await client.query<ForeignKeyRow>(
      `SELECT tc.table_name,
              kcu.column_name,
              ccu.table_name AS foreign_table_name,
              ccu.column_name AS foreign_column_name,
              rc.delete_rule
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON kcu.constraint_schema = tc.constraint_schema
          AND kcu.constraint_name = tc.constraint_name
         JOIN information_schema.referential_constraints AS rc
           ON rc.constraint_schema = tc.constraint_schema
          AND rc.constraint_name = tc.constraint_name
         JOIN information_schema.constraint_column_usage AS ccu
           ON ccu.constraint_schema = rc.unique_constraint_schema
          AND ccu.constraint_name = rc.unique_constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    const missingForeignKeys = REQUIRED_FOREIGN_KEYS.filter((required) => {
      return !foreignKeys.rows.some(
        (actual) =>
          actual.table_name === required.table &&
          actual.column_name === required.column &&
          actual.foreign_table_name === required.foreignTable &&
          actual.foreign_column_name === required.foreignColumn &&
          actual.delete_rule === required.deleteRule,
      );
    }).map(
      (required) =>
        `${required.table}.${required.column} -> ${required.foreignTable}.${required.foreignColumn} ON DELETE ${required.deleteRule}`,
    );

    if (
      missingTables.length ||
      missingColumns.length ||
      missingIndexes.length ||
      missingColumnContracts.length ||
      missingForeignKeys.length
    ) {
      const details = [
        missingTables.length ? `tables: ${missingTables.join(", ")}` : "",
        missingColumns.length ? `columns: ${missingColumns.join(", ")}` : "",
        missingIndexes.length ? `indexes: ${missingIndexes.join(", ")}` : "",
        missingColumnContracts.length
          ? `column contracts: ${missingColumnContracts.join(", ")}`
          : "",
        missingForeignKeys.length
          ? `foreign keys: ${missingForeignKeys.join(", ")}`
          : "",
      ].filter(Boolean);
      throw new Error(
        "Production database schema is incompatible with this API. " +
          "Apply the current schema before publishing; startup will not reconcile it. " +
          `Missing ${details.join("; ")}.`,
      );
    }
  } finally {
    client.release();
  }
}
