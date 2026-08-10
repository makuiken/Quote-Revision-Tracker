import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, usersTable, type AppUser } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export interface AuthedRequest extends Request {
  userId?: string;
  appUser?: AppUser;
  /** Set when the signed-in account's email domain is not allowed to join. */
  emailRejected?: boolean;
}

/** This account is always an approved admin and can never be demoted or removed. */
export const OWNER_EMAIL = "makuiken@kuikenbrothers.com";

/** Only emails on this domain may create accounts. */
export const ALLOWED_EMAIL_DOMAIN = "kuikenbrothers.com";

export function isAllowedEmail(email: string | null): boolean {
  return !!email && email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

function isOwnerEmail(email: string | null): boolean {
  return !!email && email.toLowerCase() === OWNER_EMAIL;
}

// Bounded cache: profile email decides sign-up admission, so it must be
// re-checked periodically in case the user changes their Clerk email.
const nameCache = new Map<string, { profile: { name: string; email: string | null }; expires: number }>();
const NAME_CACHE_TTL_MS = 60_000;

export async function getUserProfile(
  userId: string,
): Promise<{ name: string; email: string | null }> {
  const cached = nameCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.profile;

  try {
    const user = await clerkClient.users.getUser(userId);
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.primaryEmailAddress?.emailAddress ||
      "Team member";
    const profile = {
      name,
      email: user.primaryEmailAddress?.emailAddress ?? null,
    };
    nameCache.set(userId, { profile, expires: Date.now() + NAME_CACHE_TTL_MS });
    return profile;
  } catch {
    return { name: "Team member", email: null };
  }
}

// Short-lived cache of app user rows so approval/role changes take effect
// quickly without a DB hit on every request.
const appUserCache = new Map<string, { user: AppUser; expires: number }>();
const APP_USER_TTL_MS = 15_000;

export function invalidateAppUserCache(clerkUserId?: string): void {
  if (clerkUserId) appUserCache.delete(clerkUserId);
  else appUserCache.clear();
}

async function getOrCreateAppUser(clerkUserId: string): Promise<AppUser | null> {
  const cached = appUserCache.get(clerkUserId);
  if (
    cached &&
    cached.expires > Date.now() &&
    // Never serve a stale non-admin owner row — re-check the DB so the
    // owner's self-heal takes effect immediately.
    !(isOwnerEmail(cached.user.email) && (cached.user.role !== "admin" || cached.user.status !== "approved"))
  )
    return cached.user;

  let [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));

  // The owner account is always an approved admin — self-heal if anything
  // (a bad migration, test run, or accidental edit) ever changed it.
  if (row && isOwnerEmail(row.email) && (row.role !== "admin" || row.status !== "approved")) {
    [row] = await db
      .update(usersTable)
      .set({ role: "admin", status: "approved" })
      .where(eq(usersTable.id, row.id))
      .returning();
  }

  if (!row) {
    const profile = await getUserProfile(clerkUserId);

    // New accounts are limited to company email addresses.
    if (!isAllowedEmail(profile.email)) return null;

    // All first-time inserts (owner, bootstrap, or ordinary member) go
    // through the same advisory-lock transaction so concurrent sign-ups
    // can't race the admin-count check.
    const isOwner = isOwnerEmail(profile.email);
    row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(815001)`);
      // Bootstrap: if no admin exists yet, the first user in becomes an
      // approved admin so the team is never locked out. The owner account
      // is always an approved admin.
      const [{ adminCount }] = (await tx
        .select({ adminCount: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(eq(usersTable.role, "admin"))) as [{ adminCount: number }];
      const isAdmin = isOwner || adminCount === 0;
      const inserted = await tx
        .insert(usersTable)
        .values({
          clerkUserId,
          name: profile.name,
          email: profile.email,
          role: isAdmin ? "admin" : "member",
          status: isAdmin ? "approved" : "pending",
        })
        .onConflictDoNothing({ target: usersTable.clerkUserId })
        .returning();
      return (
        inserted[0] ??
        (
          await tx
            .select()
            .from(usersTable)
            .where(eq(usersTable.clerkUserId, clerkUserId))
        )[0]
      );
    });
  }

  appUserCache.set(clerkUserId, {
    user: row!,
    expires: Date.now() + APP_USER_TTL_MS,
  });
  return row!;
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.userId = userId;
  getOrCreateAppUser(userId)
    .then((appUser) => {
      if (appUser === null) {
        req.emailRejected = true;
      } else {
        req.appUser = appUser;
      }
      next();
    })
    .catch(next);
}

/** Blocks users whose account has not been approved by an admin yet. */
export function requireApproved(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (req.appUser?.status !== "approved") {
    res.status(403).json({
      error: "Your account is awaiting approval by an administrator.",
      code: "PENDING_APPROVAL",
    });
    return;
  }
  next();
}

export function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (req.appUser?.status !== "approved" || req.appUser?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
