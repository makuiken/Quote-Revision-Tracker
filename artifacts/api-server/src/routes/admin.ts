import { Router, type IRouter } from "express";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import {
  db,
  usersTable,
  fieldOptionsTable,
  manufacturerPacketsTable,
  manufacturerRedactionTemplatesTable,
  type ManufacturerRedactionTemplatePage,
} from "@workspace/db";
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
  DeleteDependentFieldOptionsQueryParams,
  ClearFieldDependencyParams,
  ApproveUserParams,
  ApproveUserResponse,
  SetUserRoleParams,
  SetUserRoleBody,
  SetUserRoleResponse,
  RemoveUserParams,
  ListManufacturerRedactionTemplatesResponse,
  CreateManufacturerRedactionTemplateBody,
  CreateManufacturerRedactionTemplateResponse,
  UpdateManufacturerRedactionTemplateParams,
  UpdateManufacturerRedactionTemplateBody,
  UpdateManufacturerRedactionTemplateResponse,
  DeleteManufacturerRedactionTemplateParams,
  ReplaceManufacturerRedactionTemplateFromPacketParams,
  ReplaceManufacturerRedactionTemplateFromPacketBody,
  ReplaceManufacturerRedactionTemplateFromPacketResponse,
} from "@workspace/api-zod";
import {
  requireAuth,
  requireApproved,
  requireAdmin,
  getUserProfile,
  invalidateAppUserCache,
  OWNER_EMAIL,
  type AuthedRequest,
} from "../middlewares/requireAuth";
import { canonicalManufacturer } from "../lib/packets/templates";

const router: IRouter = Router();

