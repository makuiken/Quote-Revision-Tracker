import { randomBytes } from "node:crypto";

// Dedicated E2E account in the development Clerk instance. The password is
// random per machine but persisted via env so re-runs reuse the same user.
export const TEST_USER_EMAIL = "e2e-tester+clerk_test@example.com";

function derivePassword(): string {
  if (process.env.E2E_TEST_USER_PASSWORD) return process.env.E2E_TEST_USER_PASSWORD;
  // Deterministic fallback derived from the Clerk secret key so that the same
  // dev instance always yields the same password without storing a new secret.
  const seed = process.env.CLERK_SECRET_KEY ?? randomBytes(16).toString("hex");
  return `E2e!${Buffer.from(seed).toString("base64url").slice(-20)}`;
}

export const TEST_USER_PASSWORD = derivePassword();
