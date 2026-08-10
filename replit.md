# Kuiken Brothers Quote Tracker

## Overview
Internal tool for the Kuiken Brothers millwork sales team. Logs customer quote requests (doors, windows, trim, general millwork), tracks a timestamped revision log per quote, prints the revision log, and generates a printable customer signoff document with typed/drawn in-app signature capture plus a blank line for paper signing. No pricing, statuses, emailing, or attachments.

## Architecture
- pnpm monorepo; artifacts: `quote-tracker` (React + Vite web app, previewPath `/`), `api-server` (Express 5).
- API contract in `lib/api-spec/openapi.yaml`; codegen produces React Query hooks (`lib/api-client-react`) and Zod schemas (`lib/api-zod`). Note: the codegen script rewrites the generated zod import to `zod/v4` (orval emits v4 syntax like `zod.int()`).
- Database: Replit PostgreSQL via Drizzle; schema in `lib/db/src/schema/quotes.ts` (quotes, revisions, signoffs; specs stored as jsonb).
- Auth: Replit-managed Clerk (whitelabel). Server uses Clerk proxy middleware + `clerkMiddleware` in `app.ts`; all `/api` routes except `/healthz` require auth. Revision authors are resolved from the Clerk user automatically.
- Integrity rule: any edit to a quote (PATCH) deletes its existing customer signoff, since the signed document no longer matches the current specs, and auto-logs a revision entry listing each changed field with old → new values. No CORS middleware — the app is same-origin behind the shared proxy.
- Access control: `users` table (role admin/member, status pending/approved). New sign-ins are created just-in-time as pending members and must be approved by an admin (Team page, `/admin/*` routes). Sign-ups are restricted to `@kuikenbrothers.com` emails (dev-only exception for `+clerk_test@example.com` e2e accounts). `makuiken@kuikenbrothers.com` is the permanent owner: always admin/approved (self-heals), cannot be demoted or removed. Guard middlewares live in `artifacts/api-server/src/middlewares/requireAuth.ts` — scope router-level guards to a path (`router.use("/admin", ...)`), never bare `router.use(...)` in a root-mounted router.
- Quotes: BisTrack quote number is exactly 7 digits; required projectName + jobAddress; lists display `customer - project`.
- E2E: Playwright suite in `e2e/` (workflow `e2e`); dedicated Clerk test user is pre-approved in the app DB by `global-setup.ts`.

## User preferences
- Team is non-technical: keep UI extremely simple, plain language, big targets.
- Printed documents branded "Kuiken Brothers".
