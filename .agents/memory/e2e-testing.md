---
name: E2E testing decisions
description: Durable decisions for running Playwright e2e tests with Clerk auth in this project
---

- **Clerk sign-in in headless tests must use ticket strategy** (`clerk.signIn({ page, emailAddress })`), not password. **Why:** dev Clerk instances enforce bot protection (`needs_client_trust`) in headless browsers and the `@clerk/testing` token was not injected; the ticket flow uses a backend sign-in token and bypasses it. **How to apply:** any new e2e spec signs in per test via the shared beforeEach pattern; storage-state reuse does not carry a dev-instance Clerk session.
- Clerk rejects `.test` TLD emails for user creation; use `*+clerk_test@example.com` addresses.
- Drizzle `db push` requires a TTY (even `--force`); schema drift is instead repaired by the idempotent startup reconciliation in the db package (extend it when the schema gains columns).
