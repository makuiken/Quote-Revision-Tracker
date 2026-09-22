"""Inspect local evaluation inputs without writing customer data into reports."""
from pathlib import Path
import pymupdf as fitz

out = Path("/tmp/pdf-corpus-inspection")
out.mkdir(exist_ok=True)
for index, source in enumerate(sorted(Path("attached_assets").glob("*.pdf"))):
    with fitz.open(source) as doc:
        pages = []
        for number, page in enumerate(doc):
            spans = [
                span for block in page.get_text("dict")["blocks"]
                if "lines" in block for line in block["lines"] for span in line["spans"]
            ]
            pages.append({
                "page": number + 1,
                "min_font": round(min((s["size"] for s in spans), default=0), 2),
                "text_chars": sum(len(s["text"]) for s in spans),
                "images": len(page.get_images()),
            })
        print(f"input={index} pages={len(doc)} characteristics={pages}")
        # Last pages often contain terms and fine print; first pages show layout.
        for number in sorted({0, len(doc) - 1}):
            doc[number].get_pixmap(matrix=fitz.Matrix(1, 1)).save(
                str(out / f"input-{index}-page-{number+1}.png")
            )