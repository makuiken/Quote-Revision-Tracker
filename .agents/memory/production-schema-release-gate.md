---
name: Production schema release gate
description: Rules for versioning and verifying production database compatibility without application-driven production DDL.
---

Each schema release ID must include the deterministic hash suffix of the Drizzle schema and read-only compatibility contract. Append release metadata; do not silently reuse an ID after either input changes. Replit Publish remains the only production schema-application path, while API startup performs read-only compatibility verification before listening.

**Why:** A manually synchronized version label can remain unchanged when the real schema contract changes, creating an unauditable release and allowing incompatible code to receive traffic. Running DDL from builds or startup would introduce a separate, unsafe production migration path.

**How to apply:** When schema source or compatibility requirements change, compute the new contract hash, create a new hash-bound release entry, publish through the supported schema-diff flow, and retain fail-closed startup verification.