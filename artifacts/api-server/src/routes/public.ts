import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { and, eq } from "drizzle-orm";
import {
  db,
  manufacturerPacketManifestTable,
  manufacturerPacketsTable,
  quotesTable,
  revisionsTable,
  signoffsTable,
} from "@workspace/db";
import {
  GetPublicManufacturerPacketPageParams,
  GetPublicManufacturerPacketPageQueryParams,
  GetPublicManufacturerPacketParams,
  GetPublicManufacturerPacketResponse,
  GetPublicSignoffDocumentParams,
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
  ensureUnsignedDocumentCached,
  ensureLegacySignedDocumentSnapshot,
  UnsignedDocumentBuildCapacityError,
  loadManifestPdfPages,
  loadIncludedRevisions,
  lockQuoteRow,
  validateSignoffSubmission,
} from "./quotes";
import { ObjectStorageService } from "../lib/objectStorage";
import { createSignedPacketDocument } from "../lib/packets/signoffDocument";
import { loadApprovedManifest } from "../lib/packets/service";
import { hashApprovedManifest } from "../lib/packets/manifestHash";

// Public, token-gated routes. No login required — access is granted by
// knowing the unguessable share token attached to a quote.
const router: IRouter = Router();
const publicDocumentLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
});
const packetStorage = new ObjectStorageService();

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
  const approvedPacket = await loadApprovedManifest(db, quote.id);
  res.json(
    GetPublicSignoffResponse.parse({
      quote: serializeQuote(quote, stats.get(quote.id)),
      revisions,
      signoff: signoff ?? null,
      documentVersion: computeDocumentVersion(quote, revisions, approvedPacket),
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
    const validated = validateSignoffSubmission(parsed.data);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
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
      const approvedPacket = await loadApprovedManifest(tx, quote.id);
      if (
        computeDocumentVersion(current, included, approvedPacket) !==
        parsed.data.documentVersion
      )
        return null;
      const revisions = await tx
        .select()
        .from(revisionsTable)
        .where(
          and(
            eq(revisionsTable.quoteId, quote.id),
            eq(revisionsTable.excludedFromSignoff, false),
          ),
        )
        .orderBy(revisionsTable.createdAt);
      const signedAt = new Date();
      const approvedPacketPages = await loadManifestPdfPages(approvedPacket);
      const signedDocument = await createSignedPacketDocument({
        quote: current,
        revisions,
        signoff: {
          customerName: validated.customerName,
          stakeholderRole: parsed.data.stakeholderRole,
          signatureType: parsed.data.signatureType,
          signatureData: validated.signatureData,
          signedAt,
        },
        approvedPacketPages,
      });
      const signedDocumentObjectPath = `/objects/signoff-documents/${quote.id}/${randomUUID()}.pdf`;
      await packetStorage.saveObjectEntityImmutable(
        signedDocumentObjectPath,
        signedDocument.bytes,
        "application/pdf",
      );
      const [row] = await tx
        .insert(signoffsTable)
        .values({
          quoteId: quote.id,
          customerName: validated.customerName,
          stakeholderRole: parsed.data.stakeholderRole,
          signatureType: parsed.data.signatureType,
          signatureData: validated.signatureData,
          signedPacketId: approvedPacket[0]?.packetId ?? null,
          signedPacketSha256: hashApprovedManifest(approvedPacket),
          signedDocumentObjectPath,
          signedDocumentSha256: signedDocument.sha256,
          signedAt,
        })
        .onConflictDoUpdate({
          target: signoffsTable.quoteId,
          set: {
            customerName: validated.customerName,
            stakeholderRole: parsed.data.stakeholderRole,
            signatureType: parsed.data.signatureType,
            signatureData: validated.signatureData,
            signedAt,
            signedPacketId: approvedPacket[0]?.packetId ?? null,
            signedPacketSha256: hashApprovedManifest(approvedPacket),
            signedDocumentObjectPath,
            signedDocumentSha256: signedDocument.sha256,
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

router.get("/public/signoff/:token/packet", async (req, res): Promise<void> => {
  const params = GetPublicManufacturerPacketParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const quote = await loadQuoteByToken(params.data.token);
  if (!quote) {
    res.status(404).json({ error: "Invalid or revoked link" });
    return;
  }
  const entries = await db
    .select({
      packetId: manufacturerPacketManifestTable.packetId,
      manufacturer: manufacturerPacketsTable.manufacturer,
      approvedAt: manufacturerPacketsTable.approvedAt,
      pageOrder: manufacturerPacketManifestTable.pageOrder,
    })
    .from(manufacturerPacketManifestTable)
    .innerJoin(
      manufacturerPacketsTable,
      eq(manufacturerPacketManifestTable.packetId, manufacturerPacketsTable.id),
    )
    .where(
      and(
        eq(manufacturerPacketManifestTable.quoteId, quote.id),
        eq(manufacturerPacketsTable.status, "approved"),
      ),
    )
    .orderBy(manufacturerPacketManifestTable.pageOrder);
  if (!entries.length || !entries[0]?.approvedAt) {
    res.status(404).json({ error: "No approved manufacturer packet is available." });
    return;
  }
  // No paths, original filename, analyzer output, or review metadata escapes.
  res.json(GetPublicManufacturerPacketResponse.parse({
    id: entries[0]!.packetId,
    manufacturer: entries.length === 1 ? entries[0]!.manufacturer : null,
    pageCount: entries.length,
    approvedAt: entries[0]!.approvedAt,
  }));
});

router.get(
  "/public/signoff/:token/packet/pages/:pageNumber",
  async (req, res): Promise<void> => {
    const params = GetPublicManufacturerPacketPageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const query = GetPublicManufacturerPacketPageQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "A documentVersion is required to load packet pages." });
      return;
    }
    const snapshot = await db.transaction(async (tx) => {
      const [unlockedQuote] = await tx
        .select()
        .from(quotesTable)
        .where(eq(quotesTable.shareToken, params.data.token));
      if (!unlockedQuote) return null;
      const quote = await lockQuoteRow(tx, unlockedQuote.id);
      if (!quote || quote.shareToken !== params.data.token) return null;
      const revisions = await loadIncludedRevisions(tx, quote.id);
      const manifest = await loadApprovedManifest(tx, quote.id);
      const version = computeDocumentVersion(quote, revisions, manifest);
      const manifestPage = manifest[params.data.pageNumber - 1];
      return {
        version,
        objectPath: manifestPage?.pagePath?.[manifestPage.pageNumber - 1] ?? null,
      };
    });
    if (!snapshot) {
      res.status(404).json({ error: "Invalid or revoked link" });
      return;
    }
    if (snapshot.version !== query.data.documentVersion) {
      res.status(409).json({
        error: "This signoff document has changed. Refresh before viewing the current packet pages.",
      });
      return;
    }
    const objectPath = snapshot.objectPath;
    if (!objectPath) {
      res.status(404).json({ error: "Approved packet page not found." });
      return;
    }
    try {
      const file = await packetStorage.getObjectEntityFile(objectPath);
      const response = await packetStorage.downloadObject(file, 0);
      res.status(response.status);
      res.setHeader("Content-Type", "image/png");
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch {
      // Avoid source/object details on a public token route.
      res.status(404).json({ error: "Approved packet page not found." });
    }
  },
);

router.get("/public/signoff/:token/document", publicDocumentLimiter, async (req, res): Promise<void> => {
  const params = GetPublicSignoffDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const snapshot = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.shareToken, params.data.token));
    if (!candidate) return null;
    const quote = await lockQuoteRow(tx, candidate.id);
    if (!quote || quote.shareToken !== params.data.token) return null;
    const [signoff] = await tx
      .select()
      .from(signoffsTable)
      .where(eq(signoffsTable.quoteId, quote.id));
    const revisions = await tx
      .select()
      .from(revisionsTable)
      .where(
        and(
          eq(revisionsTable.quoteId, quote.id),
          eq(revisionsTable.excludedFromSignoff, false),
        ),
      )
      .orderBy(revisionsTable.createdAt);
    const manifest = await loadApprovedManifest(tx, quote.id);
    return {
      quote,
      signoff: signoff ?? null,
      revisions,
      manifest,
      version: computeDocumentVersion(quote, revisions, manifest),
    };
  });
  if (!snapshot) {
    res.status(404).json({ error: "Invalid or revoked link" });
    return;
  }
  try {
    let objectPath = snapshot.signoff?.signedDocumentObjectPath ?? null;
    if (snapshot.signoff && !objectPath) {
      const backfilled = await ensureLegacySignedDocumentSnapshot(
        snapshot.quote.id,
        {
          id: snapshot.signoff.id,
          signedAt: snapshot.signoff.signedAt,
        },
      );
      if (!backfilled?.signedDocumentObjectPath) {
        res.status(409).json({
          error: "This signed approval changed while its legacy PDF snapshot was being created.",
        });
        return;
      }
      objectPath = backfilled.signedDocumentObjectPath;
    }
    if (!objectPath) {
      objectPath = await ensureUnsignedDocumentCached(
        snapshot.quote,
        snapshot.revisions,
        snapshot.manifest,
        snapshot.version,
      );
    }
    const file = await packetStorage.getObjectEntityFile(objectPath);
    const response = await packetStorage.downloadObject(file, 0);
    res.status(response.status);
    res.setHeader("Content-Disposition", 'inline; filename="customer-signoff-packet.pdf"');
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof UnsignedDocumentBuildCapacityError) {
      res.status(429).json({ error: "Document generation is busy. Please retry shortly." });
      return;
    }
    req.log.error(
      { err: error, quoteId: snapshot.quote.id },
      "Unable to create or stream public signoff document",
    );
    res.status(500).json({ error: "The current signoff document could not be generated." });
  }
});

export default router;
