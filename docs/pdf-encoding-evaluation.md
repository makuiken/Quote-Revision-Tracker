# Secure PDF encoding evaluation

## Decision

**Keep production at 160 DPI with PNG embedding.** No production sanitizer,
worker, storage, or evidence policy changed. Lossless RGB/Flate level 1 is the
best candidate for a subsequent bounded implementation experiment. Do not adopt
JPEG or reduce DPI based on this evaluation.

## Reproduction

From `artifacts/api-server`:

```sh
node scripts/run-pdf-encoding-benchmark.mjs
node scripts/pdf-scan-encoding-benchmark.mjs
node scripts/run-pdf-encoding-forensics.mjs
pnpm exec tsc --noEmit --pretty false
```

From the workspace root, with PyMuPDF installed:

```sh
python .agents/scripts/inspect-pdf-corpus.py
python .agents/scripts/check-encoding-visuals.py
```

The main benchmark needs the existing local PDFs in `attached_assets`. It fails
if an input is missing, rather than silently substituting a fixture. JSON results
are in `artifacts/api-server/scripts/results/`. PDFs and crops containing customer
content remain under `/tmp/pdf-encoding-benchmark` and `/tmp/pdf-corpus-inspection`,
not in the report or repository. Synthetic-scan PDFs are in `/tmp/pdf-encoding-scan`.
The helpers are evaluation-only and are not imported by production code.

## Corpus and method

Measured locally on 2026-09-22, Linux x64, Node 24.13.0:

- Andersen: pages 1, 10, 21 of a 21-page quote.
- Marvin: pages 1, 8, 16 of a 16-page quote.
- Reeb: pages 1, 11, 22 of a 22-page quote.
- Hall construction door quote: pages 1, 9, 17 of a 17-page quote.
- Full 40-page Marvin/GRT product quote: specifications, drawings, and terms.
- Deterministic simulated noisy scan with fine-print fractions, tolerances,
  and one-pixel drawing strokes. **No genuine physical scans were available.**

Visible source font sizes include 7.5–9 point text. Tiny 2-point spans also occur
in the 40-page source; minimum font size alone does not establish visible
readability. The sample is not a comprehensive manufacturer/scanner corpus.

The existing `sanitizePdf` generates the reference PNGs. Alternative encoders
receive only those raster pages and create entirely new PDFs. They never copy
source objects or place redaction overlays above source content.

Each standalone encoder has three serial timed runs, including PDF save; raw
runs, medians, source SHA-256 identifiers, and output sizes are recorded. Reference
sanitization and PNG decoding are measured once per sample. RGB/Flate and JPEG
medians exclude the separately reported PNG-to-RGB decode. The benchmark retains
all decoded pages and is **not** a production memory/concurrency implementation.
Its offline elapsed-time allowance is 300 seconds; production limits are unchanged.

## Results

### Full 40-page workload at 160 DPI

Actual reference sanitization: **15.944 s**, of which rendering/PNG took
11.369 s and in-engine PDF encoding took 4.567 s. This is a new local measurement,
not a reproduction of the earlier 13–14 s result under identical conditions.

| Encoding | Standalone median | Extra PNG decode | Output bytes | Estimated render + decode + encode |
|---|---:|---:|---:|---:|
| Existing PNG embedding | 8.263 s | — | 9,365,885 | 19.632 s |
| Lossless RGB/Flate 1 | 0.907 s | 1.974 s | 10,819,224 | 14.250 s |
| Lossless RGB/Flate 6 | 1.733 s | 1.974 s | 9,365,971 | 15.076 s |
| JPEG quality 95 | 2.523 s | 1.974 s | 14,539,746 | 15.866 s |

**The final column is an estimate, not measured end-to-end latency.** In-engine
PNG encoding (4.567 s) differs substantially from standalone encoding (8.263 s).
Do not describe the latter comparison as a measured production speedup. The
estimates omit some source-open/setup work and do not measure worker queueing,
storage, peak RSS, or concurrent workloads. Flate 1 costs about 15.5% more PDF
bytes; Flate 6 is almost size-neutral.

