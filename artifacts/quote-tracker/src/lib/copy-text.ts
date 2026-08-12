import { format } from "date-fns";
import { categoryLabel } from "@/lib/revision-categories";

/**
 * Copy plain text to the clipboard, preserving newlines exactly.
 * Falls back to a hidden textarea + execCommand when the async
 * clipboard API is unavailable (e.g. non-secure contexts).
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    // Keep it off-screen without display:none (which would block selection).
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}

interface RevisionLike {
  authorName: string;
  createdAt: string | Date;
  categories?: string[] | null;
  note: string;
}

/**
 * Build a plain-text digest of revision entries — author, date, category
 * labels, and the raw note (line breaks intact) — separated by blank lines,
 * suitable for pasting into an email.
 */
export function formatRevisionsDigest(revisions: RevisionLike[]): string {
  return revisions
    .map((rev) => {
      const lines = [
        `${rev.authorName} — ${format(new Date(rev.createdAt), "MMMM d, yyyy 'at' h:mm a")}`,
      ];
      if (rev.categories?.length) {
        lines.push(`Categories: ${rev.categories.map(categoryLabel).join(", ")}`);
      }
      lines.push(rev.note);
      return lines.join("\n");
    })
    .join("\n\n");
}
