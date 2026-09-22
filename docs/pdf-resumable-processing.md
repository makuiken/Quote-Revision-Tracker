# Resumable PDF batch benchmark

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