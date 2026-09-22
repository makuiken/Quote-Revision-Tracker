---
name: Distributed PDF work
description: Cross-replica conventions for bounding packet processing and signoff PDF cache builds.
---
**Rule:** Treat PDF work as distributed whenever the app can autoscale. Bound packet workers with PostgreSQL advisory-lock slots and coordinate duplicate immutable cache builds with database leases.

**Why:** Process-local queues, counters, and promise maps multiply independently on every replica, allowing worker oversubscription and duplicate rendering during cache misses.

**How to apply:** Keep durable rows queued until a global slot is acquired; retry contention with bounded delay rather than tight loops. Leases must expire after crashes, and immutable object writes remain the final duplicate-write guard.

**Rule:** Capacity waiters must not retain database clients, and state-changing PDF jobs outrank optional preview jobs in process-local queues.

**Why:** Advisory-lock waiters can exhaust a small pool without owning a slot, while a burst of page previews can otherwise starve upload analysis and sanitization.

**How to apply:** Check out a client only for one advisory-lock attempt, release it before sleeping, and use stable priority FIFO ordering with packet transitions above previews.

**Rule:** Refresh token-fenced processing leases through worker waits and object persistence, and await every sibling write before failure cleanup begins.

**Why:** Recovery can supersede healthy long jobs when only the initial claim timestamp exists; fail-fast batched writes can finish after cleanup and leave private orphan objects.

**How to apply:** Heartbeat well inside the stale threshold, abort on lease loss, use bounded all-settled write batches, then perform fresh reference checks before deletion.

**Rule:** Never hold quote or approval row locks while downloading sources, rendering PDFs, or uploading objects.

**Why:** Expensive I/O under row locks serializes unrelated users and raises deadlock/timeout risk. Rendering outside the transaction is safe only if finalization re-locks quote first and revalidates the exact snapshot/version before recording evidence.

**How to apply:** Prepare and fingerprint under a short transaction, render outside it, then finalize under the same lock order. Delete a newly uploaded object only after fresh reference checks prove it is not signed or otherwise referenced.

**Rule:** Keep the HTML PDF browser sandbox enabled and its network disabled.

**Why:** Customer-controlled document and signature content reaches the renderer. Blocking network traffic alone does not isolate it from server files and credentials. Sandboxed system Chromium was verified in this environment.

**How to apply:** Treat sandbox launch failures as explicit failures, never silently add `--no-sandbox`. Keep rendering deadlines inclusive of queue acquisition and cleanup.

**Rule:** Treat private page API URLs as mutable aliases even when their backing storage objects are immutable.

**Why:** A regenerated redaction can point the same API URL at new bytes; React Query invalidation alone cannot defeat an HTTP cache serving the old sensitive image.

**How to apply:** Prevent HTTP caching on mutable private aliases and isolate client cache entries by render revision. Validate a changed redaction over nonblank content, since blank-area redactions can legitimately produce identical bytes.

**Rule:** Preview admission must release on settled cache hits as well as completed network requests.

**Why:** Fast or deduplicated queries can finish before an effect observes a fetching state; requiring that intermediate observation can permanently exhaust preview slots.

**How to apply:** Test cached, uncached, aborted, and regenerated previews separately, and retain the slot only while the admitted query is fetching.

**Rule:** Do not equate durable checkpoints with autonomous execution on Autoscale.

**Why:** A database row cannot wake a stopped instance. The user declined an external scheduled trigger on 2026-09-22; an independent execution service was not authorized.

**How to apply:** Describe recovery as conditional on a running instance and lease expiry. Do not claim no-traffic eventual completion, or silently configure a scheduler or change the deployment type.