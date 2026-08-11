---
name: Signoff signature integrity
description: Invariant for any change touching quote signoff flows
---
A customer signature must only ever cover content the signer actually reviewed.

**Why:** Signoff documents are approval records; silently keeping (or accepting) a signature after the underlying content changes creates an invalid legal/business record.

**How to apply:** Any new mutation that changes what appears on the signoff sheet must invalidate existing signatures, and signing must verify the signer's loaded version under the same lock discipline the existing sign routes use (see the version check in the sign routes for the pattern).