function serializeRedactionTemplate(template: typeof manufacturerRedactionTemplatesTable.$inferSelect) {
  return {
    id: template.id,
    manufacturer: template.manufacturer,
    manufacturerCanonical: template.manufacturerCanonical,
    productType: template.productType,
    name: template.name,
    active: template.active,
    pages: template.pages,
    createdById: template.createdById,
    createdByName: template.createdByName,
    updatedById: template.updatedById,
    updatedByName: template.updatedByName,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function templatePagesFromPacket(
  packet: typeof manufacturerPacketsTable.$inferSelect,
): ManufacturerRedactionTemplatePage[] | string {
  if (!packet.manufacturer || !packet.productType || !packet.analysis || !packet.manualRedactions) {
    return "The packet must have an explicit manufacturer, product type, analysis, and manual redactions.";
  }
  const pages: ManufacturerRedactionTemplatePage[] = [];
  const analyzedPageNumbers = new Set(packet.analysis.map((page) => String(page.pageNumber)));
  if (Object.keys(packet.manualRedactions).some((pageNumber) => !analyzedPageNumbers.has(pageNumber))) {
    return "Manual redactions must refer only to analyzed packet pages.";
  }
  let boxCount = 0;
  for (const analysisPage of packet.analysis) {
    const rects = packet.manualRedactions[String(analysisPage.pageNumber)] ?? [];
    boxCount += rects.length;
    if (rects.some((rect) =>
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width > analysisPage.width ||
      rect.y + rect.height > analysisPage.height
    )) {
      return "Manual redactions must be finite and inside analyzed page bounds.";
    }
    pages.push({
      pageNumber: analysisPage.pageNumber,
      width: analysisPage.width,
      height: analysisPage.height,
      rects,
    });
  }
  if (boxCount === 0) return "The packet must contain at least one manual redaction box.";
  return pages;
}

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

// ---------- Manufacturer redaction templates ----------

router.get("/admin/manufacturer-redaction-templates", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(manufacturerRedactionTemplatesTable)
    .orderBy(desc(manufacturerRedactionTemplatesTable.updatedAt));
  res.json(ListManufacturerRedactionTemplatesResponse.parse(rows.map(serializeRedactionTemplate)));
});

async function saveTemplateFromPacket(
  req: AuthedRequest,
  quoteId: number,
  packetId: number,
  name: string,
  active: boolean | undefined,
  existingId?: number,
) {
  const profile = await getUserProfile(req.userId!);
  return db.transaction(async (tx) => {
    const [packet] = await tx
      .select()
      .from(manufacturerPacketsTable)
      .where(and(eq(manufacturerPacketsTable.id, packetId), eq(manufacturerPacketsTable.quoteId, quoteId)));
    if (!packet) return { kind: "packetNotFound" as const };
    const pages = templatePagesFromPacket(packet);
    if (typeof pages === "string") return { kind: "invalidPacket" as const, error: pages };
    const manufacturer = packet.manufacturer!.trim().replace(/\s+/g, " ");
    const manufacturerCanonical = canonicalManufacturer(manufacturer);
    const duplicate = await tx
      .select()
      .from(manufacturerRedactionTemplatesTable)
      .where(
        and(
          eq(manufacturerRedactionTemplatesTable.manufacturerCanonical, manufacturerCanonical),
          eq(manufacturerRedactionTemplatesTable.productType, packet.productType!),
        ),
      )
      .limit(1);
    if (existingId === undefined && duplicate.length > 0) {
      return { kind: "duplicate" as const };
    }
    if (existingId !== undefined && (!duplicate[0] || duplicate[0].id !== existingId)) {
      return { kind: "keyChanged" as const };
    }
    const values = {
      manufacturer,
      manufacturerCanonical,
      productType: packet.productType!,
      name: name.trim(),
      pages,
      ...(active === undefined ? {} : { active }),
      updatedById: req.userId!,
      updatedByName: profile.name,
    };
    const [saved] = existingId === undefined
      ? await tx.insert(manufacturerRedactionTemplatesTable).values({
          ...values,
          active: active ?? true,
          createdById: req.userId!,
          createdByName: profile.name,
        }).onConflictDoNothing({
          target: [
            manufacturerRedactionTemplatesTable.manufacturerCanonical,
            manufacturerRedactionTemplatesTable.productType,
          ],
        }).returning()
      : await tx.update(manufacturerRedactionTemplatesTable)
          .set(values)
          .where(eq(manufacturerRedactionTemplatesTable.id, existingId))
          .returning();
    return saved
      ? { kind: "ok" as const, template: saved }
      : existingId === undefined
        ? { kind: "duplicate" as const }
        : { kind: "notFound" as const };
  });
}

router.post("/admin/manufacturer-redaction-templates", async (req: AuthedRequest, res): Promise<void> => {
  const body = CreateManufacturerRedactionTemplateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!body.data.name.trim()) {
    res.status(400).json({ error: "Template name must not be blank." });
    return;
  }
  const result = await saveTemplateFromPacket(
    req,
    body.data.quoteId,
    body.data.packetId,
    body.data.name,
    body.data.active,
  );
  if (result.kind === "packetNotFound") {
    res.status(404).json({ error: "Analyzed packet not found." });
    return;
  }
  if (result.kind === "invalidPacket" || result.kind === "duplicate") {
    res.status(result.kind === "duplicate" ? 409 : 400).json({
      error: result.kind === "duplicate"
        ? "A template already exists for this manufacturer and product type."
        : result.error,
    });
    return;
  }
  res.status(201).json(CreateManufacturerRedactionTemplateResponse.parse(serializeRedactionTemplate(result.template!)));
});

router.put("/admin/manufacturer-redaction-templates/:id/from-packet", async (req: AuthedRequest, res): Promise<void> => {
  const params = ReplaceManufacturerRedactionTemplateFromPacketParams.safeParse(req.params);
  const body = ReplaceManufacturerRedactionTemplateFromPacketBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." });
    return;
  }
  if (!body.data.name.trim()) {
    res.status(400).json({ error: "Template name must not be blank." });
    return;
  }
  const result = await saveTemplateFromPacket(
    req,
    body.data.quoteId,
    body.data.packetId,
    body.data.name,
    body.data.active,
    params.data.id,
  );
  if (result.kind === "packetNotFound" || result.kind === "notFound") {
    res.status(404).json({ error: "Template or analyzed packet not found." });
    return;
  }
  if (result.kind === "keyChanged") {
    res.status(400).json({ error: "The replacement packet must have the same manufacturer and product type." });
    return;
  }
  if (result.kind === "invalidPacket") {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(ReplaceManufacturerRedactionTemplateFromPacketResponse.parse(serializeRedactionTemplate(result.template!)));
});