### Representative three-page samples, 160 DPI

Milliseconds; decode is additional for every non-PNG candidate:

| Sample | PNG | Decode | Flate 1 | Flate 6 | JPEG 95 |
|---|---:|---:|---:|---:|---:|
| Andersen | 698.4 | 182.0 | 68.3 | 141.0 | 534.4 |
| Marvin | 586.5 | 78.0 | 57.9 | 114.3 | 273.3 |
| Reeb | 652.6 | 82.3 | 67.9 | 134.3 | 486.4 |
| Door quote | 591.1 | 72.6 | 54.7 | 114.0 | 159.5 |

PDF.js emitted existing font warnings on some real inputs. These measurements
compare candidates to the same rendered baseline, not fidelity to every source
font on every viewer.

### Simulated noisy scan

One 160-DPI letter page: PNG 1,133.8 ms / 2,367,363 bytes; Flate 1
110.7 ms / 2,430,395 bytes; Flate 6 521.9 ms / 2,367,373 bytes;
JPEG 95 112.4 ms / 1,086,032 bytes. Decode overhead is separately recorded in
the scan JSON. JPEG saves space on noise but is lossy and fails the redaction
pixel gate below. These are encoding measurements, not scanner-to-PDF timings.

### Lower resolution

At 140 DPI the full reference workload took **13.984 s**, versus 15.944 s at
160 DPI in this run. That is a single local observation. It has not passed
comprehensive small-text/dimension/physical-print readability validation.
**Do not lower production DPI.**

## Readability and forensic evidence

The forensic runner generates an actual adversarial PDF, then sends it through
the real sanitizer before testing each candidate. The source contains sensitive
text/colored marks in selected rectangles, metadata, an attachment, JavaScript
action, and an excluded page with annotation/form data. The selected page has
90-degree rotation, a non-zero CropBox, and fractional redaction boundaries.

At **72, 140, and 160 DPI**, independent Poppler extraction and PDF object checks
verified:

- No extractable text in the output.
- No source fonts, non-empty annotations, forms, attachments, actions, outlines,
  or source metadata capabilities.
- Exactly one decodable raster image on the selected output page.
- Baseline PNG and both lossless Flate candidates have exact decoded pixel
  equality with the sanitizer output and completely white selected rectangles.
- JPEG produces different pixels and fails even the relaxed redaction-region
  threshold (RGB >=245) at all three tested resolutions. The runner records
  these candidate **rejections**, not approvals. Compression ringing is not
  evidence that original hidden text survives, but it fails the conservative
  adoption gate.

An initial experimental Flate serialization defect was caught by independent
image extraction and corrected before the recorded final timings. This
demonstrates why inspecting input PNGs alone is not an adequate test.

Separately, MuPDF independently rendered **all 40 pages** of both lossless
160-DPI candidates and the noisy-scan candidates: every rendered pixel matched
the corresponding PNG-PDF baseline. Selected actual-PDF crops and a contact
sheet were visually inspected: product text, dimensions, fractions, and
tolerances were readable at the inspected scale. This establishes no additional
readability loss for these lossless samples, not universal source readability.
The contact sheet's JPEG appearance alone is not an approval; it does not
override the failed pixel gate.

Tests are adversarial regression evidence, not a proof against every possible
malformed PDF. Redaction accuracy still depends on correctly selected bounds.

## Adoption prerequisites

Before considering a production change, measure a sequential/bounded RGB path
inside the real worker (including retained PNG outputs, source setup, save,
timeout behavior, output caps, peak memory, and concurrent requests). Require
actual-PDF forensic and coordinate tests to remain green. Obtain genuine
low-contrast/skewed scanner samples and check fine print/dimensions at normal
viewing and print scales. No speed claim or policy switch is justified until
that integrated experiment succeeds.