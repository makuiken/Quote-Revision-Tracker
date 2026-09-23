/** Shared by mandatory packet work and optional cold preview rendering. */
export const PACKET_WORKER_LOCK_BASE = 7_472_657_400;

export interface AdvisoryLockClient {
  query(
    sql: string,
    values: number[],
  ): Promise<{ rows: Array<{ acquired?: boolean }> }>;
  release(error?: Error): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

export async function tryAcquirePacketWorkerSlot(
  connectionPool: AdvisoryLockPool,
  lockBase: number,
  slotCount: number,
): Promise<{ release: () => Promise<void>; slot: number } | null> {
  const client = await connectionPool.connect();
  try {
    for (let slot = 0; slot < slotCount; slot += 1) {
      const lockKey = lockBase + slot;
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [lockKey],
      );
      if (!result.rows[0]?.acquired) continue;
      let released = false;
      return {
        slot,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
            client.release();
          } catch (error) {
            client.release(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        },
      };
    }
    client.release();
    return null;
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}