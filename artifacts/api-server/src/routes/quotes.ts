import { createHash, randomBytes } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import {
  and,
  arrayContains,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  quotesTable,
  revisionsTable,
  signoffsTable,
  revisionDraftsTable,
  attachmentsTable,
  usersTable,
  fieldOptionsTable,
} from "@workspace/db";
import {
  GetCurrentUserResponse,
  ListFieldOptionsResponse,
  ListTeamMembersResponse,
  GetShareInfoResponse,
  ListQuotesQueryParams,
  ListQuotesResponse,
  CreateQuoteBody,
  CreateQuoteResponse,
  GetQuoteParams,
  GetQuoteResponse,
  UpdateQuoteParams,
  UpdateQuoteBody,
  UpdateQuoteResponse,
  ArchiveQuoteParams,
  ArchiveQuoteBody,
  ArchiveQuoteResponse,
  UnarchiveQuoteParams,
  UnarchiveQuoteResponse,
  DeleteQuoteParams,
  ListRevisionsParams,
  ListRevisionsResponse,
  CreateRevisionParams,
  CreateRevisionBody,
  CreateRevisionResponse,
  GetRevisionDraftParams,
  GetRevisionDraftResponse,
  SaveRevisionDraftParams,
  SaveRevisionDraftBody,
  SaveRevisionDraftResponse,
  DiscardRevisionDraftParams,
  PublishRevisionDraftBody,
  PublishRevisionDraftParams,
  PublishRevisionDraftResponse,
  SetRevisionSignoffExclusionParams,
  SetRevisionSignoffExclusionBody,
  SetRevisionSignoffExclusionResponse,
  CreateShareLinkParams,
  CreateShareLinkResponse,
  GetSignoffParams,
  SaveSignoffParams,
  SaveSignoffBody,
  SaveSignoffResponse,
  ClearSignoffParams,
  ListAttachmentsParams,
  ListAttachmentsResponse,
  CreateAttachmentParams,
  CreateAttachmentBody,
  CreateAttachmentResponse,
  DeleteAttachmentParams,
  GetDashboardSummaryResponse,
  GetRecentActivityQueryParams,
  GetRecentActivityResponse,
} from "@workspace/api-zod";
import {
  requireAuth,
  requireApproved,
  getUserProfile,
  type AuthedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(requireAuth);

// /me must stay reachable for pending users so the app can show them an
// "awaiting approval" screen; everything below requireApproved is gated.
router.get("/me", async (req: AuthedRequest, res): Promise<void> => {
  const profile = await getUserProfile(req.userId!);
  res.json(
    GetCurrentUserResponse.parse({
      id: req.userId,
      name: req.appUser?.name ?? profile.name,
      email: req.appUser?.email ?? profile.email,
      role: req.appUser?.role ?? "member",
      status: req.emailRejected
        ? "rejected"
        : (req.appUser?.status ?? "pending"),
    }),
  );
});

router.use(requireApproved);

router.get("/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      userId: usersTable.clerkUserId,
      name: usersTable.name,
    })
    .from(usersTable)
    .where(eq(usersTable.status, "approved"))
    .orderBy(usersTable.name);
  res.json(ListTeamMembersResponse.parse(rows));
});

// Readable by any approved user so the quote forms can render dropdowns;
// writes are admin-only and live on the /admin router.
router.get("/field-options", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      category: fieldOptionsTable.category,
      field: fieldOptionsTable.field,
      parentField: fieldOptionsTable.parentField,
      parentValue: fieldOptionsTable.parentValue,
      grandField: fieldOptionsTable.grandField,
      grandValue: fieldOptionsTable.grandValue,
      values: fieldOptionsTable.values,
    })
    .from(fieldOptionsTable)
    .orderBy(
      fieldOptionsTable.category,
      fieldOptionsTable.field,
      fieldOptionsTable.grandValue,
      fieldOptionsTable.parentValue,
    );
  res.json(ListFieldOptionsResponse.parse(rows));
});

type QuoteRow = typeof quotesTable.$inferSelect;

