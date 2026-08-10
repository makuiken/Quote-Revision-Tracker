# Threat Model

## Project Overview

Kuiken Brothers Quote Tracker is an internal Node.js/Express + React (Vite) web application for millwork sales staff. It tracks customer quote requests (doors, windows, trim, general millwork), maintains a timestamped revision log, and captures customer signoff (typed or drawn signature) via either a staff-facing authenticated interface or a token-gated public share link. The app is deployed on Replit (autoscale, public visibility) at `https://quote-revision-tracker.replit.app`. Authentication is managed by Clerk; all internal API routes require a valid Clerk session plus app-level approval.

## Assets

- **Quote and customer data** — quote numbers, customer names, project names, job addresses, specs, and revision logs. Contains PII and business records.
- **Signoff records** — customer signature data (base64-encoded canvas drawings or typed text) stored as PostgreSQL text, legally significant documents.
- **Share tokens** — 192-bit base64url tokens granting unauthenticated read/write access to a quote's signoff page. Compromise gives access to customer PII and the ability to forge or overwrite a customer signature.
- **User accounts and sessions** — Clerk session tokens, app-level role/approval state in PostgreSQL.
- **File attachments** — uploaded files stored in Replit Object Storage (private bucket), referenced by UUID paths.
- **Application secrets** — Clerk API keys, database connection string, Replit Object Storage credentials.

## Trust Boundaries

- **Internet / API boundary** — Replit deploys the app publicly. Public share link endpoints (`/api/public/signoff/:token`) are reachable from the internet without login; all other `/api` routes require a Clerk session.
- **Authenticated / Approved boundary** — Clerk validates identity; the app additionally checks that the user has been approved by an admin (status = approved). Pending users can only reach `/api/me`.
- **Member / Admin boundary** — Admin-only actions (user management) are gated by `requireAdmin` middleware on all `/api/admin/*` routes.
- **Share-link / Authenticated boundary** — Public share routes accept a 192-bit random token instead of a Clerk session; the token grants read + signoff-write access to one specific quote.
- **App server / Object Storage boundary** — Private attachments are served via `/api/storage/objects/*`; public assets via `/api/storage/public-objects/*`. Upload URLs are presigned by the Replit sidecar at `http://127.0.0.1:1106`.

## Scan Anchors

- **Entry points:** `artifacts/api-server/src/routes/` — `public.ts` (unauthenticated, token-gated), `quotes.ts` (auth+approved), `admin.ts` (auth+approved+admin), `storage.ts` (per-route auth), `health.ts` (open).
- **Highest-risk areas:** `routes/public.ts` (public internet, token-gated signoff write), `middlewares/requireAuth.ts` (auth/approval/role enforcement), `routes/storage.ts` (file serving).
- **Public surface:** `/api/healthz`, `/api/public/signoff/:token` (GET and PUT).
- **Authenticated surface:** all other `/api/*` routes.
- **Admin surface:** `/api/admin/*` routes (requireAdmin enforced).
- **Dev-only:** `artifacts/mockup-sandbox/` (design canvas, preview path `/__mockup`).

## Threat Categories

### Spoofing
Clerk manages authentication. The server validates the Clerk session on every request via `clerkMiddleware` + `getAuth(req)`. The `requireAuth` middleware rejects any request without a valid session. Share links use a 192-bit random token (24 random bytes, base64url-encoded), making guessing infeasible. Webhooks and third-party callbacks are not used. **Guarantee:** every non-public route must resolve a valid Clerk `userId` before any data is accessed.

### Tampering
Input is validated server-side via Zod schemas before database writes. Quote number format is enforced by regex. Signature type is constrained to an enum. The `signatureData` field has no maximum length beyond the global 2MB JSON body limit — large payloads can be stored in the DB. **Guarantee:** all mutation endpoints must validate input with Zod before writing; the `signatureData` field should have an explicit max length.

### Information Disclosure
The public share endpoint (`GET /api/public/signoff/:token`) returns full quote details including customer name, job address, revision history, and signoff data to anyone who holds the token. Share tokens never expire and are not rotated when a quote is edited. A leaked token provides permanent read access to the quote. The `/api/storage/objects/*` endpoint serves private files to any approved team member without object-level ACL checks despite the ACL framework being present. **Guarantee:** tokens must be invalidated or rotated when their associated quote is edited; sensitive file access should enforce object-level ACLs.

### Denial of Service
No rate limiting exists on any endpoint, including the unauthenticated `PUT /api/public/signoff/:token`. An attacker with a known share token can flood the endpoint with large (up to 2MB) signature payloads, causing database bloat and potentially degrading service. The global 2MB JSON body limit is the only guard. **Guarantee:** public-facing write endpoints require rate limiting and explicit payload size bounds.

### Elevation of Privilege
Admin routes are correctly guarded with `requireAdmin` scoped to `/admin/*` paths. Any approved member (non-admin) can delete any quote and overwrite any signoff — there is no ownership-level access control on these operations, which appears intentional for an internal shared-team tool. SQL injection is prevented by Drizzle ORM parameterized queries. **Guarantee:** admin middleware must remain scoped to `/admin` paths; query parameters must continue to be passed through Drizzle, not concatenated.
