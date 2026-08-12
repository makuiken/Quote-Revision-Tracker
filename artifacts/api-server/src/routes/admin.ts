import { Router, type IRouter } from "express";
import { and, desc, eq, ne } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, usersTable, fieldOptionsTable } from "@workspace/db";
import {
  ListUsersResponse,
  SetFieldOptionsParams,
  SetFieldOptionsBody,
  SetFieldOptionsResponse,
  DeleteFieldOptionsParams,
  SetDependentFieldOptionsParams,
  SetDependentFieldOptionsBody,
  SetDependentFieldOptionsResponse,
  DeleteDependentFieldOptionsParams,
  ClearFieldDependencyParams,
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
  OWNER_EMAIL,
  type AuthedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

// Scope the guards to /admin paths only — a bare router.use() would run them
// for every API request passing through this router and block non-admins
// from the whole API.
router.use("/admin", requireAuth, requireApproved, requireAdmin);

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
  if (
    target.email?.toLowerCase() === OWNER_EMAIL &&
    body.data.role === "member"
  ) {
    res.status(400).json({
      error: "This account is the permanent owner and must stay an admin.",
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
  if (target.email?.toLowerCase() === OWNER_EMAIL) {
    res.status(400).json({
      error: "This account is the permanent owner and can't be removed.",
    });
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

// ---------- Field option lists (dropdowns for quote spec fields) ----------
// Editing option lists never touches existing quotes: quote specs store plain
// text values, so signatures and historical data are unaffected.

router.put(
  "/admin/field-options/:category/:field",
  async (req, res): Promise<void> => {
    const params = SetFieldOptionsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = SetFieldOptionsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const values = dedupeValues(body.data.values);

    const [row] = await db
      .insert(fieldOptionsTable)
      .values({
        category: params.data.category,
        field: params.data.field,
        parentField: "",
        parentValue: "",
        values,
      })
      .onConflictDoUpdate({
        target: [
          fieldOptionsTable.category,
          fieldOptionsTable.field,
          fieldOptionsTable.parentValue,
        ],
        set: { values, updatedAt: new Date() },
      })
      .returning();

    res.json(
      SetFieldOptionsResponse.parse({
        category: row!.category,
        field: row!.field,
        parentField: row!.parentField,
        parentValue: row!.parentValue,
        values: row!.values,
      }),
    );
  },
);

router.delete(
  "/admin/field-options/:category/:field",
  async (req, res): Promise<void> => {
    const params = DeleteFieldOptionsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    // Only removes the flat list; parent-scoped (dependent) lists are managed
    // via the /dependent and /dependency endpoints.
    await db
      .delete(fieldOptionsTable)
      .where(
        and(
          eq(fieldOptionsTable.category, params.data.category),
          eq(fieldOptionsTable.field, params.data.field),
          eq(fieldOptionsTable.parentValue, ""),
        ),
      );
    res.sendStatus(204);
  },
);

// Dedupe while preserving order; trim whitespace.
function dedupeValues(raw: string[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of raw) {
    const v = item.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    values.push(v);
  }
  return values;
}

// ---------- Dependent (parent-scoped) option lists ----------
// One level only: `field` in a category depends on sibling `parentField`;
// each parentValue gets its own option list. Quote forms filter suggestions
// by the currently selected parent value. Existing quotes are never touched.

router.put(
  "/admin/field-options/:category/:field/dependent",
  async (req, res): Promise<void> => {
    const params = SetDependentFieldOptionsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = SetDependentFieldOptionsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const parentField = body.data.parentField.trim();
    const parentValue = body.data.parentValue.trim();
    if (!parentField || !parentValue) {
      res.status(400).json({ error: "parentField and parentValue are required" });
      return;
    }
    if (parentField === params.data.field) {
      res.status(400).json({ error: "A field cannot depend on itself" });
      return;
    }
    const values = dedupeValues(body.data.values);
    if (values.length === 0) {
      res.status(400).json({ error: "values must contain at least one option" });
      return;
    }

    const row = await db.transaction(async (tx) => {
      // A field has at most one parent: saving under a new parentField
      // replaces the previous dependency entirely.
      await tx
        .delete(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.field, params.data.field),
            ne(fieldOptionsTable.parentValue, ""),
            ne(fieldOptionsTable.parentField, parentField),
          ),
        );
      const [saved] = await tx
        .insert(fieldOptionsTable)
        .values({
          category: params.data.category,
          field: params.data.field,
          parentField,
          parentValue,
          values,
        })
        .onConflictDoUpdate({
          target: [
            fieldOptionsTable.category,
            fieldOptionsTable.field,
            fieldOptionsTable.parentValue,
          ],
          set: { parentField, values, updatedAt: new Date() },
        })
        .returning();
      return saved!;
    });

    res.json(
      SetDependentFieldOptionsResponse.parse({
        category: row.category,
        field: row.field,
        parentField: row.parentField,
        parentValue: row.parentValue,
        values: row.values,
      }),
    );
  },
);

router.delete(
  "/admin/field-options/:category/:field/dependent/:parentValue",
  async (req, res): Promise<void> => {
    const params = DeleteDependentFieldOptionsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(fieldOptionsTable)
      .where(
        and(
          eq(fieldOptionsTable.category, params.data.category),
          eq(fieldOptionsTable.field, params.data.field),
          eq(fieldOptionsTable.parentValue, params.data.parentValue),
        ),
      );
    res.sendStatus(204);
  },
);

router.delete(
  "/admin/field-options/:category/:field/dependency",
  async (req, res): Promise<void> => {
    const params = ClearFieldDependencyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(fieldOptionsTable)
      .where(
        and(
          eq(fieldOptionsTable.category, params.data.category),
          eq(fieldOptionsTable.field, params.data.field),
          ne(fieldOptionsTable.parentValue, ""),
        ),
      );
    res.sendStatus(204);
  },
);

export default router;
