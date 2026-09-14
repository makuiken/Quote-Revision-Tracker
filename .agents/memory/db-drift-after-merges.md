---
name: DB drift after task merges
description: Merged task-agent work may add drizzle schema code without the columns/tables existing in the dev database.
---
**Rule:** After project-task merges touching `lib/db` schema, verify the dev DB actually has the new columns/tables (`psql "$DATABASE_URL" -c "\d <table>"`) before assuming queries work — drizzle fails with "Failed query" and the real cause (`column ... does not exist`) is hidden in the error `cause`.

**Why:** Post-merge reconciliation did not run a schema push; the app 500'd on quote listing because `share_token` and the whole `attachments` table were missing despite the code being merged.

**How to apply:** Keep the Drizzle schema and development reconciliation in sync. Development reconciliation may repair local drift, but must be atomic and time-bounded. Production schema changes are applied only by Replit's publish-time schema diff.

**Also:** production startup is read-only and fail-closed. It verifies required tables, columns, constraints, and critical indexes, but never runs DDL, backfills, or repair statements.
