import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, quotesTable, revisionsTable, signoffsTable } from "@workspace/db";
import {
  GetPublicSignoffParams,
  GetPublicSignoffResponse,
  SavePublicSignoffParams,
  SavePublicSignoffBody,
  SavePublicSignoffResponse,
} from "@workspace/api-zod";
import { quoteStats, serializeQuote } from "./quotes";

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
    GetPublicSignoffResponse.parse({
      quote: serializeQuote(quote, stats.get(quote.id)),
      revisions,
      signoff: signoff ?? null,
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

router.put("/public/signoff/:token", async (req, res): Promise<void> => {
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

  res.json(SavePublicSignoffResponse.parse(signoff));
});

export default router;
