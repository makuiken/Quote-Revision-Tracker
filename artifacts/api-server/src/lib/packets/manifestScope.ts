export type CategorizedManifestPage = {
  packetId: number;
  pageNumber: number;
  pageOrder: number;
  productType: string | null;
};

/**
 * Compares the ordered page sequence visible to each product type. Reordering
 * Windows cannot invalidate Interior Doors; an identical manifest is a no-op.
 */
export function changedManifestProductTypes(
  before: CategorizedManifestPage[],
  after: CategorizedManifestPage[],
): string[] {
  const byType = (entries: CategorizedManifestPage[]) => {
    const result = new Map<string, string[]>();
    for (const entry of [...entries].sort((a, b) => a.pageOrder - b.pageOrder)) {
      if (!entry.productType) continue;
      const pages = result.get(entry.productType) ?? [];
      pages.push(`${entry.packetId}:${entry.pageNumber}`);
      result.set(entry.productType, pages);
    }
    return result;
  };
  const oldByType = byType(before);
  const newByType = byType(after);
  return [...new Set([...oldByType.keys(), ...newByType.keys()])].filter((type) =>
    JSON.stringify(oldByType.get(type) ?? []) !== JSON.stringify(newByType.get(type) ?? []),
  );
}

export function manifestChanged(
  before: CategorizedManifestPage[],
  after: CategorizedManifestPage[],
): boolean {
  const fingerprint = (entries: CategorizedManifestPage[]) =>
    [...entries]
      .sort((a, b) => a.pageOrder - b.pageOrder)
      .map((entry) => `${entry.packetId}:${entry.pageNumber}:${entry.pageOrder}`)
      .join("|");
  return fingerprint(before) !== fingerprint(after);
}