export async function quoteStats(quoteIds: number[]) {
  if (quoteIds.length === 0)
    return new Map<
      number,
      { revisionCount: number; lastActivityAt: Date | null; signed: boolean }
    >();

  const revStats = await db
    .select({
      quoteId: revisionsTable.quoteId,
      count: sql<number>`count(*)::int`,
      last: sql<Date>`max(${revisionsTable.createdAt})`,
    })
    .from(revisionsTable)
    .where(inArray(revisionsTable.quoteId, quoteIds))
    .groupBy(revisionsTable.quoteId);

  const signed = await db
    .select({ quoteId: signoffsTable.quoteId })
    .from(signoffsTable)
    .where(inArray(signoffsTable.quoteId, quoteIds));

  const map = new Map<
    number,
    { revisionCount: number; lastActivityAt: Date | null; signed: boolean }
  >();
  for (const id of quoteIds)
    map.set(id, { revisionCount: 0, lastActivityAt: null, signed: false });
  for (const r of revStats) {
    const entry = map.get(r.quoteId);
    if (entry) {
      entry.revisionCount = r.count;
      entry.lastActivityAt = r.last ? new Date(r.last) : null;
    }
  }
  for (const s of signed) {
    const entry = map.get(s.quoteId);
    if (entry) entry.signed = true;
  }
  return map;
}

export function serializeQuote(
  quote: QuoteRow,
  stats?: {
    revisionCount: number;
    lastActivityAt: Date | null;
    signed: boolean;
  },
) {
  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    customerName: quote.customerName,
    projectName: quote.projectName,
    jobAddress: quote.jobAddress,
    displayName: quote.projectName
      ? `${quote.customerName} - ${quote.projectName}`
      : quote.customerName,
    categories: quote.categories,
    specs: quote.specs ?? {},
    notes: quote.notes,
    createdById: quote.createdById,
    createdByName: quote.createdByName,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    revisionCount: stats?.revisionCount ?? 0,
    lastActivityAt: stats?.lastActivityAt ?? null,
    signed: stats?.signed ?? false,
    archived: quote.archivedAt !== null,
    archivedAt: quote.archivedAt,
    archiveReason: quote.archiveReason,
    archivedByName: quote.archivedByName,
  };
}

/**
 * Version of the static signoff document content (terms & conditions,
 * approval disclaimer, etc.). Bump whenever that boilerplate text changes so
 * already-open documents become stale and must be reloaded before signing.
 */
export const SIGNOFF_CONTENT_VERSION = 2;

/**
 * Opaque fingerprint of the signoff document content: the quote's last edit
 * plus the exact set of revisions shown to the signer, plus the static
 * content version. Signing requires the client to echo this back, so a
 * stale, already-open document can never be signed after the content changes.
 */
export function computeDocumentVersion(
  quote: Pick<QuoteRow, "updatedAt">,
  includedRevisions: Array<{ id: number }>,
): string {
  return createHash("sha1")
    .update(
      `v${SIGNOFF_CONTENT_VERSION}|${quote.updatedAt.getTime()}|${includedRevisions.map((r) => r.id).join(",")}`,
    )
    .digest("hex");
}

/**
 * Locks the quote row (SELECT ... FOR UPDATE) inside a transaction and returns
 * the current row. Every signoff-affecting mutation and both sign routes take
 * this lock, so version checks and content changes are fully serialized: a
 * signer can never race a concurrent edit/revision/exclusion.
 */
export async function lockQuoteRow(
  tx: Pick<typeof db, "select">,
  quoteId: number,
): Promise<QuoteRow | null> {
  const [quote] = await tx
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.id, quoteId))
    .for("update");
  return quote ?? null;
}

/** Loads the revisions currently shown on the signoff document (excluded ones omitted). */
export async function loadIncludedRevisions(
  tx: Pick<typeof db, "select">,
  quoteId: number,
) {
  return tx
    .select({ id: revisionsTable.id })
    .from(revisionsTable)
    .where(
      and(
        eq(revisionsTable.quoteId, quoteId),
        eq(revisionsTable.excludedFromSignoff, false),
      ),
    )
    .orderBy(revisionsTable.createdAt);
}

router.get("/share-info", async (_req, res): Promise<void> => {
  // Determine the app's publicly reachable origin for share links.
  // In production, REPLIT_DOMAINS holds the deployed domain(s);
  // in development it (or REPLIT_DEV_DOMAIN) holds the public dev domain.
  const domain =
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN;
  if (!domain) {
    res.status(500).json({ error: "Public domain is not configured" });
    return;
  }
  res.json(GetShareInfoResponse.parse({ publicOrigin: `https://${domain}` }));
});

