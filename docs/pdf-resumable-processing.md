# Resumable PDF batch benchmark

## Recovery and release limits

Completed batches and source-validated analysis are saved in the database and
private object storage. On a running API instance, the existing recovery scan
can reclaim an expired processing lease and resume the saved prefix. Manual
retry also preserves valid checkpoints; changing redactions invalidates the
rendered prefix, not compatible source analysis.

**There is no independent wake-up trigger.** An Autoscale instance that has
stopped cannot run its own recovery timer. Recovery requires an instance to
start again (for example, from a subsequent app request), and stale work waits
for the lease expiry before reclamation. On 2026-09-22 the user declined adding
an external scheduled trigger. No scheduler, deployment-type change, production
schema write, or publication was performed for this implementation.

The additive processing-state schema change is included in the publish-managed
schema release contract. Development reconciliation and local tests do not
establish production success: a separately authorized post-publish check is
still required. Existing failed packets may require staff to select Retry.

## Scope

This is a local, constrained benchmark of the packet engine worker. It is not a
production, Autoscale, request-timeout, object-storage, or database integration
measurement. The input was the attached actual 40-page PDF, but its private
filename and document content are intentionally not recorded here.

The harness uses the current `engineWorker.ts`, compiled into a temporary
directory, and starts a fresh worker for each operation with the application's
worker limits:

- one operation at a time;
- 384 MiB V8 old generation;
- 64 MiB V8 young generation;
- 8 MiB V8 stack;
- 90-second hard limit per operation.

These V8 limits do not cap native canvas/PDF allocations or total process RSS.
The whole benchmark process, including all worker threads, was pinned to one
available CPU with `taskset`. This artificial constraint is for repeatability;
it does not describe production resources.

## Method

`artifacts/api-server/scripts/benchmark-pdf-batches.mjs`:

1. Finds an attached PDF with exactly 40 pages without printing attachment
   names.
2. Sanitizes pages sequentially in 2-page batches through the real
   resource-limited worker and writes each PDF plus minimal page-range metadata
   to a mode-0700 temporary directory.
3. Stops the first pass after page 10. A second pass starts from page 1,
   validates the existing artifacts by range and PDF page count, and skips the
   five persisted batches before completing the remaining pages.
4. Merges all 20 batch PDFs, in page-range order, through a separate
   resource-limited worker. It loads the result and verifies that all 40
   requested sequential pages are present.
5. Optionally performs one unbatched 40-page sanitize through the same worker
   and with the same worker limits as a local baseline.

The resume exercise proves only that this harness can reuse validated files on
local disk. It does **not** prove database checkpoint integration, object-store
durability, recovery across Autoscale instances, or production orchestration.
The production path has stronger hash/checkpoint concerns than this deliberately
small harness.

RSS is sampled every 20 ms from the Node process. Node worker threads share that
process, so this includes the harness and active worker thread, including native
allocations visible in process RSS. Sampling can miss a shorter-lived peak.

## Result

Measured on Linux x86-64, Node 24.13.0, with one of four visible Intel Xeon
Platinum 8581C CPUs selected by `taskset`:

| Measurement | 2-page resumable batches | Unbatched baseline |
| --- | ---: | ---: |
| Selected/output pages | 40 / 40 | 40 / 40 |
| Total elapsed | 23.769 s | 14.536 s |
| Peak sampled RSS, harness plus worker threads | 337 MiB | 619 MiB |
| Slowest 2-page batch | 1.526 s | n/a |
| Final disk merge | 0.189 s | n/a |

The interruption occurred after 10 pages at 6.173 seconds. Resume found and
skipped all five persisted 2-page artifacts, then completed the other 15
batches. Twenty batch artifacts were merged; requested order and the exact
40-page output count were verified.

Under this one-CPU local constraint, batching reduced sampled peak RSS by 282
MiB (about 46%) but took 9.233 seconds longer (about 64%) than the single-worker
baseline. This is the expected throughput/memory tradeoff from repeated worker
startup and per-batch source parsing. It is not evidence of production latency
or memory behavior.

## Journey coverage and remaining tests

The development browser journey uploaded an actual 40-page PDF, displayed
persisted progress, completed cleaned previews, and added the packet to the
customer package. It found that the source editor misleadingly allowed edits
after approval, which the API correctly rejected with 409. The frontend now
makes approved packets read-only and explains that they must be removed from
the package before editing. The existing E2E test was updated to assert that
approved packets disable Source Editor and to use a separate unapproved fixture
for editor-state isolation. That focused test passed, including package ordering,
stale-signature invalidation, and signed-snapshot download. The other 49 tests
passed in the preceding full validation run. Manifest removal, page ordering,
and category controls were not changed.

Separately, the real development service/database/object-storage integration
harness passed with its own synthetic 40-page nonblank PDF:

- Superseded the processing token after two durable batches (four pages).
  The old attempt stopped without publishing further checkpoints.
- Requeued the fixture and resumed through the real service. Previously saved
  PDF/PNG paths and hashes remained unchanged; final output had exactly 40 pages.
- Analysis ran once across the interrupted attempt, resume, and regeneration.
- Changed redactions forced new render paths and different final PDF bytes.
  The changed region rendered white, and the final PDF had no extracted text.
- No partial packet became ready. The successful resume took 25.9 seconds
  including storage, and regeneration took 26.4 seconds in this single local run.

Reproduction: from the workspace root, run
`NODE_ENV=development node artifacts/api-server/scripts/checkpoint-resume-development.mjs`.
The harness refuses deployment execution and creates only its own fixture.
Its fixture is archived and retained rather than deleting potentially referenced
immutable objects. It injects lease-token loss; it does not kill an Autoscale
instance, demonstrate autonomous wake-up, or prove lost-commit-ack reconciliation.

These checks are deliberately independent and do not replace the following
remaining tests:

- a browser journey through manifest removal, regeneration, and successful
  editing of the previously approved packet in `ready_for_approval`;
- an API integration test confirming an approved packet's redaction request
  remains rejected with 409 while removal and regeneration restore the allowed
  edit transition;
- a post-publish production check of schema reconciliation, private object-store
  checkpoints, stale-lease recovery, and the complete 40-page customer package.

## Reproduce

From `artifacts/api-server`, choose the first CPU allowed for the current
process and run:

```sh
CPU="$(taskset -pc $$ | sed 's/.*: //' | cut -d, -f1 | cut -d- -f1)"
BENCHMARK_CPU_AFFINITY="taskset CPU ${CPU}" \
  taskset -c "${CPU}" node scripts/benchmark-pdf-batches.mjs --baseline
```

If `taskset` is unavailable, run the Node command directly and leave
`BENCHMARK_CPU_AFFINITY` unset; the JSON will explicitly report that it was not
pinned. Pass an explicit PDF path if auto-discovery is undesirable. Add
`--keep` only when inspecting local artifacts is necessary; by default all
temporary PDFs and the compiled worker harness are removed. The script emits
aggregate JSON only and does not log document content or private filenames.