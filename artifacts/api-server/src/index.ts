import { loadRuntimeConfig } from "./lib/runtimeConfig";

const config = loadRuntimeConfig();
const [
  { assertSchemaCompatible, ensureSchema, SCHEMA_RELEASE_ID },
  { default: app },
  { logger },
  { startPacketJobRecovery },
  { startAttachmentUploadRecovery },
  { startOperationalReporting },
] = await Promise.all([
  import("@workspace/db"),
  import("./app"),
  import("./lib/logger"),
  import("./lib/packets/service"),
  import("./lib/attachmentUploads"),
  import("./lib/operationalSignals"),
]);

// Development may reconcile an old local database. Production is read-only:
// schema changes must have been applied before publishing the API.
const isDevelopment = config.nodeEnv === "development";
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
startOperationalReporting();

app.listen(config.port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info(
    { port: config.port, nodeEnv: config.nodeEnv, schemaRelease: SCHEMA_RELEASE_ID },
    "Server listening",
  );
});
