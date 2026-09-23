export type PacketPageProgress = {
  stage: string;
  completedPages: number;
  totalPages: number;
  reusedPages?: number;
  renderedPages?: number;
};

function pageCountLabel(count: number, action: "rendered" | "reused"): string {
  return `${count} ${count === 1 ? "page" : "pages"} ${action}`;
}

export function packetRenderBreakdown(
  progress: PacketPageProgress | null | undefined,
): string | null {
  if (!progress) return null;

  const counts: string[] = [];
  if (progress.renderedPages !== undefined) {
    counts.push(pageCountLabel(progress.renderedPages, "rendered"));
  }
  if (progress.reusedPages !== undefined) {
    counts.push(pageCountLabel(progress.reusedPages, "reused"));
  }
  return counts.length ? counts.join(", ") : null;
}

export function packetProcessingProgressText(
  progress: PacketPageProgress,
): string {
  const breakdown = packetRenderBreakdown(progress);
  return `${progress.stage} — ${progress.completedPages} of ${progress.totalPages} pages completed${breakdown ? ` (${breakdown})` : ""}`;
}