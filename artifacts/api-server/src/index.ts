import { assertSchemaCompatible, ensureSchema } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { startPacketJobRecovery } from "./lib/packets/service";
import { startAttachmentUploadRecovery } from "./lib/attachmentUploads";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Development may reconcile an old local database. Production is read-only:
// schema changes must have been applied before publishing the API.
const isDevelopment = process.env.NODE_ENV === "development";
try {
  if (isDevelopment) {
    await ensureSchema();
  } else {
    await assertSchemaCompatible();
  }
} catch (err) {
  logger.error(
    { err },
    isDevelopment
      ? "Database schema reconciliation failed"
      : "Database schema compatibility check failed",
  );
  process.exit(1);
}
startPacketJobRecovery();
startAttachmentUploadRecovery();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
