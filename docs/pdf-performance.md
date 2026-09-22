# PDF performance and Autoscale verification

## Signoff document assembly

Approved manufacturer pages are copied in manifest order into the customer
signoff document. Assembly groups selections by the identity of their immutable
source bytes and calls `pdf-lib`'s `copyPages` once per source. This allows one
object copier to reuse shared fonts and images rather than recreating it for
every selected page. The copied pages are then appended in the original
manifest order, including duplicate pages and interleaved sources.

The existing limits remain the safety boundary: at most 500 selected pages,
100 MiB of unique source byte arrays, and a 60-second combined-document
deadline. This optimization does not alter source PDFs, redaction, page
selection, version hashes, signatures, or stored evidence.

Every direct unsigned, scoped, legacy, or signed build acquires the shared
PostgreSQL advisory capacity slot before Chromium rendering and retains it
through `pdf-lib` page copying, serialization, and hashing. The renderer is
told that its caller owns the slot, so it does not acquire the same capacity
class again on another pooled connection. Standalone renderer calls acquire
the same local-then-global capacity pair, keeping one lock order and avoiding
nested capacity deadlocks. Local admission bounds how many same-instance
waiters can touch the database pool; global waiters release unsuccessful
database checkouts before polling again.

Unsigned documents already use the version-addressed immutable object cache in
`routes/quotes.ts`. Cache misses are coordinated by a database lease and a
small per-instance build cap. This change consumes that cache as-is; it does
not change cache keys, invalidation, or evidence semantics.

## Local engine benchmark

These numbers are from the local engine report only. They are not production or
Autoscale measurements:

- The 160 DPI baseline completed in 13.962 seconds. After the engine changes,
  the 160 DPI cold run completed in 14.029 seconds and the warm run in 13.033
  seconds.
- In the measured 160 DPI run, PNG rendering/encoding took 9.192 seconds and
  PDF encoding took 3.834 seconds.
- The lower-resolution comparisons completed in 8.586 seconds at 120 DPI and
  11.545 seconds at 140 DPI. The implementation retained 160 DPI to preserve
  fine-print and technical-drawing readability.
- Direct image preview generation reduced the measured preview path from 593
  milliseconds to 238 milliseconds.

The cold 160 DPI result is effectively unchanged from the baseline; no overall
cold sanitization speedup is claimed. The warm and direct-preview results are
useful local observations, but require representative production verification
before making capacity or latency claims.

## Autoscale operating assumptions

- Instances are stateless and may start, stop, or receive requests
  independently. Correctness cannot depend on a process-local map or counter.
  The database lease coordinates cache misses across instances; process-local
  build tracking is only an additional same-instance optimization.
- Immutable PDFs live in object storage, not an instance filesystem. A
  successful immutable write may outlive the instance that performed it.
- More than one instance can observe a cache miss. Conditional immutable
  storage writes and the version-derived path must remain the final
  correctness boundary.
- CPU and memory are finite per instance. Keep combined-document concurrency
  bounded; do not raise concurrency, database pool size, resource settings, or
  deadlines without production measurements.
- A 60-second application deadline does not guarantee the hosting request
  deadline is longer. Deployment request timeout, instance memory/CPU,
  concurrency, minimum instances, database pool headroom, and object-storage
  access must be checked in the actual Autoscale configuration.

## Safe post-publish check

Publishing and production migrations are operator actions and are not part of
local verification. After an authorized release:

1. Record the release identifier and current Autoscale resource, concurrency,
   request-timeout, and database-pool settings.
2. Use an authorized, clearly labeled non-customer test quote. Do not use or
   modify customer evidence.
3. Attach approved test packet sources representative of the reported
   26–40-page workload. Include repeated pages and pages interleaved from at
   least two sources.
4. Generate the unsigned document once (cold cache). Verify page count, exact
   order, duplicates, dimensions/content, redaction results, and completion
   within both the application and hosting deadlines.
5. Request the identical document version again (warm cache). Confirm the
   immutable object is reused and no second expensive build occurs.
6. Repeat with only the documented bounded level of concurrent preview and
   signoff activity. Check stage timings, cache/claim events, memory, instance
   restarts, database saturation, and HTTP errors without logging document
   content, signatures, credentials, or signed URLs.
7. Sign only if the quote is disposable and the signature is explicitly
   authorized as test evidence. Verify stored signed bytes and hash once; never
   overwrite or reconstruct the artifact.
8. Remove or archive test records through normal application procedures.
   Never run an ad-hoc production migration or delete immutable evidence.

Local tests establish assembly behavior only. They do not establish production
latency, memory usage, Autoscale lifecycle behavior, or resolution of the exact
reported production failure. Those claims require the post-publish check with
the real deployment settings and, when authorized, a representative failing
file.
