---
name: Express router-level guards
description: Why bare router.use(middleware) in a root-mounted sub-router blocks the whole API.
---
**Rule:** In an Express app where several routers are mounted at the same base path (e.g. `app.use("/api", adminRouter); app.use("/api", quotesRouter)`), a bare `router.use(authGuard)` in an earlier router runs for EVERY request passing through, even ones its routes don't match — always scope it: `router.use("/admin", authGuard)`.

**Why:** An unscoped `router.use(requireAdmin)` in the admin router 403'd all API requests (including `/me` and quote CRUD) for every non-admin user; it surfaced as "CRUD is broken" while admins saw nothing wrong.

**How to apply:** When adding a guarded router to the api-server, attach guards per-path or per-route. Verify with a non-admin session (e2e member account), not just the admin account.