router.get("/quotes", async (req, res): Promise<void> => {
  const query = ListQuotesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { search, status, category, createdById, offset, limit } = query.data;

  const conditions: SQL[] = [];

  if (search) {
    conditions.push(
      or(
        ilike(quotesTable.quoteNumber, `%${search}%`),
        ilike(quotesTable.customerName, `%${search}%`),
        ilike(quotesTable.projectName, `%${search}%`),
        ilike(quotesTable.jobAddress, `%${search}%`),
      )!,
    );
  }
  if (category) conditions.push(arrayContains(quotesTable.categories, [category]));
  if (createdById) conditions.push(eq(quotesTable.createdById, createdById));

  if (status === "archived") {
    conditions.push(isNotNull(quotesTable.archivedAt));
  } else if (status) {
    conditions.push(isNull(quotesTable.archivedAt));
  }
  // "signed" means a signoff record exists for the quote.
  const signedExists = exists(
    db
      .select({ one: sql`1` })
      .from(signoffsTable)
      .where(eq(signoffsTable.quoteId, quotesTable.id)),
  );
  if (status === "signed") conditions.push(signedExists);
  if (status === "awaiting") conditions.push(not(signedExists));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(quotesTable)
    .where(where);

  const rows = await db
    .select()
    .from(quotesTable)
    .where(where)
    .orderBy(desc(quotesTable.createdAt), desc(quotesTable.id))
    .limit(limit)
    .offset(offset);

  const stats = await quoteStats(rows.map((r) => r.id));
  res.json(
    ListQuotesResponse.parse({
      items: rows.map((r) => serializeQuote(r, stats.get(r.id))),
      total: countRow?.total ?? 0,
    }),
  );
});

router.post("/quotes", async (req: AuthedRequest, res): Promise<void> => {
  const parsed = CreateQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const profile = await getUserProfile(req.userId!);
  const [quote] = await db
    .insert(quotesTable)
    .values({
      quoteNumber: parsed.data.quoteNumber,
      customerName: parsed.data.customerName,
      projectName: parsed.data.projectName,
      jobAddress: parsed.data.jobAddress,
      categories: parsed.data.categories,
      specs: parsed.data.specs ?? {},
      notes: parsed.data.notes ?? null,
      createdById: req.userId!,
      createdByName: profile.name,
    })
    .returning();

  res.status(201).json(CreateQuoteResponse.parse(serializeQuote(quote!)));
});

/**
 * Normalizes revision category tags: dedupes and keeps only tags that are
 * among the quote's own categories. Empty/absent becomes null ("general/all").
 */
function sanitizeRevisionCategories(
  input: string[] | null | undefined,
  quote: Pick<QuoteRow, "categories">,
): string[] | null {
  if (!input || input.length === 0) return null;
  const allowed = new Set(quote.categories);
  const tags = [...new Set(input)].filter((t) => allowed.has(t));
  return tags.length > 0 ? tags : null;
}

/**
 * Archived quotes are read-only: no edits, revisions, attachments, share
 * links, or signatures until they are restored. Returns false (and responds
 * 400) when the quote is archived.
 */
function guardNotArchived(quote: QuoteRow, res: Response): boolean {
  if (quote.archivedAt) {
    res.status(400).json({
      error: "This quote is archived. Restore it to make changes.",
    });
    return false;
  }
  return true;
}

async function loadQuote(id: number, res: Response): Promise<QuoteRow | null> {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.id, id));
  if (!quote) {
    res.status(404).json({ error: "Quote not found" });
    return null;
  }
  return quote;
}

router.get("/quotes/:id", async (req, res): Promise<void> => {
  const params = GetQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;

  const revisions = await db
    .select()
    .from(revisionsTable)
    .where(eq(revisionsTable.quoteId, quote.id))
    .orderBy(revisionsTable.createdAt);

  const [signoff] = await db
    .select()
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, quote.id));

  const stats = await quoteStats([quote.id]);
  res.json(
    GetQuoteResponse.parse({
      quote: serializeQuote(quote, stats.get(quote.id)),
      revisions,
      signoff: signoff ?? null,
      documentVersion: computeDocumentVersion(
        quote,
        revisions.filter((r) => !r.excludedFromSignoff),
      ),
    }),
  );
});

