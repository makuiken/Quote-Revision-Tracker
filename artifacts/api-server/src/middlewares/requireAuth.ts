import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, usersTable, type AppUser } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export interface AuthedRequest extends Request {
  userId?: string;
  appUser?: AppUser;
}

const nameCache = new Map<string, { name: string; email: string | null }>();

export async function getUserProfile(
  userId: string,
): Promise<{ name: string; email: string | null }> {
  const cached = nameCache.get(userId);
  if (cached) return cached;

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
    nameCache.set(userId, profile);
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

async function getOrCreateAppUser(clerkUserId: string): Promise<AppUser> {
  const cached = appUserCache.get(clerkUserId);
  if (cached && cached.expires > Date.now()) return cached.user;

  let [row] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));

  if (!row) {
    const profile = await getUserProfile(clerkUserId);
    // Bootstrap: if no admin exists yet, the first user in becomes an
    // approved admin so the team is never locked out. An advisory lock
    // makes the check-then-insert atomic so concurrent first sign-ups
    // can't both become admins.
    row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(815001)`);
      const [{ adminCount }] = (await tx
        .select({ adminCount: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(eq(usersTable.role, "admin"))) as [{ adminCount: number }];
      const isBootstrap = adminCount === 0;
      const inserted = await tx
        .insert(usersTable)
        .values({
          clerkUserId,
          name: profile.name,
          email: profile.email,
          role: isBootstrap ? "admin" : "member",
          status: isBootstrap ? "approved" : "pending",
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
      req.appUser = appUser;
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
