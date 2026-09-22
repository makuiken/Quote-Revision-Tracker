"""Independent MuPDF decoding of measured outputs; keep private crops in /tmp."""
from pathlib import Path
import pymupdf as fitz

for directory, baseline, candidates in [
    (Path("/tmp/pdf-encoding-benchmark"), "W40-160-png", ["W40-160-flate1", "W40-160-flate6"]),
    (Path("/tmp/pdf-encoding-scan"), "png", ["flate1", "flate6"]),
]:
    with fitz.open(directory / f"{baseline}.pdf") as reference:
        for candidate in candidates:
            with fitz.open(directory / f"{candidate}.pdf") as actual:
                assert len(actual) == len(reference)
                for index in range(len(reference)):
                    left = reference[index].get_pixmap(matrix=fitz.Matrix(1, 1))
                    right = actual[index].get_pixmap(matrix=fitz.Matrix(1, 1))
                    assert left.samples == right.samples, (candidate, index)
                print(candidate, len(actual), "pages: independently rendered pixels identical")
        page = reference[min(1, len(reference) - 1)]
        page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=fitz.Rect(20, 35, 590, 300)).save(
            str(directory / "readability-crop.png")
        )