router.patch("/quotes/:id", async (req: AuthedRequest, res): Promise<void> => {
  const params = UpdateQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateQuoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const before = await loadQuote(params.data.id, res);
  if (!before) return;
  if (!guardNotArchived(before, res)) return;

  const updates: Partial<QuoteRow> = {};
  const changed: string[] = [];
  // Category tags derived from which spec sections changed, used to
  // auto-tag the generated revision entry.
  const changedSpecCategories = new Set<string>();
  const SPEC_KEY_TO_CATEGORY: Record<string, string> = {
    window: "windows",
    door: "doors",
    interiorDoor: "interiorDoors",
    exteriorDoor: "exteriorDoors",
    trimDescription: "trim",
    millworkDescription: "millwork",
  };

  const fmtValue = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "(blank)";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "(blank)";
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  };

  const track = (label: string, key: keyof QuoteRow, value: unknown) => {
    if (value === undefined) return;
    (updates as Record<string, unknown>)[key] = value;
    if (JSON.stringify(value) !== JSON.stringify(before[key] ?? null))
      changed.push(`${label}: ${fmtValue(before[key])} → ${fmtValue(value)}`);
  };

  // Specs are nested (category → fields), so diff them field by field for a
  // readable log entry instead of dumping the whole object.
  const trackSpecs = (value: unknown) => {
    if (value === undefined) return;
    (updates as Record<string, unknown>).specs = value;
    const prev = (before.specs ?? {}) as Record<string, Record<string, unknown> | null | undefined>;
    const next = (value ?? {}) as Record<string, Record<string, unknown> | null | undefined>;
    for (const category of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const prevValue = prev[category];
      const nextValue = next[category];
      // Scalar spec fields (trim/millwork descriptions) diff as a whole.
      const isScalar =
        (prevValue !== undefined && prevValue !== null && typeof prevValue !== "object") ||
        (nextValue !== undefined && nextValue !== null && typeof nextValue !== "object");
      if (isScalar) {
        if (JSON.stringify(prevValue ?? null) !== JSON.stringify(nextValue ?? null)) {
          changed.push(`${category}: ${fmtValue(prevValue)} → ${fmtValue(nextValue)}`);
          const tag = SPEC_KEY_TO_CATEGORY[category];
          if (tag) changedSpecCategories.add(tag);
        }
        continue;
      }
      const prevFields = prevValue ?? {};
      const nextFields = nextValue ?? {};
      for (const field of new Set([...Object.keys(prevFields), ...Object.keys(nextFields)])) {
        const a = (prevFields as Record<string, unknown>)[field];
        const b = (nextFields as Record<string, unknown>)[field];
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
          changed.push(`${category} ${field}: ${fmtValue(a)} → ${fmtValue(b)}`);
          const tag = SPEC_KEY_TO_CATEGORY[category];
          if (tag) changedSpecCategories.add(tag);
        }
      }
    }
  };

  track("quote number", "quoteNumber", parsed.data.quoteNumber);
  track("customer name", "customerName", parsed.data.customerName);
  track("project name", "projectName", parsed.data.projectName);
  track("job address", "jobAddress", parsed.data.jobAddress);
  track("categories", "categories", parsed.data.categories);
  trackSpecs(parsed.data.specs);
  track("notes", "notes", parsed.data.notes);

  const profile = await getUserProfile(req.userId!);

  // Update, signoff invalidation, and the auto revision entry are atomic so
  // the register always matches the saved edit.
  const quote = await db.transaction(async (tx) => {
    // Take the quote-row lock first (shared discipline with the sign routes)
    // and re-validate state under the lock rather than trusting the
    // pre-transaction read.
    const current = await lockQuoteRow(tx, params.data.id);
    if (!current || current.archivedAt) return null;
    const [updated] = await tx
      .update(quotesTable)
      .set(updates)
      .where(eq(quotesTable.id, params.data.id))
      .returning();
    if (!updated) return null;

    // Any edit to the quote invalidates a previously captured customer
    // signoff: the signed document no longer reflects the current specs.
    await tx.delete(signoffsTable).where(eq(signoffsTable.quoteId, updated.id));

    // Log the edit in the revision register automatically.
    if (changed.length > 0) {
      await tx.insert(revisionsTable).values({
        quoteId: updated.id,
        authorId: req.userId!,
        authorName: profile.name,
        note: `Edited quote details:\n${changed.join("\n")}`,
        // Auto-tag with the categories whose specs changed (limited to the
        // quote's categories after the edit; empty means "general").
        categories: sanitizeRevisionCategories(
          [...changedSpecCategories],
          updated,
        ),
      });
    }
    return updated;
  });

  if (!quote) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }

  const stats = await quoteStats([quote.id]);
  res.json(UpdateQuoteResponse.parse(serializeQuote(quote, stats.get(quote.id))));
});

