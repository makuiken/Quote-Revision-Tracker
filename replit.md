# Kuiken Brothers Quote Tracker

## Overview
Internal tool for the Kuiken Brothers millwork sales team. Logs customer quote requests (doors, windows, trim, general millwork), tracks a timestamped revision log per quote, prints the revision log, and generates a printable customer signoff document with typed/drawn in-app signature capture plus a blank line for paper signing. No pricing, statuses, emailing, or attachments.

## Architecture
- pnpm monorepo; artifacts: `quote-tracker` (React + Vite web app, previewPath `/`), `api-server` (Express 5).
- API contract in `lib/api-spec/openapi.yaml`; codegen produces React Query hooks (`lib/api-client-react`) and Zod schemas (`lib/api-zod`). Note: the codegen script rewrites the generated zod import to `zod/v4` (orval emits v4 syntax like `zod.int()`).
- Database: Replit PostgreSQL via Drizzle; schema in `lib/db/src/schema/quotes.ts` (quotes, revisions, signoffs; specs stored as jsonb).
- Auth: Replit-managed Clerk (whitelabel). Server uses Clerk proxy middleware + `clerkMiddleware` in `app.ts`; all `/api` routes except `/healthz` require auth. Revision authors are resolved from the Clerk user automatically.
- Integrity rule: any edit to a quote (PATCH) deletes its existing customer signoff, since the signed document no longer matches the current specs. No CORS middleware — the app is same-origin behind the shared proxy.

## User preferences
- Team is non-technical: keep UI extremely simple, plain language, big targets.
- Printed documents branded "Kuiken Brothers".
