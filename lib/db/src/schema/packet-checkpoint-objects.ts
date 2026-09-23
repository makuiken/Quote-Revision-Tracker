import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A write-ahead registry, not an upload table. Rows survive packet deletion and
 * successful object deletion: a fenced-out writer can still finish an upload
 * after the first cleanup pass, so the exact path must remain retryable.
 */
export const packetCheckpointObjectsTable = pgTable("packet_checkpoint_objects", {
  objectPath: text("object_path").primaryKey(),
  packetId: integer("packet_id").notNull(),
  attemptToken: text("attempt_token"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("packet_checkpoint_objects_due_idx").on(table.nextCheckAt, table.objectPath),
]);