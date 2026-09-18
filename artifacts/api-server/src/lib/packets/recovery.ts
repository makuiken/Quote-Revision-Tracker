export interface RecoverablePacketState {
  status: string;
  processingStartedAt: Date | null;
}

// A worker is forcibly terminated after 90 seconds. Five minutes leaves ample
// time for bounded storage/finalization retries without making staff wait
// fifteen minutes after a replica exits.
export const PROCESSING_ABANDONED_AFTER_MS = 5 * 60 * 1000;

export function nextRecoveryScanCursor(
  lastCandidateId: number,
  candidateCount: number,
  pageSize: number,
): number {
  return candidateCount < pageSize ? 0 : lastCandidateId;
}

export function isAbandonedProcessingJob(
  packet: RecoverablePacketState,
  now = Date.now(),
): boolean {
  return (
    packet.status === "processing" &&
    !!packet.processingStartedAt &&
    now - packet.processingStartedAt.getTime() > PROCESSING_ABANDONED_AFTER_MS
  );
}

export function recoveryAction(
  packet: RecoverablePacketState & { attemptCount: number },
  archived: boolean,
  maxAttempts: number,
  now = Date.now(),
): "queue" | "fail" | "skip" {
  if (archived) return "skip";
  if (packet.status === "queued") {
    return packet.attemptCount >= maxAttempts ? "fail" : "queue";
  }
  if (!isAbandonedProcessingJob(packet, now)) return "skip";
  return packet.attemptCount >= maxAttempts ? "fail" : "queue";
}