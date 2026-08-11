import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, quotesTable, revisionsTable, signoffsTable } from "@workspace/db";
import {
  GetPublicSignoffParams,
  GetPublicSignoffResponse,
  SavePublicSignoffParams,
  SavePublicSignoffBody,
  SavePublicSignoffResponse,
} from "@workspace/api-zod";
import { publicSignoffWriteLimiter } from "../lib/rateLimiters";
import {
  quoteStats,
  serializeQuote,
  computeDocumentVersion,
  loadIncludedRevisions,
  lockQuoteRow,
} from "./quotes";

// Public, token-gated routes. No login required — access is granted by
// knowing the unguessable share token attached to a quote.
const router: IRouter = Router();

async function loadQuoteByToken(token: string) {
  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.shareToken, token));
  return quote ?? null;
}

router.get("/public/signoff/:token", async (req, res): Promise<void> => {
  const params = GetPublicSignoffParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const quote = await loadQuoteByToken(params.data.token);
  if (!quote) {
    res.status(404).json({ error: "Invalid or revoked link" });
    return;
  }

  // Customers only see revisions the internal team hasn't excluded from
  // the signoff sheet (exclusion never touches the real revision log).
  const revisions = await db
    .select()
    .from(revisionsTable)
    .where(
      and(
        eq(revisionsTable.quoteId, quote.id),
        eq(revisionsTable.excludedFromSignoff, false),
      ),
    )
    .orderBy(revisionsTable.createdAt);

  const [signoff] = await db
    .select()
    .from(signoffsTable)
    .where(eq(signoffsTable.quoteId, quote.id));

  const stats = await quoteStats([quote.id]);
  res.json(
    GetPublicSignoffResponse.parse({
      quote: serializeQuote(quote, stats.get(quote.id)),
      revisions,
      signoff: signoff ?? null,
      documentVersion: computeDocumentVersion(quote, revisions),
    }),
  );
});

// Archived quotes cannot be signed, even through an already-issued link.
function rejectIfArchived(
  quote: { archivedAt: Date | null },
  res: Parameters<Parameters<IRouter["put"]>[1]>[1],
): boolean {
  if (quote.archivedAt) {
    res.status(400).json({
      error: "This quote is no longer active and cannot be signed.",
    });
    return true;
  }
  return false;
}

// The 500 KB JSON body limit for this route is enforced in app.ts by mounting
// a tighter parser before the global 2 MB one. Route-level middleware here
// applies only the per-IP rate limit.
router.put(
  "/public/signoff/:token",
  publicSignoffWriteLimiter,
  async (req, res): Promise<void> => {
    const params = SavePublicSignoffParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SavePublicSignoffBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const quote = await loadQuoteByToken(params.data.token);
    if (!quote) {
      res.status(404).json({ error: "Invalid or revoked link" });
      return;
    }
    if (rejectIfArchived(quote, res)) return;

    // Reject stale submissions: if the document changed (new revision, edit,
    // or exclusion) after the customer loaded it, they must review the latest
    // version before signing. The quote row is locked and re-read inside the
    // transaction so the version check cannot race a concurrent mutation.
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

    res.json(SavePublicSignoffResponse.parse(signoff));
  },
);

export default router;
