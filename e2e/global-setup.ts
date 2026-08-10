import { clerkSetup } from "@clerk/testing/playwright";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-user";

/**
 * Global setup:
 * 1. Obtain a Clerk testing token (bypasses bot protection) via @clerk/testing.
 * 2. Ensure a dedicated E2E test user exists in the (development) Clerk instance.
 */
async function ensureTestUser(): Promise<void> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set");

  const headers = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };

  const lookup = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(TEST_USER_EMAIL)}`,
    { headers },
  );
  if (!lookup.ok) {
    throw new Error(`Clerk user lookup failed: ${lookup.status} ${await lookup.text()}`);
  }
  const existing = (await lookup.json()) as Array<{ id: string }>;
  if (existing.length > 0) {
    await approveInAppDb(existing[0].id);
    return;
  }

  const create = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email_address: [TEST_USER_EMAIL],
      password: TEST_USER_PASSWORD,
      first_name: "E2E",
      last_name: "Tester",
      skip_password_checks: true,
    }),
  });
  if (!create.ok) {
    throw new Error(`Clerk user creation failed: ${create.status} ${await create.text()}`);
  }
  const created = (await create.json()) as { id: string };
  await approveInAppDb(created.id);
}

/**
 * The app gates all API access behind admin approval, so pre-approve the
 * dedicated e2e account directly in the app database.
 */
async function approveInAppDb(clerkUserId: string): Promise<void> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `insert into users (clerk_user_id, name, email, role, status)
       values ($1, 'E2E Tester', $2, 'member', 'approved')
       on conflict (clerk_user_id) do update set status = 'approved'`,
      [clerkUserId, TEST_USER_EMAIL],
    );
  } finally {
    await pool.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await ensureTestUser();
  await clerkSetup();
}
