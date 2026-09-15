import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  integer,
  boolean,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type WindowSpec = {
  brand?: string | null;
  series?: string | null;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  jambDepth?: string | null;
  dividedLites?: string | null;
  hardwareFinish?: string | null;
  screenColor?: string | null;
};

export type DoorSpec = {
  brand?: string | null;
  seriesStyle?: string | null;
  materialSpecies?: string | null;
  exteriorColor?: string | null;
  interiorFinish?: string | null;
  jambDepth?: string | null;
  hardwareFinish?: string | null;
  glassLiteOptions?: string | null;
  /** Exterior doors only. */
  lockPrep?: string | null;
};

export type QuoteSpecs = {
  window?: WindowSpec | null;
  /** Legacy single-door specs (quotes created before the interior/exterior split). */
  door?: DoorSpec | null;
  interiorDoor?: DoorSpec | null;
  exteriorDoor?: DoorSpec | null;
  trimDescription?: string | null;
  millworkDescription?: string | null;
};

export type PacketRedaction = {
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
};

export type PacketPageAnalysis = {
  pageNumber: number;
  width: number;
  height: number;
  pageType: string;
  suggestedRects: PacketRedaction[];
};

export type ManufacturerRedactionTemplatePage = {
  pageNumber: number;
  width: number;
  height: number;
  rects: PacketRedaction[];
};

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email"),
  role: text("role").$type<"admin" | "member">().notNull().default("member"),
  status: text("status")
    .$type<"pending" | "approved">()
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  quoteNumber: text("quote_number").notNull(),
  customerName: text("customer_name").notNull(),
  projectName: text("project_name").notNull().default(""),
  jobAddress: text("job_address").notNull().default(""),
  categories: text("categories").array().notNull(),
  specs: jsonb("specs").$type<QuoteSpecs>().notNull().default({}),
  notes: text("notes"),
  shareToken: text("share_token").unique(),
  // Mutable access-control metadata for the legacy public link. The signed
  // quote/evidence is never changed when a link is rotated or revoked.
  shareTokenCreatedAt: timestamp("share_token_created_at", { withTimezone: true }),
  shareTokenExpiresAt: timestamp("share_token_expires_at", { withTimezone: true }),
  shareTokenRevokedAt: timestamp("share_token_revoked_at", { withTimezone: true }),
  shareTokenRevokedById: text("share_token_revoked_by_id"),
  shareTokenRevocationReason: text("share_token_revocation_reason"),
  shareTokenRotatedFrom: text("share_token_rotated_from"),
  createdById: text("created_by_id").notNull(),
  createdByName: text("created_by_name").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveReason: text("archive_reason"),
  archivedById: text("archived_by_id"),
  archivedByName: text("archived_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const revisionsTable = pgTable("revisions", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  note: text("note").notNull(),
  // Optional category tags (subset of the quote's categories). Null/empty
  // means "general/all" — the revision applies to the whole quote.
  categories: text("categories").array(),
  // Hides the entry on the signoff document only; the revision log itself is immutable.
  excludedFromSignoff: boolean("excluded_from_signoff").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Private, per-user draft of a revision note. Drafts live entirely outside the
// published revisions flow: they never appear in the revision log, signoff
// document, public share view, print log, or the document version hash.
export const revisionDraftsTable = pgTable(
  "revision_drafts",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull(),
    note: text("note").notNull(),
    // Optional category tags saved with the draft (subset of the quote's categories).
    categories: text("categories").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One resumable draft per user per quote.
    unique("revision_drafts_quote_author_unique").on(
      table.quoteId,
      table.authorId,
    ),
  ],
);