router.post(
  "/quotes/:id/archive",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = ArchiveQuoteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = ArchiveQuoteBody.safeParse(req.body);
    const reason = parsed.success ? parsed.data.reason.trim() : "";
    if (!reason) {
      res.status(400).json({ error: "A reason for archiving is required" });
      return;
    }

    const before = await loadQuote(params.data.id, res);
    if (!before) return;
    if (before.archivedAt) {
      res.status(400).json({ error: "Quote is already archived" });
      return;
    }

    const profile = await getUserProfile(req.userId!);

    // Archive + register entry are atomic so the log always matches. The
    // update is conditional on the quote still being active, so concurrent
    // archive requests cannot double-archive or double-log.
    const quote = await db.transaction(async (tx) => {
      await lockQuoteRow(tx, params.data.id);
      const [updated] = await tx
        .update(quotesTable)
        .set({
          archivedAt: new Date(),
          archiveReason: reason,
          archivedById: req.userId!,
          archivedByName: profile.name,
        })
        .where(
          and(eq(quotesTable.id, params.data.id), isNull(quotesTable.archivedAt)),
        )
        .returning();
      if (!updated) return null;

      // The archive entry appears in the revision log, so any existing
      // signature no longer covers what the signer reviewed — invalidate it.
      await tx.delete(signoffsTable).where(eq(signoffsTable.quoteId, updated.id));
      await tx.insert(revisionsTable).values({
        quoteId: updated.id,
        authorId: req.userId!,
        authorName: profile.name,
        note: `Archived quote. Reason: ${reason}`,
      });
      return updated;
    });

    if (!quote) {
      res.status(400).json({ error: "Quote is already archived" });
      return;
    }

    const stats = await quoteStats([quote.id]);
    res.json(
      ArchiveQuoteResponse.parse(serializeQuote(quote, stats.get(quote.id))),
    );
  },
);

router.post(
  "/quotes/:id/unarchive",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = UnarchiveQuoteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const before = await loadQuote(params.data.id, res);
    if (!before) return;
    if (!before.archivedAt) {
      res.status(400).json({ error: "Quote is not archived" });
      return;
    }

    const profile = await getUserProfile(req.userId!);

    const quote = await db.transaction(async (tx) => {
      await lockQuoteRow(tx, params.data.id);
      const [updated] = await tx
        .update(quotesTable)
        .set({
          archivedAt: null,
          archiveReason: null,
          archivedById: null,
          archivedByName: null,
        })
        .where(
          and(
            eq(quotesTable.id, params.data.id),
            isNotNull(quotesTable.archivedAt),
          ),
        )
        .returning();
      if (!updated) return null;

      // The restore entry appears in the revision log, so any existing
      // signature no longer covers what the signer reviewed — invalidate it.
      await tx.delete(signoffsTable).where(eq(signoffsTable.quoteId, updated.id));
      await tx.insert(revisionsTable).values({
        quoteId: updated.id,
        authorId: req.userId!,
        authorName: profile.name,
        note: "Restored quote from archive",
      });
      return updated;
    });

    if (!quote) {
      res.status(400).json({ error: "Quote is not archived" });
      return;
    }

    const stats = await quoteStats([quote.id]);
    res.json(
      UnarchiveQuoteResponse.parse(serializeQuote(quote, stats.get(quote.id))),
    );
  },
);

// Quote deletion is intentionally allowed for archived quotes: archiving
// makes a quote's *content* read-only, while deletion is a record-lifecycle
// action and the only way to permanently remove a record.
router.delete("/quotes/:id", async (req, res): Promise<void> => {
  const params = DeleteQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [quote] = await db
    .delete(quotesTable)
    .where(eq(quotesTable.id, params.data.id))
    .returning();

  if (!quote) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }
  res.sendStatus(204);
});

// ---------- Revision drafts ----------
// Private, per-user drafts of revision notes. Drafts live entirely outside
// the published revisions flow: they never appear in the revision log,
// signoff document, public share view, print log, or the document version
// hash, and saving/discarding one never touches signoff state.

router.get(
  "/quotes/:id/revision-draft",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = GetRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;

    const [draft] = await db
      .select()
      .from(revisionDraftsTable)
      .where(
        and(
          eq(revisionDraftsTable.quoteId, quote.id),
          eq(revisionDraftsTable.authorId, req.userId!),
        ),
      );

    res.json(GetRevisionDraftResponse.parse({ draft: draft ?? null }));
  },
);

