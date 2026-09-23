# Bounded PDF document sessions

## Implementation

The sanitizer opens one PDF.js document in one worker and reuses it for sequential page renders. Each finished page is persisted as an immutable checkpoint. The bounded pipeline may render one next page during persistence when memory admission permits, but never publishes it before the previous page. Existing two-page checkpoints remain resumable, since raster policy and source/redaction fingerprints have not changed. See `pdf-pipeline-efficiencies.md` for the newer network-inclusive measurements and limitations.

The worker still uses 160-DPI PNG rasterization, opaque pixel redaction, and fresh image-only PDFs. Worker concurrency and V8 resource limits are unchanged. A command has a hard 90-second deadline, idle time is limited to 90 seconds, and the worker session has a 15-minute lifetime. Progress messages cannot extend a command deadline. Page buffers are released between commands; cumulative output and pixel budgets remain enforced.

On failure the worker terminates immediately, but outstanding checkpoint writes settle before the session releases capacity or failure cleanup begins. Final merge acquires the worker queue only after the session closes. Source/redaction changes invalidate checkpoints; stale processing tokens cannot publish them.

Cold original-page previews now require an idle global packet advisory-lock slot and are rejected with HTTP 429 while mandatory work is queued/processing. Cached previews continue to stream. This avoids optional preview rendering competing with packet work across replicas.

Content-free diagnostics report worker admission/startup, source open, preflight, source page, draw, PNG, embedding, PDF save, checkpoint registration/storage/commit, final merge, and sampled process RSS. Failures identify a source page when known. Queue expiry is distinguished from active rendering timeout; supported PDFs are not told to split/re-upload by default.

## Exact-source local comparison — 2026-09-23

Read-only production access recovered the exact failing 31-page source and saved redaction rectangles. Its SHA-256 and manufacturer matched the stored analysis fingerprint. Source, selections and rendered outputs remain private temporary fixtures, not committed assets.

Three fresh-process runs per mode used CPU affinity to one available CPU, unchanged worker V8 limits (384/64 MiB), and 90-second command deadlines. The baseline was the pre-change two-page-checkpoint implementation; the candidate used the real session adapter with one-page disk checkpoints. Totals include local checkpoint writes and final merge, **not network object storage/database commit latency**.

| Metric | Baseline | Session |
| --- | --- | --- |
| Total seconds, three runs | 30.990 / 31.095 / 30.868 | 26.975 / 22.190 / 23.038 |
| Median total | 30.990 s | 23.038 s |
| Descriptive nearest-rank p95 (n=3, maximum) | 31.095 s | 26.975 s |
| Sampled peak process RSS | 349.1 / 377.4 / 376.4 MiB | 337.9 / 335.6 / 336.9 MiB |
| Pages 15–16 total including local checkpoint writes | 1642 / 1801 / 1688 ms | 927 / 824 / 942 ms |

Median improvement was **25.66%**; descriptive tail improvement was **13.25%**. RSS includes native allocations and workers, not just V8. Twenty-millisecond sampling can miss peaks. Modes were not randomized, OS caches were not flushed, and n=3 is insufficient for a reliable p95 claim.

All 31 PNGs matched byte-for-byte across all six runs. The first baseline and candidate outputs additionally underwent RGBA decoding, final merged-PDF parsing, and independent final-page raster decoding at 160 DPI: page count, dimensions, and pixel hashes matched. PDF file bytes need not match when checkpoint boundaries change.

The old renderer also completed the exact source locally, so the production timeout was **not reproduced**. Actual production CPU/memory configuration and deployed build identity were not available through the exposed read-only deployment API. These results are not proof of production resource parity or resolution of the incident.

## Reproduction and remaining acceptance

The scripts under `scripts/src/task86-private-{benchmark,comparison}.mjs` consume private fixture paths; they must never commit or publish the fixture. See their source for arguments and preparation requirements.

All 89 backend tests passed, including real-worker sessions, pixel equivalence, geometry/rotation, cancellation, deadline handling, checkpoint settlement, and capacity recovery. Root workspace typechecking passed.

The real development database/storage harness also passed on the exact 31-page fixture: interrupted after two durable one-page checkpoints, resumed with identical prefix paths/hashes and no repeated analysis, produced all 31 pages before approval availability, and invalidated the old prefix after redaction changes. Final output had no extractable text. All temporary development rows and 127 created storage objects were removed successfully. The running API and application preview were checked; no production retry was performed.

Before declaring the production incident resolved, obtain explicit authorization for publication and the exact-document production retry, establish configured CPU/RSS limits and deployed build identity, and record full network-inclusive processing under concurrent preview load. Include a larger mixed-document cold/warm sample rather than treating three local runs as production p95 evidence. Do not raise resources, DPI policy, timeouts, or introduce an external scheduler as an implicit workaround.