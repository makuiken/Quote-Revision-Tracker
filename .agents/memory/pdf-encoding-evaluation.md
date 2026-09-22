---
name: Secure PDF encoding evaluation
description: Evidence needed before changing raster encoding or resolution policy
---
Treat faster encoding measurements as evaluation, not permission to lower resolution or adopt lossy compression.

The user confirmed keeping PNG on 2026-09-22. Treat alternative encoders as research, not an approved production migration.

**Why:** The user accepted the conservative PNG outcome after seeing the benchmark and validation limitations.

**Why:** The available local manufacturer corpus contains digital quotes, not genuine physical scans. A simulated noisy raster cannot establish scanner readability. Standalone encoding timings also differ materially from encoding inside the sanitizer, so summed estimates do not prove a production speedup.

**How to apply:** Keep the existing policy until the proposed production path passes independent decoding of actual PDF image streams, exact lossless pixel comparisons, coordinate and forensic checks, and representative readability validation. Compare full-path latency and memory under the existing worker limits before adopting it. An image buffer that looks right is insufficient if the emitted PDF cannot display that image.