router.patch("/admin/manufacturer-redaction-templates/:id", async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdateManufacturerRedactionTemplateParams.safeParse(req.params);
  const body = UpdateManufacturerRedactionTemplateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message ?? "Invalid request body." });
    return;
  }
  if (body.data.name !== undefined && !body.data.name.trim()) {
    res.status(400).json({ error: "Template name must not be blank." });
    return;
  }
  const profile = await getUserProfile(req.userId!);
  const [updated] = await db.update(manufacturerRedactionTemplatesTable).set({
    ...(body.data.name === undefined ? {} : { name: body.data.name.trim() }),
    ...(body.data.active === undefined ? {} : { active: body.data.active }),
    updatedById: req.userId!,
    updatedByName: profile.name,
  }).where(eq(manufacturerRedactionTemplatesTable.id, params.data.id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Template not found." });
    return;
  }
  res.json(UpdateManufacturerRedactionTemplateResponse.parse(serializeRedactionTemplate(updated)));
});

router.delete("/admin/manufacturer-redaction-templates/:id", async (req, res): Promise<void> => {
  const params = DeleteManufacturerRedactionTemplateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(manufacturerRedactionTemplatesTable)
    .where(eq(manufacturerRedactionTemplatesTable.id, params.data.id))
    .returning({ id: manufacturerRedactionTemplatesTable.id });
  if (!deleted) {
    res.status(404).json({ error: "Template not found." });
    return;
  }
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
          fieldOptionsTable.parentField,
          fieldOptionsTable.parentValue,
          fieldOptionsTable.grandField,
          fieldOptionsTable.grandValue,
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
        grandField: row!.grandField,
        grandValue: row!.grandValue,
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

// Valid spec field keys per category (mirrors the quote form's field
// definitions) so dependencies can only reference real sibling fields.
const CATEGORY_FIELD_KEYS: Record<string, readonly string[]> = {
  window: [
    "brand",
    "series",
    "exteriorColor",
    "interiorColor",
    "jambDepth",
    "dividedLites",
    "hardwareFinish",
    "screenColor",
  ],
  interiorDoor: ["brand", "seriesStyle", "materialSpecies", "jambDepth", "hardwareFinish"],
  exteriorDoor: [
    "brand",
    "seriesStyle",
    "materialSpecies",
    "exteriorColor",
    "interiorFinish",
    "jambDepth",
    "hardwareFinish",
    "glassLiteOptions",
    "lockPrep",
  ],
};

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
    const grandField = (body.data.grandField ?? "").trim();
    const grandValue = (body.data.grandValue ?? "").trim();
    if (!parentField || !parentValue) {
      res.status(400).json({ error: "parentField and parentValue are required" });
      return;
    }
    if ((grandField === "") !== (grandValue === "")) {
      res.status(400).json({ error: "grandField and grandValue must be provided together" });
      return;
    }
    if (parentField === params.data.field || grandField === params.data.field) {
      res.status(400).json({ error: "A field cannot depend on itself" });
      return;
    }
    if (grandField && grandField === parentField) {
      res.status(400).json({ error: "grandField must differ from parentField" });
      return;
    }
    // The target and its ancestors must be real fields in this category.
    const validFields = CATEGORY_FIELD_KEYS[params.data.category] ?? [];
    for (const f of [params.data.field, parentField, grandField].filter(Boolean)) {
      if (!validFields.includes(f)) {
        res.status(400).json({ error: `Unknown field "${f}" for this category` });
        return;
      }
    }
    const values = dedupeValues(body.data.values);
    if (values.length === 0) {
      res.status(400).json({ error: "values must contain at least one option" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      // Serialize all dependency-chain reads/writes per category so a
      // concurrent change to another field's chain (e.g. the parent's) can't
      // race this validation.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`field_options:${params.data.category}`}))`,
      );

      // The declared hierarchy must match reality: if the parent field itself
      // has a dependency, grandField must be that field; otherwise no grand
      // scope is allowed. Chains are capped at two levels, so a parent that
      // is itself two-level (has a grandparent) cannot be depended on — that
      // would need a third ancestor the data model can't represent.
      const [parentDep] = await tx
        .select({
          parentField: fieldOptionsTable.parentField,
          grandField: fieldOptionsTable.grandField,
        })
        .from(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.field, parentField),
            ne(fieldOptionsTable.parentValue, ""),
          ),
        )
        .limit(1);
      if (parentDep?.grandField) {
        return {
          status: 400 as const,
          error: `"${parentField}" already depends on "${parentDep.parentField}" and "${parentDep.grandField}" — chains deeper than two levels aren't supported. Pick a different field to depend on.`,
        };
      }
      const expectedGrand = parentDep?.parentField ?? "";
      if (expectedGrand === params.data.field) {
        return {
          status: 400 as const,
          error: `"${parentField}" depends on "${params.data.field}" — that would create a circular dependency.`,
        };
      }

      // Full cycle detection: apply the proposed edge to the category's
      // dependency graph and walk upward from the parent — if the walk
      // reaches the target field, the edge closes a cycle.
      const edgeRows = await tx
        .selectDistinct({
          field: fieldOptionsTable.field,
          parentField: fieldOptionsTable.parentField,
        })
        .from(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            ne(fieldOptionsTable.parentValue, ""),
          ),
        );
      const parentOf = new Map<string, string>();
      for (const e of edgeRows) parentOf.set(e.field, e.parentField);
      parentOf.set(params.data.field, parentField);
      let cursor: string | undefined = parentField;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === params.data.field) {
          return {
            status: 400 as const,
            error: `Depending on "${parentField}" would create a circular dependency chain.`,
          };
        }
        seen.add(cursor);
        cursor = parentOf.get(cursor);
      }
      if (grandField !== expectedGrand) {
        return {
          status: 400 as const,
          error: expectedGrand
            ? `"${parentField}" depends on "${expectedGrand}", so grandField must be "${expectedGrand}"`
            : `"${parentField}" has no dependency, so grandField must be omitted`,
        };
      }

      // Changing this field's chain must not orphan fields that depend on
      // it: their stored grandField must keep matching this field's parent.
      const dependents = await tx
        .select({
          field: fieldOptionsTable.field,
          grandField: fieldOptionsTable.grandField,
        })
        .from(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.parentField, params.data.field),
            ne(fieldOptionsTable.parentValue, ""),
          ),
        );
      const orphaned = [...new Set(
        dependents.filter((d) => d.grandField !== parentField).map((d) => d.field),
      )];
      if (orphaned.length > 0) {
        return {
          status: 409 as const,
          error: `Other fields (${orphaned.join(", ")}) depend on "${params.data.field}". Remove their dependency first, then change this field's dependency.`,
        };
      }

      // A field has one dependency chain (parentField, and optionally
      // grandField). Changing the chain deletes every list scoped to the old
      // chain — that's destructive, so it requires explicit acknowledgment.
      const conflicting = await tx
        .select({
          parentField: fieldOptionsTable.parentField,
          parentValue: fieldOptionsTable.parentValue,
          grandField: fieldOptionsTable.grandField,
        })
        .from(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.field, params.data.field),
            ne(fieldOptionsTable.parentValue, ""),
          ),
        );
      const outdated = conflicting.filter(
        (r) => r.parentField !== parentField || r.grandField !== grandField,
      );
      if (outdated.length > 0 && body.data.replaceExisting !== true) {
        return {
          status: 409 as const,
          error: `Saving would change this field's dependency and delete ${outdated.length} existing option list${outdated.length === 1 ? "" : "s"} (${outdated
            .slice(0, 5)
            .map((r) => r.parentValue)
            .join(", ")}${outdated.length > 5 ? ", …" : ""}). Confirm to replace.`,
        };
      }
      if (outdated.length > 0) {
        await tx
          .delete(fieldOptionsTable)
          .where(
            and(
              eq(fieldOptionsTable.category, params.data.category),
              eq(fieldOptionsTable.field, params.data.field),
              ne(fieldOptionsTable.parentValue, ""),
              or(
                ne(fieldOptionsTable.parentField, parentField),
                ne(fieldOptionsTable.grandField, grandField),
              ),
            ),
          );
      }

      // Case-insensitive scope match: "Andersen" and "andersen" are the same
      // list. Update the existing row (keeping its stored casing) if one
      // matches; otherwise insert.
      const [existing] = await tx
        .select({ id: fieldOptionsTable.id })
        .from(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.field, params.data.field),
            eq(fieldOptionsTable.parentField, parentField),
            sql`lower(${fieldOptionsTable.parentValue}) = lower(${parentValue})`,
            eq(fieldOptionsTable.grandField, grandField),
            sql`lower(${fieldOptionsTable.grandValue}) = lower(${grandValue})`,
          ),
        )
        .limit(1);
      const [saved] = existing
        ? await tx
            .update(fieldOptionsTable)
            .set({ values, updatedAt: new Date() })
            .where(eq(fieldOptionsTable.id, existing.id))
            .returning()
        : await tx
            .insert(fieldOptionsTable)
            .values({
              category: params.data.category,
              field: params.data.field,
              parentField,
              parentValue,
              grandField,
              grandValue,
              values,
            })
            .returning();
      return { status: 200 as const, row: saved! };
    });

    if (result.status !== 200) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const row = result.row;

    res.json(
      SetDependentFieldOptionsResponse.parse({
        category: row.category,
        field: row.field,
        parentField: row.parentField,
        parentValue: row.parentValue,
        grandField: row.grandField,
        grandValue: row.grandValue,
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
    const query = DeleteDependentFieldOptionsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    // Full scope identifies exactly one list: one-level lists have '' in
    // grand_value; two-level lists must pass their grandValue. Values match
    // case-insensitively, mirroring how lists are saved and looked up.
    const result = await db.transaction(async (tx) => {
      // Same per-category lock as chain mutations: deleting the last scoped
      // list removes this field's effective dependency, which must not race
      // or bypass the dependent checks.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`field_options:${params.data.category}`}))`,
      );
      const scopeMatch = and(
        eq(fieldOptionsTable.category, params.data.category),
        eq(fieldOptionsTable.field, params.data.field),
        ne(fieldOptionsTable.parentValue, ""),
        sql`lower(${fieldOptionsTable.parentValue}) = lower(${params.data.parentValue})`,
        sql`lower(${fieldOptionsTable.grandValue}) = lower(${query.data.grandValue ?? ""})`,
      );
      // Would this delete remove the field's last scoped list? If so, the
      // field's dependency disappears — refuse while other fields still have
      // two-level lists chained through it.
      const remaining = await tx
        .select({ id: fieldOptionsTable.id })
        .from(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.field, params.data.field),
            ne(fieldOptionsTable.parentValue, ""),
            sql`NOT (lower(${fieldOptionsTable.parentValue}) = lower(${params.data.parentValue}) AND lower(${fieldOptionsTable.grandValue}) = lower(${query.data.grandValue ?? ""}))`,
          ),
        )
        .limit(1);
      if (remaining.length === 0) {
        const dependents = await tx
          .select({ field: fieldOptionsTable.field })
          .from(fieldOptionsTable)
          .where(
            and(
              eq(fieldOptionsTable.category, params.data.category),
              eq(fieldOptionsTable.parentField, params.data.field),
              ne(fieldOptionsTable.parentValue, ""),
              ne(fieldOptionsTable.grandField, ""),
            ),
          );
        const orphaned = [...new Set(dependents.map((d) => d.field))];
        if (orphaned.length > 0) {
          return {
            status: 409 as const,
            error: `This is the last "${params.data.field}" list, and other fields (${orphaned.join(", ")}) have lists scoped per its dependency. Remove their dependency first.`,
          };
        }
      }
      await tx.delete(fieldOptionsTable).where(scopeMatch);
      return { status: 204 as const };
    });
    if (result.status !== 204) {
      res.status(result.status).json({ error: result.error });
      return;
    }
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
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`field_options:${params.data.category}`}))`,
      );
      // Removing this field's dependency would leave two-level lists of
      // fields that depend on it pointing at a grandparent that no longer
      // exists in the chain.
      const dependents = await tx
        .select({ field: fieldOptionsTable.field })
        .from(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.parentField, params.data.field),
            ne(fieldOptionsTable.parentValue, ""),
            ne(fieldOptionsTable.grandField, ""),
          ),
        );
      const orphaned = [...new Set(dependents.map((d) => d.field))];
      if (orphaned.length > 0) {
        return {
          status: 409 as const,
          error: `Other fields (${orphaned.join(", ")}) have lists scoped per this field's dependency. Remove their dependency first.`,
        };
      }
      await tx
        .delete(fieldOptionsTable)
        .where(
          and(
            eq(fieldOptionsTable.category, params.data.category),
            eq(fieldOptionsTable.field, params.data.field),
            ne(fieldOptionsTable.parentValue, ""),
          ),
        );
      return { status: 204 as const };
    });
    if (result.status !== 204) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.sendStatus(204);
  },
);

export default router;
