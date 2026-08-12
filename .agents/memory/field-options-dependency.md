---
name: Field-options dependency model
description: Durable decisions behind dependent (ancestor-scoped) dropdown option lists and their protection semantics
---
**Rule:** Dropdown option lists (flat, one-level, and two-level scoped) share one table using `''` sentinels instead of NULLs for absent ancestor scope, with a single unique constraint over all scope columns. Dependency chains are capped at two levels (e.g. Brand → Series → Color) and each field has exactly one chain.

**Why:** Postgres treats NULLs as distinct in unique constraints, so `''` sentinels let one constraint cover every scope depth. The two-level cap keeps the data model and quote-form filtering tractable.

**How to apply:**
- All chain-affecting mutations must run under the per-category advisory lock and revalidate topology inside the transaction (no >2-level chains, no cycles — full graph walk, ancestors and target must be real category fields). Keep this discipline for any new mutation touching chains.
- Destructive changes are consent-gated: chain replacement needs an explicit `replaceExisting` ack after a 409; removing a dependency or the last list a dependent field chains through is refused until dependents are unlinked; the admin UI confirms every destructive action.
- Scope values match case-insensitively even though the constraint is case-sensitive — preserve stored casing by updating the matched row rather than upserting.
- Quote-form suggestions: exact ancestor combo wins, unscoped legacy rows are the fallback, missing ancestors union across matching rows, and a dependency supersedes the flat list.
- Renaming a parent option deliberately does NOT cascade into scoped-list keys (user cancelled that feature).
