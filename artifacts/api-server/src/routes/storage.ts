import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { attachmentUploadsTable, db, quotesTable } from '@workspace/db';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';
import {
  ATTACHMENT_UPLOAD_TTL_MS,
  sweepAttachmentUploads,
  validateAttachmentUpload,
} from '../lib/attachmentUploads';

import { requireAuth, requireApproved, type AuthedRequest } from '../middlewares/requireAuth';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Requires auth middleware so public callers cannot mint write-capable URLs.
 */
router.post(
  '/storage/uploads/request-url',
  requireAuth,
  requireApproved,
  async (req: AuthedRequest, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { quoteId, name, size, contentType } = parsed.data;
      const validationError = validateAttachmentUpload(name, size, contentType);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const [quote] = await db
        .select({ id: quotesTable.id, archivedAt: quotesTable.archivedAt })
        .from(quotesTable)
        .where(eq(quotesTable.id, quoteId));
      if (!quote) {
        res.status(404).json({ error: 'Quote not found' });
        return;
      }
      if (quote.archivedAt) {
        res.status(400).json({ error: 'Restore this quote before adding files.' });
        return;
      }

      const uploadId = randomUUID();
      const objectPath = `/objects/quote-attachments/${quote.id}/${uploadId}`;
      const finalObjectPath = `/objects/quote-attachments/${quote.id}/final/${uploadId}`;
      const uploadURL =
        await objectStorageService.getObjectEntityUploadURLForPath(objectPath);
      const now = new Date();
      await db.insert(attachmentUploadsTable).values({
        id: uploadId,
        quoteId: quote.id,
        objectPath,
        finalObjectPath,
        originalName: name.trim(),
        declaredSize: size,
        declaredContentType: contentType,
        createdById: req.userId!,
        status: 'pending',
        expiresAt: new Date(now.getTime() + ATTACHMENT_UPLOAD_TTL_MS),
        createdAt: now,
        updatedAt: now,
      });

      void sweepAttachmentUploads().catch((error) => {
        req.log.warn({ err: error }, 'Attachment upload cleanup sweep failed');
      });

      res.status(201).json(
        RequestUploadUrlResponse.parse({
          uploadId,
          uploadURL,
          objectPath,
          metadata: { quoteId, name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join('/') : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      res.status(500).json({ error: 'Failed to serve public object' });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
// Attachments are team-internal: require a signed-in, approved user.
router.get('/storage/objects/*path', requireAuth, requireApproved, async (req: AuthedRequest, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
    // Template samples are private administrator artifacts. The regular
    // object endpoint remains team-internal for quote attachments, but a
    // guessed/stolen template path must never let an approved salesperson
    // retrieve the original PDF.
    if (
      wildcardPath.startsWith('manufacturer-template-staging/') ||
      wildcardPath.startsWith('manufacturer-template-samples/')
    ) {
      if (req.appUser?.role !== 'admin') {
        res.status(403).json({ error: 'Administrator access required' });
        return;
      }
    }
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile =
      await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

export default router;