export const signoffsTable = pgTable("signoffs", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .unique()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  customerName: text("customer_name").notNull(),
  stakeholderRole: text("stakeholder_role")
    .$type<"Homeowner" | "Contractor" | "Architect/Designer" | "Other">()
    .notNull()
    .default("Other"),
  signatureType: text("signature_type").notNull(),
  signatureData: text("signature_data").notNull(),
  // Snapshot binding: an approval is evidence for this exact current packet
  // and this server-produced combined PDF, not merely the mutable quote row.
  signedPacketId: integer("signed_packet_id").references(
    () => manufacturerPacketsTable.id,
    { onDelete: "set null" },
  ),
  signedPacketSha256: text("signed_packet_sha256"),
  signedDocumentObjectPath: text("signed_document_object_path"),
  signedDocumentSha256: text("signed_document_sha256"),
  // Legacy whole-quote records remain immutable evidence. This state answers
  // only whether the record is current for legacy whole-quote status; it never
  // invents per-product-type coverage.
  legacyStatus: text("legacy_status")
    .$type<"signed" | "needs_resigning">()
    .notNull()
    .default("signed"),
  legacyInvalidatedAt: timestamp("legacy_invalidated_at", { withTimezone: true }),
  legacyInvalidationReason: text("legacy_invalidation_reason"),
  signedAt: timestamp("signed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const attachmentUploadsTable = pgTable(
  "attachment_uploads",
  {
    id: text("id").primaryKey(),
    quoteId: integer("quote_id").references(() => quotesTable.id, {
      onDelete: "set null",
    }),
    objectPath: text("object_path").notNull().unique(),
    finalObjectPath: text("final_object_path").notNull().unique(),
    originalName: text("original_name").notNull(),
    declaredSize: integer("declared_size").notNull(),
    declaredContentType: text("declared_content_type").notNull(),
    createdById: text("created_by_id").notNull(),
    status: text("status")
      .$type<"pending" | "source_cleanup_pending" | "attached" | "delete_pending">()
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("attachment_uploads_cleanup_idx").on(table.status, table.expiresAt),
  ],
);

export const attachmentsTable = pgTable("attachments", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  objectPath: text("object_path").notNull(),
  uploadSessionId: text("upload_session_id")
    .unique()
    .references(() => attachmentUploadsTable.id, { onDelete: "restrict" }),
  contentType: text("content_type"),
  size: integer("size"),
  uploadedById: text("uploaded_by_id").notNull(),
  uploadedByName: text("uploaded_by_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Packet bytes are intentionally stored only in App Storage. This table is the
// durable job/audit record and holds opaque object paths plus review metadata.
export const manufacturerPacketsTable = pgTable("manufacturer_packets", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  manufacturer: text("manufacturer"),
  // Null is intentionally reserved for records uploaded before Task 29. New
  // uploads must be classified by the API; old rows are never guessed.
  productType: text("product_type"),
  detectedManufacturer: text("detected_manufacturer"),
  originalName: text("original_name").notNull(),
  declaredSize: integer("declared_size").notNull(),
  uploadObjectPath: text("upload_object_path").notNull().unique(),
  sourceObjectPath: text("source_object_path").unique(),
  sanitizedPdfObjectPath: text("sanitized_pdf_object_path").unique(),
  sanitizedPdfSha256: text("sanitized_pdf_sha256"),
  sanitizedPageObjectPaths: jsonb("sanitized_page_object_paths")
    .$type<string[] | null>(),
  analysis: jsonb("analysis").$type<PacketPageAnalysis[] | null>(),
  manualRedactions: jsonb("manual_redactions")
    .$type<Record<string, PacketRedaction[]> | null>(),
  appliedRedactionTemplateId: integer("applied_redaction_template_id"),
  appliedRedactionTemplateName: text("applied_redaction_template_name"),
  status: text("status")
    .$type<
      | "awaiting_upload"
      | "queued"
      | "processing"
      | "needs_review"
      | "ready_for_approval"
      | "approved"
      | "failed"
    >()
    .notNull()
    .default("awaiting_upload"),
  pageCount: integer("page_count"),
  attemptCount: integer("attempt_count").notNull().default(0),
  processingAttemptToken: text("processing_attempt_token"),
  processingStartedAt: timestamp("processing_started_at", {
    withTimezone: true,
  }),
  failureMessage: text("failure_message"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedById: text("approved_by_id"),
  approvedByName: text("approved_by_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Reusable, administrator-approved redaction geometry for a manufacturer's
// packet/product type. Pages are snapshots of analyzed page dimensions so a
// template can only be applied to matching pages.
export const manufacturerRedactionTemplatesTable = pgTable(
  "manufacturer_redaction_templates",
  {
    id: serial("id").primaryKey(),
    manufacturer: text("manufacturer").notNull(),
    manufacturerCanonical: text("manufacturer_canonical").notNull(),
    productType: text("product_type").notNull(),
    // Primary productType remains for legacy packet/template compatibility.
    // New templates may be eligible for several quote categories.
    eligibleProductTypes: text("eligible_product_types").array().notNull().default([]),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    pages: jsonb("pages").$type<ManufacturerRedactionTemplatePage[]>().notNull(),
    // A template's source is an immutable sample artifact. Existing templates
    // may have no sourceSampleId because source retention was not available
    // when they were created.
    sourceSampleId: integer("source_sample_id"),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    updatedById: text("updated_by_id").notNull(),
    updatedByName: text("updated_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("manufacturer_redaction_templates_key_unique").on(
      table.manufacturerCanonical,
      table.productType,
    ),
  ],
);

// Immutable private source artifacts for standalone template authoring. A
// replacement creates a new row and never overwrites the prior PDF; deleting
// the current template leaves the artifact row available for historical
// recovery/audit rather than cascading into object storage.
export const manufacturerTemplateSamplesTable = pgTable(
  "manufacturer_template_samples",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id").references(
      () => manufacturerRedactionTemplatesTable.id,
      { onDelete: "set null" },
    ),
    objectPath: text("object_path").notNull().unique(),
    originalName: text("original_name").notNull(),
    declaredSize: integer("declared_size").notNull(),
    sha256: text("sha256").notNull(),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

// A draft has no quote/customer parent. It is a bounded, admin-only workflow
// record and can be cancelled without mutating a saved template.
export const manufacturerTemplateDraftsTable = pgTable("manufacturer_template_drafts", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").references(
    () => manufacturerRedactionTemplatesTable.id,
    { onDelete: "set null" },
  ),
  // Immutable identity for edit/replacement drafts. Unlike templateId, this
  // is intentionally not a foreign key: deleting the saved template must not
  // turn an edit into a new-template draft.
  originalTemplateId: integer("original_template_id"),
  sourceSampleId: integer("source_sample_id").references(
    () => manufacturerTemplateSamplesTable.id,
    { onDelete: "set null" },
  ),
  uploadObjectPath: text("upload_object_path").unique(),
  originalName: text("original_name"),
  declaredSize: integer("declared_size"),
  sourceSha256: text("source_sha256"),
  sourceGeneration: text("source_generation"),
  // Snapshot of the saved template revision when an edit/replacement draft
  // was opened. Null is retained for legacy drafts and must be reopened.
  baseTemplateUpdatedAt: timestamp("base_template_updated_at", { withTimezone: true }),
  manufacturer: text("manufacturer"),
  manufacturerCanonical: text("manufacturer_canonical"),
  productType: text("product_type"),
  eligibleProductTypes: text("eligible_product_types").array().notNull().default([]),
  name: text("name"),
  active: boolean("active").notNull().default(true),
  analysis: jsonb("analysis").$type<PacketPageAnalysis[] | null>(),
  manualRedactions: jsonb("manual_redactions")
    .$type<Record<string, PacketRedaction[]> | null>(),
  status: text("status")
    .$type<"awaiting_upload" | "analyzing" | "ready" | "saving" | "failed" | "cancelled">()
    .notNull()
    .default("awaiting_upload"),
  attemptCount: integer("attempt_count").notNull().default(0),
  processingAttemptToken: text("processing_attempt_token"),
  processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  failureMessage: text("failure_message"),
  revision: integer("revision").notNull().default(0),
  createdById: text("created_by_id").notNull(),
  createdByName: text("created_by_name").notNull(),
  updatedById: text("updated_by_id").notNull(),
  updatedByName: text("updated_by_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// An issued scoped link locks the exact content the customer is asked to
// review. Requests are append-only: expired/stale requests are retained as
// audit evidence and a later request never mutates their scope.
export const scopedApprovalRequestsTable = pgTable("scoped_approval_requests", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  productTypes: text("product_types").array().notNull(),
  snapshot: jsonb("snapshot").notNull(),
  documentVersion: text("document_version").notNull(),
  status: text("status").$type<"open" | "signed" | "stale" | "revoked">().notNull().default("open"),
  createdById: text("created_by_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedById: text("revoked_by_id"),
  revocationReason: text("revocation_reason"),
  replacedFromRequestId: integer("replaced_from_request_id"),
  replacementRequestId: integer("replacement_request_id"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
});

// Immutable customer approval evidence. No scoped sign route updates this row;
// replacement approvals create another row and coverage selects the current
// one per product type.
export const scopedApprovalsTable = pgTable("scoped_approvals", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id")
    .notNull()
    .unique()
    .references(() => scopedApprovalRequestsTable.id, { onDelete: "restrict" }),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  productTypes: text("product_types").array().notNull(),
  snapshot: jsonb("snapshot").notNull(),
  documentVersion: text("document_version").notNull(),
  customerName: text("customer_name").notNull(),
  stakeholderRole: text("stakeholder_role").notNull(),
  signatureType: text("signature_type").notNull(),
  signatureData: text("signature_data").notNull(),
  signedDocumentObjectPath: text("signed_document_object_path").notNull().unique(),
  signedDocumentSha256: text("signed_document_sha256").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Mutable coverage is deliberately separate from immutable approval evidence.
// An invalidation only changes types affected by the mutation.
export const scopedApprovalCoverageTable = pgTable(
  "scoped_approval_coverage",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "cascade" }),
    productType: text("product_type").notNull(),
    approvalId: integer("approval_id").references(() => scopedApprovalsTable.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<"open" | "signed" | "needs_resigning">().notNull().default("open"),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("scoped_approval_coverage_quote_type_unique").on(table.quoteId, table.productType)],
);

// Append-only audit trail for legacy link lifecycle operations. Scoped request
// rows carry their own replacement chain; this table preserves legacy tokens
// after rotation, where the current quote row must contain only the newest
// usable token.
export const shareLinkAuditTable = pgTable("share_link_audit", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  action: text("action").$type<"created" | "revoked" | "rotated" | "expired">().notNull(),
  replacementToken: text("replacement_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  actorId: text("actor_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Database-backed claim/lease for unsigned signoff document builds. The
// document itself remains an immutable object; this table only coordinates
// cache misses across API replicas.
export const unsignedDocumentBuildsTable = pgTable(
  "unsigned_document_builds",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "cascade" }),
    documentVersion: text("document_version").notNull(),
    objectPath: text("object_path").notNull(),
    claimToken: text("claim_token").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("unsigned_document_builds_quote_version_unique").on(
      table.quoteId,
      table.documentVersion,
    ),
    index("unsigned_document_builds_lease_idx").on(table.leaseUntil),
  ],
);

// The current customer-visible packet order. It is intentionally a single
// mutable manifest, not a historical approval log; signed snapshots keep their
// own immutable combined PDF bytes in App Storage.
export const manufacturerPacketManifestTable = pgTable(
  "manufacturer_packet_manifest",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "cascade" }),
    packetId: integer("packet_id")
      .notNull()
      .references(() => manufacturerPacketsTable.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    pageOrder: integer("page_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("manufacturer_packet_manifest_order_unique").on(
      table.quoteId,
      table.pageOrder,
    ),
    unique("manufacturer_packet_manifest_page_unique").on(
      table.quoteId,
      table.packetId,
      table.pageNumber,
    ),
  ],
);

// Admin-managed dropdown option lists for product spec fields, keyed by spec
// section (window/interiorDoor/exteriorDoor) + field name. A field with a row
// here renders as a combobox in quote forms; fields without stay free text.
//
// Dependent (parent-scoped) lists: a row with parentField/parentValue set
// holds the options offered for `field` when the sibling `parentField` in the
// same category currently equals `parentValue` (e.g. series options scoped to
// brand "Andersen"). Flat lists use empty strings for both columns, so the
// (category, field, parent_value) uniqueness works without NULL special cases.
export const fieldOptionsTable = pgTable(
  "field_options",
  {
    id: serial("id").primaryKey(),
    category: text("category").notNull(),
    field: text("field").notNull(),
    // '' = flat list; otherwise the sibling field this list is scoped by.
    parentField: text("parent_field").notNull().default(""),
    // '' = flat list; otherwise the parent field's value this list applies to.
    parentValue: text("parent_value").notNull().default(""),
    // Optional second-level ancestor (e.g. brand for a Color list scoped to
    // Brand+Series). '' = not scoped by a grandparent.
    grandField: text("grand_field").notNull().default(""),
    grandValue: text("grand_value").notNull().default(""),
    values: text("values").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("field_options_scope_unique").on(
      table.category,
      table.field,
      table.parentField,
      table.parentValue,
      table.grandField,
      table.grandValue,
    ),
  ],
);

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
export type Revision = typeof revisionsTable.$inferSelect;
export type RevisionDraft = typeof revisionDraftsTable.$inferSelect;
export type Signoff = typeof signoffsTable.$inferSelect;
export type Attachment = typeof attachmentsTable.$inferSelect;
export type ManufacturerPacket = typeof manufacturerPacketsTable.$inferSelect;
export type ScopedApprovalRequest = typeof scopedApprovalRequestsTable.$inferSelect;
export type ScopedApproval = typeof scopedApprovalsTable.$inferSelect;
export type ScopedApprovalCoverage = typeof scopedApprovalCoverageTable.$inferSelect;
export type ShareLinkAudit = typeof shareLinkAuditTable.$inferSelect;
export type AppUser = typeof usersTable.$inferSelect;
export type FieldOptions = typeof fieldOptionsTable.$inferSelect;
export type ManufacturerRedactionTemplate =
  typeof manufacturerRedactionTemplatesTable.$inferSelect;
export type ManufacturerTemplateSample =
  typeof manufacturerTemplateSamplesTable.$inferSelect;
export type ManufacturerTemplateDraft =
  typeof manufacturerTemplateDraftsTable.$inferSelect;
