import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import {
  ListUsersResponse,
  ApproveUserParams,
  ApproveUserResponse,
  SetUserRoleParams,
  SetUserRoleBody,
  SetUserRoleResponse,
  RemoveUserParams,
} from "@workspace/api-zod";
import {
  requireAuth,
  requireApproved,
  requireAdmin,
  invalidateAppUserCache,
  type AuthedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(requireAuth, requireApproved, requireAdmin);

function serializeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
  };
}

router.get("/admin/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(usersTable)
    .orderBy(desc(usersTable.createdAt));
  res.json(ListUsersResponse.parse(rows.map(serializeUser)));
});

router.post("/admin/users/:id/approve", async (req, res): Promise<void> => {
  const params = ApproveUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [user] = await db
    .update(usersTable)
    .set({ status: "approved" })
    .where(eq(usersTable.id, params.data.id))
    .returning();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  invalidateAppUserCache(user.clerkUserId);
  res.json(ApproveUserResponse.parse(serializeUser(user)));
});

router.post("/admin/users/:id/role", async (req: AuthedRequest, res): Promise<void> => {
  const params = SetUserRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetUserRoleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [target] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, params.data.id));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (
    target.clerkUserId === req.userId &&
    body.data.role === "member"
  ) {
    res.status(400).json({
      error: "You can't remove your own admin access.",
    });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ role: body.data.role })
    .where(eq(usersTable.id, params.data.id))
    .returning();
  invalidateAppUserCache(user!.clerkUserId);
  res.json(SetUserRoleResponse.parse(serializeUser(user!)));
});

router.delete("/admin/users/:id", async (req: AuthedRequest, res): Promise<void> => {
  const params = RemoveUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [target] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, params.data.id));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (target.clerkUserId === req.userId) {
    res.status(400).json({ error: "You can't remove your own account." });
    return;
  }

  // Remove from Clerk first so they can no longer sign in; tolerate the
  // account already being gone from Clerk.
  try {
    await clerkClient.users.deleteUser(target.clerkUserId);
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status !== 404) {
      res.status(502).json({
        error: "Could not remove the user's login account. Try again.",
      });
      return;
    }
  }

  await db.delete(usersTable).where(eq(usersTable.id, target.id));
  invalidateAppUserCache(target.clerkUserId);
  res.sendStatus(204);
});

export default router;
