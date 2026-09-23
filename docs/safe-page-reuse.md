# Safe page reuse

Task 95 retains verified per-page raster PDFs and PNGs within the same uploaded
packet. Page identities bind the source digest, page geometry, rendering policy,
and canonical redaction rectangles. Candidate cache entries are not completed
pages: only the ordered, acknowledged checkpoint prefix may be finalized.

Redaction saves explicitly preserve eligible candidates. Legacy/unproven entries,
changed source or rendering policy, and missing or corrupt objects must not
silently supply output. Verified unchanged pages avoid raster work; changed or
unverifiable pages render again. Finalization still builds a fresh complete PDF.
Previously signed document paths and hashes remain immutable.

## Development integration harness

Run only against development database and storage:

```sh
NODE_ENV=development node artifacts/api-server/scripts/checkpoint-resume-development.mjs --safe-page-reuse
```

Both launcher and harness reject non-development environments and deployments.
The harness creates uniquely tagged quotes, packets, and synthetic signature
evidence. It only mutates its own objects. Cleanup discovers objects through the
durable checkpoint registry as well as completed/state paths, waits for its
writers to settle, removes storage objects, then deletes owned database fixtures.
If storage deletion fails, ownership rows are retained for recovery and the run
fails. Do not interrupt the process forcibly during cleanup.

New runs also fsync an append-only, owner-only path ledger at
`/tmp/task95-evidence/TASK95-<uuid>.jsonl`. The harness intercepts its own packet
immutable uploads to record every allocated final/checkpoint path **before**
upload, and records observed references before edits drop them. Recovery adds
these exact paths after verifying ledger identity and each owned packet prefix;
it never lists storage globally. The ledger is deliberately outside temporary
build directories and survives launcher cleanup. It contains paths/ownership,
not private PDF content. Preserve it until cleanup has been verified.

The five-page synthetic matrix covers first/middle/last add, move, resize and
remove, no-op submissions, multi-page changes, missing/corrupt PDF and PNG
fallback, token supersession and retained-prefix resume. Changed outputs are
compared by decoded RGBA pixel hashes against fresh full renders. Reported
`renderedPages` and `reusedPages` are actual pipeline progress counters; the
harness asserts them, rather than substituting expected counts. Timings encompass
the entire processing call, including verification, storage, and merge.

When `/tmp/task86-private/source.pdf` and `fixture.json` are available, a final
exact 31-page baseline/full-vs-single-edit experiment runs without printing
private text or rectangle contents. Missing private fixtures are explicitly
reported as skipped, never replaced by invented private evidence.

## Limitations and interpretation

## Recorded development evidence

The complete initial matrix passed, including exact private31 parity, with
21 ephemeral packets and 426 objects cleaned successfully. Private31 performed
31 renders in 24,301 ms initially; the single changed page performed one render
and reused 30 pages in 30,385 ms; an equivalent fresh render took 23,692 ms.
Thus raster work fell 96.8%, but end-to-end latency **increased** in this sample.
Do not describe this result as an overall performance speedup.

A second matrix additionally passed competing PDF/PNG retirement protection
without a signature fence. All matrix assertions passed, including retained
prefix resume and prior signed evidence. Its execution window expired during
sequential cleanup; explicit own-fixture registry recovery subsequently removed
406 discoverable objects and all 21 packet/registry fixtures without errors.
Cleanup now uses four bounded deletion workers to reduce this risk. The recovery
launcher is `--safe-page-reuse-cleanup`, with an explicit
`TASK95_CLEANUP_PACKET_ID`; it verifies the uniquely tagged development owner and
refuses active processing rows. Recovery cannot reconstruct already-unreferenced
final output paths lost from process memory, so a normal complete cleanup is
preferred for historical runs without a ledger. The second run predates this
ledger: searches of its existing logs and own temporary bundle found no exact
final-object paths, so no additional speculative deletions were attempted.
Its owned temporary build directory was removed after inspection.

### Scope caveats

- Prepared harness code is not execution evidence. Only a completed run with
  `matrix-passed` and successful cleanup establishes the covered assertions.
- The fixture signature row tests retained evidence immutability, not the HTTP
  signing flow, identity verification, or browser approval UX.
- This harness drives the real processing service and storage, but submits edits
  through own-row updates using the same reset helper; it does not exercise HTTP
  route authorization. A competing retirement transaction checks retained PDF
  and PNG protection during an own-packet edit, before any signature fence
  exists; it does not run a global sweep or claim multi-instance coverage.
- Source/policy incompatibility and legacy-cache validation additionally require
  checkpoint unit tests. This integration matrix does not claim those cases.
- Render savings do not imply proportional whole-job speedups. Source reads,
  integrity checks, storage, and final ordered merging remain necessary.
- Cache reuse is scoped to one packet/source, not across customers or uploads.
  No renderer, DPI, resource limit, or publishing/signoff rules are relaxed.