router.put(
  "/quotes/:id/revision-draft",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = SaveRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SaveRevisionDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!parsed.data.note.trim()) {
      res.status(400).json({ error: "Draft cannot be empty." });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;
    if (!guardNotArchived(quote, res)) return;

    // Upsert: one resumable draft per user per quote.
    const [draft] = await db
      .insert(revisionDraftsTable)
      .values({
        quoteId: quote.id,
        authorId: req.userId!,
        note: parsed.data.note,
        categories: sanitizeRevisionCategories(parsed.data.categories, quote),
      })
      .onConflictDoUpdate({
        target: [revisionDraftsTable.quoteId, revisionDraftsTable.authorId],
        set: {
          note: parsed.data.note,
          categories: sanitizeRevisionCategories(parsed.data.categories, quote),
          updatedAt: new Date(),
        },
      })
      .returning();

    res.json(SaveRevisionDraftResponse.parse(draft));
  },
);

router.delete(
  "/quotes/:id/revision-draft",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = DiscardRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;

    await db
      .delete(revisionDraftsTable)
      .where(
        and(
          eq(revisionDraftsTable.quoteId, quote.id),
          eq(revisionDraftsTable.authorId, req.userId!),
        ),
      );

    res.sendStatus(204);
  },
);

router.post(
  "/quotes/:id/revision-draft/publish",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = PublishRevisionDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // Optional body: the latest composer text. When provided it supersedes
    // the stored draft, making publish a single atomic request — an
    // in-flight auto-save can never overtake it with older text.
    let providedNote: string | undefined;
    let providedCategories: string[] | null | undefined;
    if (req.body && typeof req.body === "object" && "note" in req.body) {
      const body = PublishRevisionDraftBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.message });
        return;
      }
      if (!body.data.note.trim()) {
        res.status(400).json({ error: "Update note cannot be empty." });
        return;
      }
      providedNote = body.data.note;
      // Distinguish "field omitted" (fall back to the draft's tags) from an
      // explicit empty selection (publish untagged).
      if ("categories" in body.data)
        providedCategories = body.data.categories ?? null;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;
    if (!guardNotArchived(quote, res)) return;

    const profile = await getUserProfile(req.userId!);
    // Publishing behaves identically to posting a fresh revision: it
    // invalidates any existing customer signoff and stamps the author.
    // The draft is deleted in the same transaction (atomic publish).
    const result = await db.transaction(async (tx) => {
      // Re-validate archive state under the lock: an archive may have
      // committed between the pre-transaction check and lock acquisition.
      const current = await lockQuoteRow(tx, quote.id);
      if (!current || current.archivedAt) return { archived: true as const };

      // Validate BEFORE deleting anything, so an invalid (missing or
      // blank) draft is never destroyed by a failed publish.
      const [draft] = await tx
        .select()
        .from(revisionDraftsTable)
        .where(
          and(
            eq(revisionDraftsTable.quoteId, quote.id),
            eq(revisionDraftsTable.authorId, req.userId!),
          ),
        );
      const note = providedNote ?? draft?.note;
      if (!note || !note.trim()) return { noDraft: true as const };
      const categories = sanitizeRevisionCategories(
        providedCategories !== undefined
          ? providedCategories
          : draft?.categories,
        current,
      );

      if (draft) {
        await tx
          .delete(revisionDraftsTable)
          .where(eq(revisionDraftsTable.id, draft.id));
      }
      await tx.delete(signoffsTable).where(eq(signoffsTable.quoteId, quote.id));
      const [rev] = await tx
        .insert(revisionsTable)
        .values({
          quoteId: quote.id,
          authorId: req.userId!,
          authorName: profile.name,
          note,
          categories,
        })
        .returning();
      return { revision: rev };
    });

    if ("archived" in result) {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }
    if ("noDraft" in result) {
      res.status(400).json({ error: "There is no draft to publish." });
      return;
    }

    res.status(201).json(PublishRevisionDraftResponse.parse(result.revision));
  },
);

router.get("/quotes/:id/revisions", async (req, res): Promise<void> => {
  const params = ListRevisionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const revisions = await db
    .select()
    .from(revisionsTable)
    .where(eq(revisionsTable.quoteId, params.data.id))
    .orderBy(revisionsTable.createdAt);

  res.json(ListRevisionsResponse.parse(revisions));
});

