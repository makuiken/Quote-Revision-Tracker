---
name: Draft/autosave write ordering
description: Design rules for autosaved drafts (revision note drafts and any future autosave feature) to avoid data-loss races.
---

Rule: all client writes for an autosaved resource (save/discard/publish) must go through one ordered write queue, with destructive actions bumping an epoch that drops queued-but-undispatched saves before dispatch. Publish must carry the latest text in a single server transaction rather than save-then-publish.

**Why:** completion code review rejected weaker designs twice — a debounce + shared mutation lets a delayed autosave PUT resurrect a discarded draft or overtake a publish with older text; awaiting only the "latest" promise still leaves earlier in-flight PUTs unordered.

**How to apply:** when adding any autosave/draft feature, reuse the promise-chain queue + epoch pattern in the quote-detail composer, give the destructive endpoint the authoritative payload, and add e2e tests that delay PUTs via route interception to prove ordering.
