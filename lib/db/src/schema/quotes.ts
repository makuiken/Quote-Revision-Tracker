import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  integer,
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
};

export type QuoteSpecs = {
  window?: WindowSpec | null;
  door?: DoorSpec | null;
  trimDescription?: string | null;
  millworkDescription?: string | null;
};

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  quoteNumber: text("quote_number").notNull(),
  customerName: text("customer_name").notNull(),
  categories: text("categories").array().notNull(),
  specs: jsonb("specs").$type<QuoteSpecs>().notNull().default({}),
  notes: text("notes"),
  shareToken: text("share_token").unique(),
  createdById: text("created_by_id").notNull(),
  createdByName: text("created_by_name").notNull(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
export type Revision = typeof revisionsTable.$inferSelect;
export type Signoff = typeof signoffsTable.$inferSelect;
export type Attachment = typeof attachmentsTable.$inferSelect;
