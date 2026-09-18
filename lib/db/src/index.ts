import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Bound pool so each autoscaled instance uses a predictable share of DB
// connections. At max=5 a 10-instance autoscale fleet stays within 50 total.
export const DB_POOL_MAX = 5;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: DB_POOL_MAX,
  connectionTimeoutMillis: 5_000, // fail fast rather than queue indefinitely
  idleTimeoutMillis: 30_000,      // release idle connections quickly
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export { assertSchemaCompatible, ensureSchema } from "./ensure-schema";
export { SCHEMA_RELEASE_ID } from "./schema-release";
