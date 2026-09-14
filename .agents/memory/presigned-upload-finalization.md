---
name: Presigned upload finalization
description: Security and cleanup rules for browser uploads made through reusable presigned write URLs.
---

Never attach the object targeted by a browser presigned PUT. Verify its metadata and generation, copy that exact generation to a distinct server-selected immutable path, and attach only the immutable copy.

**Why:** A presigned PUT remains usable after API completion, so the browser can otherwise replace verified bytes or recreate a deleted source object.

**How to apply:** Keep a durable lifecycle row containing both source and final paths. On deletion, remove current bytes opportunistically but preserve the cleanup tombstone and original URL expiry; after expiry, delete the source again before removing the tombstone.