router.post(
  "/quotes/:id/revisions",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = CreateRevisionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateRevisionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;
    if (!guardNotArchived(quote, res)) return;

    const profile = await getUserProfile(req.userId!);
    // Adding a revision invalidates any existing customer signoff: the
    // signed document no longer reflects the latest revision history.
    // Lock the quote row to serialize with concurrent sign attempts.
    const revision = await db.transaction(async (tx) => {
      // Re-validate archive state under the lock: an archive may have
      // committed between the pre-transaction check and lock acquisition.
      const current = await lockQuoteRow(tx, quote.id);
      if (!current || current.archivedAt) return null;
      await tx.delete(signoffsTable).where(eq(signoffsTable.quoteId, quote.id));
      const [rev] = await tx
        .insert(revisionsTable)
        .values({
          quoteId: quote.id,
          authorId: req.userId!,
          authorName: profile.name,
          note: parsed.data.note,
          categories: sanitizeRevisionCategories(
            parsed.data.categories,
            current,
          ),
        })
        .returning();
      return rev;
    });

    if (!revision) {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }

    res.status(201).json(CreateRevisionResponse.parse(revision));
  },
);

router.patch(
  "/quotes/:id/revisions/:revisionId/signoff-exclusion",
  async (req, res): Promise<void> => {
    const params = SetRevisionSignoffExclusionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SetRevisionSignoffExclusionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // Only affects signoff-document visibility; the revision log is immutable.
    // Changing what the signoff sheet shows alters the document the customer
    // approved, so any existing signature is cleared atomically — the quote
    // must be re-signed. Lock the quote row to serialize with sign attempts,
    // and enforce the read-only archive policy under that lock.
    const revision = await db.transaction(async (tx) => {
      const current = await lockQuoteRow(tx, params.data.id);
      if (!current) return { kind: "notFound" as const };
      if (current.archivedAt) return { kind: "archived" as const };
      const [rev] = await tx
        .update(revisionsTable)
        .set({ excludedFromSignoff: parsed.data.excludedFromSignoff })
        .where(
          and(
            eq(revisionsTable.id, params.data.revisionId),
            eq(revisionsTable.quoteId, params.data.id),
          ),
        )
        .returning();
      if (!rev) return { kind: "notFound" as const };
      await tx
        .delete(signoffsTable)
        .where(eq(signoffsTable.quoteId, params.data.id));
      return { kind: "ok" as const, rev };
    });

    if (revision.kind === "archived") {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }
    if (revision.kind === "notFound") {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(SetRevisionSignoffExclusionResponse.parse(revision.rev));
  },
);

router.get("/quotes/:id/attachments", async (req, res): Promise<void> => {
  const params = ListAttachmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;

  const attachments = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.quoteId, quote.id))
    .orderBy(desc(attachmentsTable.createdAt));

  res.json(ListAttachmentsResponse.parse(attachments));
});

router.post(
  "/quotes/:id/attachments",
  async (req: AuthedRequest, res): Promise<void> => {
    const params = CreateAttachmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateAttachmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const quote = await loadQuote(params.data.id, res);
    if (!quote) return;
    if (!guardNotArchived(quote, res)) return;

    const profile = await getUserProfile(req.userId!);
    const [attachment] = await db
      .insert(attachmentsTable)
      .values({
        quoteId: quote.id,
        name: parsed.data.name,
        objectPath: parsed.data.objectPath,
        contentType: parsed.data.contentType ?? null,
        size: parsed.data.size ?? null,
        uploadedById: req.userId!,
        uploadedByName: profile.name,
      })
      .returning();

    res.status(201).json(CreateAttachmentResponse.parse(attachment));
  },
);

