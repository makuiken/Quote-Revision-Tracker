import { and, asc, eq, lt, ne, or } from "drizzle-orm";
import { attachmentUploadsTable, db } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentFilenameMatchesContentType,
  normalizeAttachmentContentType,
} from "./attachmentValidation";

export {
  MAX_ATTACHMENT_BYTES,
  attachmentFilenameMatchesContentType,
  attachmentContentDisposition,
  normalizeAttachmentContentType,
  validateAttachmentBytes,
} from "./attachmentValidation";

export const ATTACHMENT_UPLOAD_TTL_MS = 15 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 25;

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/acad",
  "application/x-acad",
  "application/autocad_dwg",
  "image/vnd.dwg",
  "image/x-dwg",
  "application/dxf",
  "application/x-dxf",
  "image/vnd.dxf",
]);
const OCTET_STREAM_EXTENSIONS = new Set(["dwg", "dxf"]);

export function validateAttachmentUpload(
  name: string,
  size: number,
  contentType: string,
): string | null {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 255 || /[\\/\0]/.test(cleanName)) {
    return "File name is invalid.";
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) {
    return `Files must be between 1 byte and ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
  }
  const normalizedType = normalizeAttachmentContentType(contentType);
  const extension = cleanName.includes(".")
    ? cleanName.split(".").pop()!.toLowerCase()
    : "";
  if (
    !ALLOWED_CONTENT_TYPES.has(normalizedType) &&
    !(
      normalizedType === "application/octet-stream" &&
      OCTET_STREAM_EXTENSIONS.has(extension)
    )
  ) {
    return "This file type is not allowed.";
  }
  if (!attachmentFilenameMatchesContentType(cleanName, normalizedType)) {
    return "File name extension does not match the declared content type.";
  }
  return null;
}

const storage = new ObjectStorageService();

export async function markAttachmentUploadForCleanup(uploadId: string): Promise<boolean> {
  const rows = await db
    .update(attachmentUploadsTable)
    .set({ status: "delete_pending", updatedAt: new Date() })
    .where(
      and(
        eq(attachmentUploadsTable.id, uploadId),
        eq(attachmentUploadsTable.status, "pending"),
      ),
    )
    .returning({ id: attachmentUploadsTable.id });
  return rows.length === 1;
}

export async function cleanupAttachmentUpload(uploadId: string): Promise<boolean> {
  const [upload] = await db
    .select({
      id: attachmentUploadsTable.id,
      objectPath: attachmentUploadsTable.objectPath,
      finalObjectPath: attachmentUploadsTable.finalObjectPath,
      status: attachmentUploadsTable.status,
      expiresAt: attachmentUploadsTable.expiresAt,
    })
    .from(attachmentUploadsTable)
    .where(eq(attachmentUploadsTable.id, uploadId));
  if (!upload || upload.status === "attached") return false;

  await storage.deleteObjectEntity(upload.objectPath);
  if (upload.status !== "source_cleanup_pending") {
    await storage.deleteObjectEntity(upload.finalObjectPath);
  }
  if (
    upload.status === "source_cleanup_pending" &&
    upload.expiresAt.getTime() <= Date.now()
  ) {
    await db
      .update(attachmentUploadsTable)
      .set({ status: "attached", updatedAt: new Date() })
      .where(
        and(
          eq(attachmentUploadsTable.id, upload.id),
          eq(attachmentUploadsTable.status, "source_cleanup_pending"),
        ),
      );
    return true;
  }
  if (upload.expiresAt.getTime() > Date.now()) {
    return true;
  }
  await db
    .delete(attachmentUploadsTable)
    .where(
      and(
        eq(attachmentUploadsTable.id, upload.id),
        ne(attachmentUploadsTable.status, "attached"),
        ne(attachmentUploadsTable.status, "source_cleanup_pending"),
      ),
    );
  return true;
}

export async function sweepAttachmentUploads(now = new Date()): Promise<{
  attempted: number;
  removed: number;
}> {
  const candidates = await db
    .select({ id: attachmentUploadsTable.id })
    .from(attachmentUploadsTable)
    .where(
      or(
        eq(attachmentUploadsTable.status, "delete_pending"),
        and(
          eq(attachmentUploadsTable.status, "source_cleanup_pending"),
          lt(attachmentUploadsTable.expiresAt, now),
        ),
        and(
          eq(attachmentUploadsTable.status, "pending"),
          lt(attachmentUploadsTable.expiresAt, now),
        ),
      ),
    )
    .orderBy(asc(attachmentUploadsTable.expiresAt))
    .limit(CLEANUP_BATCH_SIZE);

  const settled = await Promise.allSettled(
    candidates.map(({ id }) => cleanupAttachmentUpload(id)),
  );
  return {
    attempted: candidates.length,
    removed: settled.filter(
      (result) => result.status === "fulfilled" && result.value,
    ).length,
  };
}

let recoveryRunning = false;

async function drainAttachmentUploadCleanup(): Promise<void> {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    // Bound each pass so one recovery tick cannot monopolize the process.
    // A subsequent tick continues any backlog beyond this limit.
    for (let batch = 0; batch < 20; batch += 1) {
      const result = await sweepAttachmentUploads();
      if (result.attempted < CLEANUP_BATCH_SIZE) break;
    }
  } finally {
    recoveryRunning = false;
  }
}

export function startAttachmentUploadRecovery(): () => void {
  void drainAttachmentUploadCleanup().catch((error) => {
    console.warn("Attachment upload recovery sweep failed", error);
  });
  const timer = setInterval(() => {
    void drainAttachmentUploadCleanup().catch((error) => {
      console.warn("Attachment upload recovery sweep failed", error);
    });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}