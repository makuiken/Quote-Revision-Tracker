/** Decides selective coverage invalidation without using timestamps. */
export function quoteApprovalImpact(input: {
  beforeCategories: string[];
  afterCategories: string[];
  changedSpecTypes: string[];
  sharedChanged: boolean;
  hasChanges: boolean;
}): string[] {
  if (!input.hasChanges) return [];
  const topologyChanged =
    JSON.stringify(input.beforeCategories) !== JSON.stringify(input.afterCategories);
  if (topologyChanged || input.sharedChanged) {
    return [...new Set([...input.beforeCategories, ...input.afterCategories])];
  }
  return [...new Set(input.changedSpecTypes)];
}