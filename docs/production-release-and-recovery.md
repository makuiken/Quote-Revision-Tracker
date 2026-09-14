# Production release and recovery

## Release gate

1. Merge and verify changes in development. The post-merge process applies the Drizzle schema to the development database.
2. If the Drizzle schema or required compatibility contract changes, bump `SCHEMA_RELEASE_ID` and append a matching entry and generated contract hash to `ops/schema-releases.json`. The API build fails if the ID or hash disagrees.
3. Publish through Replit. Review the development-to-production schema diff and confirm any detected rename explicitly. Do not use “overwrite data” during a normal release.
4. Replit applies the approved production schema diff within the Publish flow before the new API instance starts receiving traffic.
5. API startup runs the read-only production compatibility contract before opening its port. An incompatible schema exits instead of accepting traffic. The application build itself is static and never mutates production data.
6. Confirm `/api/healthz` returns 200 and `/api/readyz` returns 200 with every dependency marked `ok`. Record the schema release ID with the release.

Never run `drizzle-kit push`, custom DDL, or reconciliation against production from application startup or the deployment build.

## Health and monitoring

- `/api/healthz` is process liveness only. It does not use authentication, rate limiting, the database, or storage.
- `/api/readyz` checks the database connection, complete schema compatibility contract, and private App Storage write/read/delete access. It single-flights checks, caches the result for one minute, and returns 503 when a dependency is unavailable.
- Every response includes `X-Request-Id`. All JSON 5xx responses include that reference; uncaught failures are sanitized centrally. Use the reference to find the structured server log.
- The API emits an `operational_summary` every minute with replica-scoped response/error counts and resources plus explicitly labeled global database backlog gauges. Reports do not overlap. Packet processing, recovery, storage-readiness, and timeout failures have named counters.
- The API enforces an absolute response deadline. Read-only requests receive a referenced 504 when possible; mutation connections are closed rather than falsely claiming rollback. The abort signal is available to handlers, but operations that do not support cancellation may finish after the client disconnects and must retain their existing idempotency and reconciliation rules.
- In Replit Monitoring, watch uptime, 5xx status rate, request duration, CPU, and RAM. Enable proactive downtime email alerts. Investigate repeated readiness failures, any sustained 5xx increase, growing queued/processing packet counts, growing attachment cleanup backlog, or sustained resource saturation.

## Database recovery

Production PostgreSQL is the authoritative store for quotes, revisions, upload lifecycle state, and signed-document references. Replit supports point-in-time database recovery: up to 7 days on Core and up to 28 days on Pro and Enterprise, plus configured daily restore points. Confirm the current plan and retention before launch.

For a restore:

1. Stop writes by taking the deployment out of service.
2. Record the incident time and choose a restore point before the first damaging write.
3. Restore the production database through Replit’s data recovery controls.
4. Roll application code back to a schema-compatible checkpoint; database restore does not roll back code.
5. Start the deployment and require a successful readiness response.
6. Verify counts and spot-check a quote, its revision history, approval coverage, and signed-document metadata. Perform a read-only download/hash check for at least one immutable signed document created before the restore point.
7. Record the restore point, schema release, verification results, and any expected data loss window.

Exercise this procedure quarterly in a non-production recovery environment and after material schema or evidence-lifecycle changes.

## Immutable signed-document recovery

App Storage does not provide automatic backups or self-service recovery for deleted objects. Signed PDFs are therefore immutable evidence and must never be deleted by ordinary quote, packet, cleanup, or rollback flows.

Before production launch, configure an independent backup/export process for signed-document object prefixes. Retain those copies for the organization’s contractual evidence period. A database restore alone is incomplete: its referenced object generation must also exist and match the recorded SHA-256 hash.

Quarterly, restore a sample signed PDF from the independent copy into an isolated recovery location, verify its SHA-256 against the database, and confirm the PDF opens. Do not overwrite a production object during a drill.

## Rollback boundaries

- Roll back application code only when it remains compatible with the current production schema.
- Prefer forward fixes for additive schema changes. Never “roll back” by dropping columns or deleting evidence.
- If a database restore is required, pair it with the matching code checkpoint and verify readiness before reopening traffic.
- Request references and structured logs may contain operational identifiers; logs must not contain credentials, cookies, signatures, or document bytes.