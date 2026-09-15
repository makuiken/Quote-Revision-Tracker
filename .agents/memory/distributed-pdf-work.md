---
name: Distributed PDF work
description: Cross-replica conventions for bounding packet processing and signoff PDF cache builds.
---
**Rule:** Treat PDF work as distributed whenever the app can autoscale. Bound packet workers with PostgreSQL advisory-lock slots and coordinate duplicate immutable cache builds with database leases.

**Why:** Process-local queues, counters, and promise maps multiply independently on every replica, allowing worker oversubscription and duplicate rendering during cache misses.

**How to apply:** Keep durable rows queued until a global slot is acquired; retry contention with bounded delay rather than tight loops. Leases must expire after crashes, and immutable object writes remain the final duplicate-write guard.

**Rule:** Never hold quote or approval row locks while downloading sources, rendering PDFs, or uploading objects.

**Why:** Expensive I/O under row locks serializes unrelated users and raises deadlock/timeout risk. Rendering outside the transaction is safe only if finalization re-locks quote first and revalidates the exact snapshot/version before recording evidence.

**How to apply:** Prepare and fingerprint under a short transaction, render outside it, then finalize under the same lock order. Delete a newly uploaded object only after fresh reference checks prove it is not signed or otherwise referenced.

**Rule:** Keep the HTML PDF browser sandbox enabled and its network disabled.

**Why:** Customer-controlled document and signature content reaches the renderer. Blocking network traffic alone does not isolate it from server files and credentials. Sandboxed system Chromium was verified in this environment.

**How to apply:** Treat sandbox launch failures as explicit failures, never silently add `--no-sandbox`. Keep rendering deadlines inclusive of queue acquisition and cleanup.