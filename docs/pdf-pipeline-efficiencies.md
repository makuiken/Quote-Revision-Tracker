# PDF pipeline efficiency evidence — Task 89

## Scope and method

Measured September 23, 2026 in development, using the real `processPacket`,
development PostgreSQL, and real private object-storage uploads/downloads.
Baseline packet modules were frozen from Git
`2d583bf87051b1d7770b6a062570f89b99ce8dd2`, not reconstructed after the change.
Candidate used the working-tree service/pipeline, including the corrected
same-directory checkpoint merge. The PDF.js/native-canvas renderer was unchanged.

`artifacts/api-server/scripts/benchmark-pipeline89.mjs` builds isolated benchmark
bundles without starting a server. It refuses deployment environments and
databases whose hostname is not this development environment's `helium`.
From `artifacts/api-server`, run
`node scripts/benchmark-pipeline89.mjs baseline 2 31` and corresponding
`candidate`, `40` combinations. It requires the private exact31 fixture already
recovered for Task 86; private source PDFs are not committed.

Each run created a fresh, unshared temporary quote and packet, uploaded its own
source object, analyzed the source, rendered every page, registered and committed
real immutable checkpoints, merged, uploaded the final PDF, and committed ready
status. Timing starts immediately before `processPacket` and ends on return:
initial fixture upload, subsequent output verification, and cleanup are excluded.
The harness checks **`ready_for_approval`**, not merely the function's `"processed"`
return value (which can accompany a recorded failure).

Fixtures:
- **Exact31:** authentic 31-page source and its actual reviewed rectangles
  (nine rectangles on one page), from `/tmp/task86-private`.
- **Representative40:** existing authentic 40-page attachment, explicit empty
  manual-redaction selection. This exercises full rendering/storage, not the
  same redaction distribution as Exact31.

Two repeats per variant/fixture; sequential baseline then candidate, not
randomized. These are small-sample development observations, not production
latency guarantees or confidence intervals. Other workspace activity was not
isolated; the main agent reports typechecking overlapped roughly the final ten
seconds of the last candidate40 run.

## Network-inclusive results

| Fixture | Baseline runs (s) | Candidate runs (s) | Mean baseline → candidate | Mean reduction |
|---|---:|---:|---:|---:|
| Exact31 | 58.852, 52.755 | 23.763, 22.434 | 55.804 → 23.099 s | 58.6% |
| Representative40 | 65.516, 61.359 | 20.167, 21.275 | 63.438 → 20.721 s | 67.3% |

Service stage measurements (means, seconds):

| Fixture/variant | Worker rendering | Checkpoint storage | Sanitization wall time | Finalization wall time |
|---|---:|---:|---:|---:|
| Exact31 baseline | 19.820 | 16.950 | 37.889 | 15.860 |
| Exact31 candidate | 19.512 | 9.188 | 20.302 | 0.976 |
| Representative40 baseline | 16.546 | 21.847 | 39.563 | 21.992 |
| Representative40 candidate | 17.044 | 11.079 | 17.663 | 1.225 |

Worker cost is essentially unchanged here. Savings are consistent with bounded
concurrent PDF/PNG writes, overlapping one next-page render with current-page
persistence, and eliminating re-download of freshly created checkpoint PDFs.
Stage sums are **not additive** in the overlapping candidate. Finalization
includes checkpoint materialization, merge, and final upload; it is not a
standalone network-download timer.

### Output checks

All four successful runs per fixture have identical ordered page-PNG SHA-256
hashes and PDF page geometries. Every output has the expected page count.
Exact31 final PDFs are each 6,869,779 bytes; Representative40 final PDFs are each
9,365,589 bytes. Whole-PDF byte identity was not claimed: generated PDF metadata
can differ. PNG identity establishes raster output parity with the unchanged
renderer on these fixtures, not universal security proof.

### Observed admission and memory

Benchmark-only instrumentation records the input RSS and unchanged boolean
decision inside `admitPageOverlap`; it does not alter its decision:

| Fixture | Next-page overlaps admitted, across two runs | Rejected | RSS at admission points | Largest retained current output |
|---|---:|---:|---:|---:|
| Exact31 | 60 / 60 | 0 | 263.1–347.4 MiB | 0.802 MiB |
| Representative40 | 78 / 78 | 0 | 236.3–340.6 MiB | 0.625 MiB |

Each acceptance starts the next render before awaiting current persistence.
These counts are actual admission observations, not a configured concurrency
claim; overlap duration itself was not separately traced. RSS is process-wide,
including the renderer thread, sampled **at admission points**, not an absolute
peak, and no baseline RSS comparison was collected. No real memory-pressure
rejection was observed. The 768 MiB admission ceiling is a conservative
**project guard**, not a verified Replit hosting memory quota.

## Read-only production correlation

Deployment-log skill queries returned 31 consecutive checkpoint commits for a
31-page job: cumulative batch wall time **249.727 s**, including **198.718 s**
worker time. A 40-page job had only pages 1–21 in the available extract:
**557.978 s** cumulative batch time, **506.337 s** worker time. This second
sample is incomplete and must not be called a completed job or compared as a
40-page total.

A separate query for `Packet processing stage timings` returned **no matching
completed-job summary**. Thus the available logs establish page/checkpoint
correlation and much slower production rendering, not completed end-to-end
production improvement. No production retries, writes, or publishing were
performed. Development speedups cannot safely be projected onto production.
The stronger production renderer bottleneck may limit pipeline-only gains.

## Native renderer probe — not adopted

The installed `pdftoppm` (Poppler 25.07.0) was available without installation;
Ghostscript and MuPDF command-line tools were not found. The isolated probe
script `benchmark-native89.mjs` compares two exact31 pages at 160 DPI with fresh
PDF.js worker previews. It runs Poppler as a subprocess with a 60-second timeout
and 1 GiB virtual-memory limit. This is a resource-bounded probe, **not** an
OS-level filesystem/network sandbox. Outputs remained private and were deleted.

| Source page | Poppler PNG render | Current worker preview | Differing RGBA pixels |
|---|---:|---:|---:|
| 15 | 794 ms | 1,233 ms | 116,094 / 2,393,600 |
| 16 | 577 ms | 565 ms | 111,619 / 2,393,600 |

Both produced 1360×1760 pixels. About 4.9% and 4.7% of pixels differed;
the probe did not establish visual/semantic equivalence. One render was faster,
one slightly slower; these single-page, single-repeat numbers are not a
sanitization or end-to-end benchmark. Redaction placement, rotation, fonts,
malformed inputs, PDF re-embedding, production availability, and recovery were
not validated for Poppler. Poppler's GPL-family licensing requires distribution
and integration review (the binary version banner is not a license clearance).
Do **not** adopt it on this evidence. A separately isolated, licensing-reviewed
parity evaluation is required before considering a production renderer change.

## Failures, cleanup, and retained evidence

An initial detached launch was terminated by the execution environment, leaving
one source/fixture. After confirming no benchmark process survived, its owned
development packet was fenced before cleanup. An early candidate run rendered
31 pages but failed the worker's same-private-directory merge guard; it was
excluded from successful timings. The service owner corrected the directory
integration, after which all eight measured runs reached ready status.

All ten fixture ledgers report cleanup: **648 object paths** deleted across
successful, failed, and interrupted attempts. This includes checkpoint registry
paths, source, page images, and final PDFs where created. Quotes cascade-delete
their packets; registry rows were removed only after object deletion and writer
settlement. Final development queries returned zero benchmark quotes and zero
registry rows for the fixture packet IDs. No production objects were deleted.

Raw content-free logs, page hashes, per-run timings, and cleanup ledgers are
private under `/tmp/task89-private`; customer source content is not logged or
checked in. Temporary `.pipeline89-baseline` / `.pipeline89-candidate` bundles
are removed after the evaluation. The native probe requires rebuilding the
baseline bundle if rerun. This benchmark is separate from the main agent's
recovery/supersession tests; it does not claim to exercise those failure cases.