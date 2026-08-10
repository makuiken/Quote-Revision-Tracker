import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";

export interface AuthedRequest extends Request {
  userId?: string;
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
  next();
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
