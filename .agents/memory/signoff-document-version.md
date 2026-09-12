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
