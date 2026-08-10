---
name: DB drift after task merges
description: Merged task-agent work may add drizzle schema code without the columns/tables existing in the dev database.
---
**Rule:** After project-task merges touching `lib/db` schema, verify the dev DB actually has the new columns/tables (`psql "$DATABASE_URL" -c "\d <table>"`) before assuming queries work — drizzle fails with "Failed query" and the real cause (`column ... does not exist`) is hidden in the error `cause`.

**Why:** Post-merge reconciliation did not run a schema push; the app 500'd on quote listing because `share_token` and the whole `attachments` table were missing despite the code being merged.

**How to apply:** `drizzle-kit push` is interactive and fails in non-TTY shells (even with --force when it wants rename prompts); apply safe additive DDL directly via SQL instead, keeping it identical to the drizzle schema.
