---
name: Signoff signature integrity
description: Invariant for any change touching quote signoff flows
---
A customer signature must only ever cover content the signer actually reviewed.

**Why:** Signoff documents are approval records; silently keeping (or accepting) a signature after the underlying content changes creates an invalid legal/business record.

**How to apply:** A mutation must invalidate current approval coverage only for affected product types, not delete signature evidence. Signing must verify the signer's loaded version under the same lock discipline as content mutations.

Immutable evidence and current coverage are different concepts. A combined approval remains evidence for its original scope even when one covered type later needs re-signing; never narrow or relabel that original document.

**Why:** The user requires unaffected product approvals to survive independent revisions without altering what the customer originally signed.

**How to apply:** Keep original scope and signed bytes intact. Compare manufacturer page order within each type, rather than absolute positions in the whole quote, when deciding which coverage changed.

Never reconstruct a legacy signed document from current mutable quote content.

**Why:** Legacy records without a captured structured snapshot cannot prove that today's specifications match what the customer reviewed.

**How to apply:** Show legacy evidence separately using an existing immutable PDF when available, explicitly report when it is unavailable, and request a new scoped approval rather than overwriting the original.

Pin displayed preparation dates for the lifetime of a request, including sign-time recomputation.

**Why:** Including a newly generated clock value in a content hash makes every valid submission stale; omitting a displayed date lets print content drift outside the reviewed fingerprint.

**How to apply:** Capture once under the document lock and reuse for HTML, stored PDF, and validation.

All approval and content transactions must acquire the quote lock before locking a request or updating request state.

**Why:** A signer that locks a request first can deadlock with a mutation holding the quote lock while invalidating that same request.

**How to apply:** Resolve a token without a lock only to identify its parent, lock that quote, then reload and validate the request under lock.

The version hash and the document bytes must be derived from the same locked snapshot, including the ordered manufacturer-page selection. Never validate a version and then reload its page selection separately.

**Why:** A concurrent publication between the hash check and byte lookup can serve new pages under an accepted old version, or permanently cache mismatched PDF bytes at a version-keyed path.

**How to apply:** Pass captured quote, revisions, and immutable page references through preview and PDF generation; keep unpublished cleanup edits outside the signed content until explicit publication.

Formatting improvements apply to newly generated documents, not previously stored signed PDFs.

**Why:** Replacing an issued signed artifact for cosmetic reasons would silently change the customer's approval record.

**How to apply:** Version the unsigned rendering cache when layout changes, preserve existing signed snapshot bytes, and explain that distinction when improving PDF exports.

Use browser printing of the signoff HTML for the customer-facing Print / Save PDF action, rather than substituting a separately designed PDF.

**Why:** The user explicitly requires the same formatting as the visible signoff document and rejected the separately typeset PDF even after a redesign.

**How to apply:** Keep the print action on internal and public signoff views; retain server-generated snapshots for record integrity without replacing the print workflow.
