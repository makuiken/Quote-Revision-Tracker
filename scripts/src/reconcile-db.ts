import { ensureSchema, pool } from "@workspace/db";

try {
  await ensureSchema();
  console.log("Development database schema reconciled.");
} finally {
  await pool.end();
}