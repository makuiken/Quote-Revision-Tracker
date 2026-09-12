# Scoped approval API contract

Task 29 adds additive scoped-approval endpoints; existing `/quotes/:id/signoff`
and `/public/signoff/:token` remain legacy whole-quote links and must not be
used to create a new partial approval.

## Legacy whole-quote records

`QuoteDetail` responses expose a legacy whole-quote record as
`legacyApproval: { status: "legacy", validity: "signed"|"needs_resigning",
signedAt, documentAvailable, invalidationReason }`, not as
`signoff`. Never render a legacy signature in current mutable quote/revision
HTML. If `documentAvailable` is true, use the legacy signed-document download;
otherwise preserve the record/status but do not fabricate a signed snapshot.

## Category identifiers

Use the quote category IDs exactly as stored: `windows`, `doors`,
`interiorDoors`, `exteriorDoors`, `trim`, and `millwork`. `doors` remains a
supported legacy category. Scope arrays must be non-empty, unique subsets of
the parent quote's current categories.

## Packets

`POST /quotes/:id/manufacturer-packets` requires:

```json
{ "name": "manufacturer.pdf", "size": 123, "contentType": "application/pdf",
  "manufacturer": "Marvin", "productType": "windows" }
```

`PATCH /quotes/:id/manufacturer-packets/:packetId/product-type` changes an
assignment with `{ "productType": "interiorDoors" }`. The response packet
contains `productType`. A packet without this value is legacy/unclassified:
show it as requiring assignment, and do not offer it in a scoped approval.

## Create and view a request

`POST /quotes/:id/scoped-approvals`:

```json
{ "productTypes": ["windows", "interiorDoors"] }
```

returns:

```json
{
  "token": "opaque-token",
  "productTypes": ["windows", "interiorDoors"],
  "documentVersion": "sha256-like-fingerprint",
  "publicPath": "/api/public/scoped-signoff/opaque-token",
  "notIncludedProductTypes": ["exteriorDoors"],
  "status": "open"
}
```

`DELETE /quotes/:id/scoped-approvals/:requestId` cancels an **open** request
(204). It marks the request revoked rather than deleting it, allowing a
corrected scope after refresh/selection error. Signed evidence and stale or
already-revoked request history are preserved; those cancellation attempts
return 409.

The server rejects a scope when any approved legacy/unclassified packet could
not be safely placed in it. `GET /quotes/:id/scoped-approvals` returns
`{ approvals, coverage }`: request/approval history and current coverage per
active type (`open`, `signed`, or `needs_resigning`). Quote list/detail rows
also include `approvalCoverage` and `approvalStatus` (`open`, `signed`,
`partial`, or `needs_resigning`); dashboard `status=partial` and
`status=needs_resigning` are server-side filters.

## Customer routes

The public page is server-bound to its token; it never accepts a client scope:

* `GET /public/scoped-signoff/:token`
* `PUT /public/scoped-signoff/:token` with the existing signer fields plus
  `documentVersion`
* `GET /public/scoped-signoff/:token/document`
* `GET /public/scoped-signoff/:token/packet`
* `GET /public/scoped-signoff/:token/packet/pages/:pageNumber?documentVersion=...`

Response data includes `productTypes`, `notIncludedProductTypes`, only scoped
specifications/revisions/pages, a locked `preparedAt`, and a document version.
A stale version gets
409. Packet-page indexes are indexes in the filtered scoped manifest; a token
cannot retrieve a page from another product type. Scoped packet metadata
contains `approvedAt` and `productTypes`, sourced from the locked snapshot.

## Internal document routes

Use an approval ID, not a mutable scope query:

* `GET /quotes/:id/scoped-approvals/:approvalId/document`

Signed approval snapshots remain downloadable even after later selective
invalidations. Display the included and explicitly excluded type labels from
the server response.