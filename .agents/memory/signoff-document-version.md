---
name: Signoff signature integrity
description: Invariant for any change touching quote signoff flows
---
A customer signature must only ever cover content the signer actually reviewed.

**Why:** Signoff documents are approval records; silently keeping (or accepting) a signature after the underlying content changes creates an invalid legal/business record.

**How to apply:** Any new mutation that changes what appears on the signoff sheet must invalidate existing signatures, and signing must verify the signer's loaded version under the same lock discipline the existing sign routes use (see the version check in the sign routes for the pattern).

The version hash and the document bytes must be derived from the same locked snapshot, including the ordered manufacturer-page selection. Never validate a version and then reload its page selection separately.

**Why:** A concurrent publication between the hash check and byte lookup can serve new pages under an accepted old version, or permanently cache mismatched PDF bytes at a version-keyed path.

**How to apply:** Pass captured quote, revisions, and immutable page references through preview and PDF generation; keep unpublished cleanup edits outside the signed content until explicit publication.

Formatting improvements apply to newly generated documents, not previously stored signed PDFs.

**Why:** Replacing an issued signed artifact for cosmetic reasons would silently change the customer's approval record.

**How to apply:** Version the unsigned rendering cache when layout changes, preserve existing signed snapshot bytes, and explain that distinction when improving PDF exports.

Use browser printing of the signoff HTML for the customer-facing Print / Save PDF action, rather than substituting a separately designed PDF.

**Why:** The user explicitly requires the same formatting as the visible signoff document and rejected the separately typeset PDF even after a redesign.

**How to apply:** Keep the print action on internal and public signoff views; retain server-generated snapshots for record integrity without replacing the print workflow.
