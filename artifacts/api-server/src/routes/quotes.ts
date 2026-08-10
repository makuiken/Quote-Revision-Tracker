import { Router, type IRouter, type Response } from "express";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  quotesTable,
  revisionsTable,
  signoffsTable,
} from "@workspace/db";
import {
  GetCurrentUserResponse,
  ListQuotesQueryParams,
  ListQuotesResponse,
  CreateQuoteBody,
  CreateQuoteResponse,
  GetQuoteParams,
  GetQuoteResponse,
  UpdateQuoteParams,
  UpdateQuoteBody,
  UpdateQuoteResponse,
  DeleteQuoteParams,
  ListRevisionsParams,
  ListRevisionsResponse,
  CreateRevisionParams,
  CreateRevisionBody,
  CreateRevisionResponse,
  GetSignoffParams,
  SaveSignoffParams,
  SaveSignoffBody,
  SaveSignoffResponse,
  ClearSignoffParams,
  GetDashboardSummaryResponse,
  GetRecentActivityQueryParams,
  GetRecentActivityResponse,
} from "@workspace/api-zod";
import {
  requireAuth,
  getUserProfile,
  type AuthedRequest,
} from "../middlewares/requireAuth";

const router: IRouter = Router();

router.use(requireAuth);

type QuoteRow = typeof quotesTable.$inferSelect;

async function quoteStats(quoteIds: number[]) {
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
    .groupBy(revisionsTable.quoteId);

  const signed = await db
    .select({ quoteId: signoffsTable.quoteId })
    .from(signoffsTable);

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

function serializeQuote(
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
    categories: quote.categories,
    specs: quote.specs ?? {},
    notes: quote.notes,
    createdByName: quote.createdByName,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    revisionCount: stats?.revisionCount ?? 0,
    lastActivityAt: stats?.lastActivityAt ?? null,
    signed: stats?.signed ?? false,
  };
}

router.get("/me", async (req: AuthedRequest, res): Promise<void> => {
  const profile = await getUserProfile(req.userId!);
  res.json(
    GetCurrentUserResponse.parse({
      id: req.userId,
      name: profile.name,
      email: profile.email,
    }),
  );
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
      categories: parsed.data.categories,
      specs: parsed.data.specs ?? {},
      notes: parsed.data.notes ?? null,
      createdById: req.userId!,
      createdByName: profile.name,
    })
    .returning();

  res.status(201).json(CreateQuoteResponse.parse(serializeQuote(quote!)));
});

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

router.patch("/quotes/:id", async (req, res): Promise<void> => {
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

  const updates: Partial<QuoteRow> = {};
  if (parsed.data.quoteNumber !== undefined)
    updates.quoteNumber = parsed.data.quoteNumber;
  if (parsed.data.customerName !== undefined)
    updates.customerName = parsed.data.customerName;
  if (parsed.data.categories !== undefined)
    updates.categories = parsed.data.categories;
  if (parsed.data.specs !== undefined) updates.specs = parsed.data.specs;
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  const [quote] = await db
    .update(quotesTable)
    .set(updates)
    .where(eq(quotesTable.id, params.data.id))
    .returning();

  if (!quote) {
    res.status(404).json({ error: "Quote not found" });
    return;
  }

  // Any edit to the quote invalidates a previously captured customer signoff:
  // the signed document no longer reflects the current specifications.
  await db.delete(signoffsTable).where(eq(signoffsTable.quoteId, quote.id));

  const stats = await quoteStats([quote.id]);
  res.json(UpdateQuoteResponse.parse(serializeQuote(quote, stats.get(quote.id))));
});

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

router.get("/activity/recent", async (req, res): Promise<void> => {
  const query = GetRecentActivityQueryParams.safeParse(req.query);
  const limit = Math.min(query.success ? (query.data.limit ?? 10) : 10, 50);

  const rows = await db
    .select({
      id: revisionsTable.id,
      quoteId: revisionsTable.quoteId,
      quoteNumber: quotesTable.quoteNumber,
      customerName: quotesTable.customerName,
      authorName: revisionsTable.authorName,
      note: revisionsTable.note,
      createdAt: revisionsTable.createdAt,
    })
    .from(revisionsTable)
    .innerJoin(quotesTable, eq(revisionsTable.quoteId, quotesTable.id))
    .orderBy(desc(revisionsTable.createdAt))
    .limit(limit);

  res.json(GetRecentActivityResponse.parse(rows));
});

export default router;
