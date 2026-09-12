import { createHash } from "node:crypto";

/** Pure scope validation shared by routes and focused unit coverage. */
export function normalizeProductScope(input: unknown, categories: readonly string[]): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.some((type) => typeof type !== "string")) return null;
  const types = [...new Set(input)];
  return types.length === input.length && types.every((type) => categories.includes(type)) ? types : null;
}

/** Hash the locked, relevant content; unrelated quote timestamps are excluded. */
export function hashLockedScopedContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Revoked scoped tokens must not disclose any locked detail or documents. */
export function canAccessScopedPublicToken(status: string): boolean {
  return status !== "revoked";
}

/** Both new snapshots and historical public reads omit excluded revisions. */
export function publicScopedRevisions<T extends { excludedFromSignoff: boolean }>(revisions: T[]): T[] {
  return revisions.filter((revision) => !revision.excludedFromSignoff);
}