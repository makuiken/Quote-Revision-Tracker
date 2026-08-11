import { randomBytes } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  db,
  quotesTable,
  revisionsTable,
  signoffsTable,
  attachmentsTable,
  usersTable,
} from "@workspace/db";
import {
  GetCurrentUserResponse,
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
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.status, "approved"))
    .orderBy(usersTable.name);
  res.json(ListTeamMembersResponse.parse(rows));
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
  const search = query.success ? query.data.search : undefined;

  const rows = await db
    .select()
    .from(quotesTable)
    .where(
      search
        ? or(
            ilike(quotesTable.quoteNumber, `%${search}%`),
            ilike(quotesTable.customerName, `%${search}%`),
            ilike(quotesTable.projectName, `%${search}%`),
            ilike(quotesTable.jobAddress, `%${search}%`),
          )
        : undefined,
    )
    .orderBy(desc(quotesTable.createdAt));

  const stats = await quoteStats(rows.map((r) => r.id));
  res.json(
    ListQuotesResponse.parse(rows.map((r) => serializeQuote(r, stats.get(r.id)))),
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
      const prevFields = prev[category] ?? {};
      const nextFields = next[category] ?? {};
      for (const field of new Set([...Object.keys(prevFields), ...Object.keys(nextFields)])) {
        const a = (prevFields as Record<string, unknown>)[field];
        const b = (nextFields as Record<string, unknown>)[field];
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
          changed.push(`${category} ${field}: ${fmtValue(a)} → ${fmtValue(b)}`);
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
    const [revision] = await db
      .insert(revisionsTable)
      .values({
        quoteId: quote.id,
        authorId: req.userId!,
        authorName: profile.name,
        note: parsed.data.note,
      })
      .returning();

    res.status(201).json(CreateRevisionResponse.parse(revision));
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

    const [attachment] = await db
      .delete(attachmentsTable)
      .where(
        and(
          eq(attachmentsTable.id, params.data.attachmentId),
          eq(attachmentsTable.quoteId, params.data.id),
        ),
      )
      .returning();

    if (!attachment) {
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

  const [signoff] = await db
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