router.delete(
  "/quotes/:id/attachments/:attachmentId",
  async (req, res): Promise<void> => {
    const params = DeleteAttachmentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // Archived quotes are read-only: re-validate under the quote-row lock so
    // deletion cannot race an archive.
    const outcome = await db.transaction(async (tx) => {
      const current = await lockQuoteRow(tx, params.data.id);
      if (!current) return "notFound" as const;
      if (current.archivedAt) return "archived" as const;
      const [attachment] = await tx
        .delete(attachmentsTable)
        .where(
          and(
            eq(attachmentsTable.id, params.data.attachmentId),
            eq(attachmentsTable.quoteId, params.data.id),
          ),
        )
        .returning();
      return attachment ? ("deleted" as const) : ("notFound" as const);
    });

    if (outcome === "archived") {
      res.status(400).json({
        error: "This quote is archived. Restore it to make changes.",
      });
      return;
    }
    if (outcome === "notFound") {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    res.sendStatus(204);
  },
);

router.post("/quotes/:id/share-link", async (req, res): Promise<void> => {
  const params = CreateShareLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;
  if (!guardNotArchived(quote, res)) return;

  // Atomic: SELECT FOR UPDATE prevents two simultaneous requests from each
  // generating a different token and overwriting each other.
  const token = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ shareToken: quotesTable.shareToken })
      .from(quotesTable)
      .where(eq(quotesTable.id, quote.id))
      .for("update");
    if (!locked) return null;
    if (locked.shareToken) return locked.shareToken;
    const newToken = randomBytes(24).toString("base64url");
    await tx
      .update(quotesTable)
      .set({ shareToken: newToken })
      .where(eq(quotesTable.id, quote.id));
    return newToken;
  });

  if (!token) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }

  res.json(CreateShareLinkResponse.parse({ token }));
});

router.get("/quotes/:id/signoff", async (req, res): Promise<void> => {
  const params = GetSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [signoff] = await db
    .select()
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, params.data.id));

  res.json(signoff ?? null);
});

router.put("/quotes/:id/signoff", async (req, res): Promise<void> => {
  const params = SaveSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SaveSignoffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const quote = await loadQuote(params.data.id, res);
  if (!quote) return;
  if (!guardNotArchived(quote, res)) return;

  // Reject stale submissions: the document the signer loaded must still
  // match the current content (quote edits, new revisions, exclusions).
  // The quote row is locked and re-read inside the transaction so the
  // version check cannot race a concurrent mutation.
  const signoff = await db.transaction(async (tx) => {
    const current = await lockQuoteRow(tx, quote.id);
    if (!current || current.archivedAt) return null;
    const included = await loadIncludedRevisions(tx, quote.id);
    if (computeDocumentVersion(current, included) !== parsed.data.documentVersion)
      return null;
    const [row] = await tx
      .insert(signoffsTable)
      .values({
        quoteId: quote.id,
        customerName: parsed.data.customerName,
        signatureType: parsed.data.signatureType,
        signatureData: parsed.data.signatureData,
      })
      .onConflictDoUpdate({
        target: signoffsTable.quoteId,
        set: {
          customerName: parsed.data.customerName,
          signatureType: parsed.data.signatureType,
          signatureData: parsed.data.signatureData,
          signedAt: new Date(),
        },
      })
      .returning();
    return row;
  });

  if (!signoff) {
    res.status(409).json({
      error:
        "This document has changed since it was loaded. Please refresh and review the latest version before signing.",
    });
    return;
  }

  res.json(SaveSignoffResponse.parse(signoff));
});

router.delete("/quotes/:id/signoff", async (req, res): Promise<void> => {
  const params = ClearSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db
    .delete(signoffsTable)
    .where(eq(signoffsTable.quoteId, params.data.id));

  res.sendStatus(204);
});

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const [quoteCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(quotesTable);
  const [revisionCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(revisionsTable);
  const [signedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signoffsTable);

  const totalQuotes = quoteCount?.count ?? 0;
  const signedQuotes = signedCount?.count ?? 0;

  res.json(
    GetDashboardSummaryResponse.parse({
      totalQuotes,
      totalRevisions: revisionCount?.count ?? 0,
      signedQuotes,
      quotesAwaitingSignoff: totalQuotes - signedQuotes,
    }),
  );
});

router.get("/activity/recent", async (req: AuthedRequest, res): Promise<void> => {
  const query = GetRecentActivityQueryParams.safeParse(req.query);
  const limit = Math.min(query.success ? (query.data.limit ?? 10) : 10, 50);
  const mine = query.success ? query.data.mine === true : false;

  const rows = await db
    .select({
      id: revisionsTable.id,
      quoteId: revisionsTable.quoteId,
      quoteNumber: quotesTable.quoteNumber,
      customerName: quotesTable.customerName,
      projectName: quotesTable.projectName,
      authorName: revisionsTable.authorName,
      note: revisionsTable.note,
      createdAt: revisionsTable.createdAt,
    })
    .from(revisionsTable)
    .innerJoin(quotesTable, eq(revisionsTable.quoteId, quotesTable.id))
    .where(mine ? eq(quotesTable.createdById, req.userId!) : undefined)
    .orderBy(desc(revisionsTable.createdAt))
    .limit(limit);

  res.json(GetRecentActivityResponse.parse(rows));
});

export default router;
