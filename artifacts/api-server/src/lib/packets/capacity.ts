const DEFAULT_PACKET_SLOTS = 1;
const DEFAULT_SIGNOFF_SLOTS = 1;
const MAX_CONFIGURED_SLOTS = 4;
export const MIN_FREE_DB_CONNECTIONS = 3;
// Keep this synchronized with @workspace/db's exported DB_POOL_MAX. This
// module deliberately has no DB import so renderer-only unit tests do not
// initialize the database package.
const APPLICATION_DB_POOL_MAX = 5;

function slotCount(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_CONFIGURED_SLOTS
    ? parsed
    : fallback;
}

export function pdfCapacityConfiguration(
  env: Partial<Record<"PACKET_WORKER_GLOBAL_SLOTS" | "SIGNOFF_RENDERER_GLOBAL_SLOTS", string | undefined>> = process.env,
  poolMax = APPLICATION_DB_POOL_MAX,
) {
  const packetSlots = slotCount(env.PACKET_WORKER_GLOBAL_SLOTS, DEFAULT_PACKET_SLOTS);
  const signoffSlots = slotCount(env.SIGNOFF_RENDERER_GLOBAL_SLOTS, DEFAULT_SIGNOFF_SLOTS);
  const availableLongLivedConnections = poolMax - MIN_FREE_DB_CONNECTIONS;

  if (
    availableLongLivedConnections < 2 ||
    packetSlots + signoffSlots > availableLongLivedConnections
  ) {
    throw new Error(
      `Unsafe PDF capacity: packet workers (${packetSlots}) plus signoff renderers (${signoffSlots}) ` +
      `must leave at least ${MIN_FREE_DB_CONNECTIONS} of ${poolMax} database connections free.`,
    );
  }

  return { packetSlots, signoffSlots, poolMax, availableLongLivedConnections };
}

export function assertPdfCapacityConfiguration(): void {
  pdfCapacityConfiguration();
}