export const MAX_SIGNOFF_PACKET_PAGES = 500;
export const MAX_SIGNOFF_PACKET_SOURCE_BYTES = 100 * 1024 * 1024;

export function manifestBudgetAllows(
  pageCount: number,
  uniqueSourceSizes: readonly number[],
): boolean {
  return (
    pageCount <= MAX_SIGNOFF_PACKET_PAGES &&
    uniqueSourceSizes.every((size) => Number.isSafeInteger(size) && size >= 0) &&
    uniqueSourceSizes.reduce((total, size) => total + size, 0) <=
      MAX_SIGNOFF_PACKET_SOURCE_BYTES
  );
}