import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  integer,
  boolean,
  unique,
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
  signatureType: text("signature_type").notNull(),
  signatureData: text("signature_data").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const attachmentsTable = pgTable("attachments", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  objectPath: text("object_path").notNull(),
  contentType: text("content_type"),
  size: integer("size"),
  uploadedById: text("uploaded_by_id").notNull(),
  uploadedByName: text("uploaded_by_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
export type AppUser = typeof usersTable.$inferSelect;
export type FieldOptions = typeof fieldOptionsTable.$inferSelect;
