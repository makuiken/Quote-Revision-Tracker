---
name: Field-options dependency model
description: How dependent (parent-scoped) dropdown option lists are keyed and why empty strings are used instead of NULLs
---
**Rule:** Parent-scoped option lists live in the same `field_options` table with `parent_field`/`parent_value` columns that default to `''` (not NULL) for flat lists; uniqueness is `(category, field, parent_value)`.

**Why:** Postgres treats NULLs as distinct in unique constraints and drizzle's `onConflictDoUpdate` can't target expression indexes, so `''` sentinels keep upserts simple and one constraint covers flat + scoped rows.

**How to apply:** A field has at most one parent; saving a scoped list under a new parentField deletes lists scoped to the old parent (server-side, in a transaction). Quote forms: parent selected → only that parent's list; parent empty → union across parents; a dependency supersedes the field's flat list. Renaming a parent option in its flat list does NOT rename `parent_value` keys of scoped lists (known gap).
