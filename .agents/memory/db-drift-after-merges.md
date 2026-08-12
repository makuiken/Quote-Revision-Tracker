---
name: DB drift after task merges
description: Merged task-agent work may add drizzle schema code without the columns/tables existing in the dev database.
---
**Rule:** After project-task merges touching `lib/db` schema, verify the dev DB actually has the new columns/tables (`psql "$DATABASE_URL" -c "\d <table>"`) before assuming queries work — drizzle fails with "Failed query" and the real cause (`column ... does not exist`) is hidden in the error `cause`.

**Why:** Post-merge reconciliation did not run a schema push; the app 500'd on quote listing because `share_token` and the whole `attachments` table were missing despite the code being merged.

**How to apply:** `drizzle-kit push` is interactive and fails in non-TTY shells (even with --force when it wants rename prompts); apply safe additive DDL directly via SQL instead, keeping it identical to the drizzle schema.

**Also:** every drizzle schema change must be mirrored as an idempotent statement in `lib/db/src/ensure-schema.ts` (startup reconciliation) — code review rejects schema changes that only touch the drizzle schema, since deployed DBs are repaired at startup, not by push.
