import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mergePacketPdfFiles, renderPdfPreview, sanitizePdf } from "./engine";
import { SANITIZED_BATCH_MERGE_LIMITS } from "./workerProtocol";

async function mergeForTest(
  batches: Uint8Array[],
  expectedBatchPageGeometry?: { width: number; height: number }[][],
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "packet-merge-test-"));
  try {
    const paths = batches.map((_, index) => join(directory, `${index}.pdf`));
    for (const [index, bytes] of batches.entries()) await writeFile(paths[index]!, bytes);
    const output = join(directory, "merged.pdf");
    await mergePacketPdfFiles(paths, output, expectedBatchPageGeometry);
    return await readFile(output);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("partial batches keep original source geometry/redactions and merge in exact order", async () => {
  const source = await PDFDocument.create();
  source.addPage([90, 100]);
  source.addPage([100, 110]);
  const last = source.addPage([180, 160]);
  last.setCropBox(10, 20, 120, 130);
  last.setRotation(degrees(90));
  last.drawRectangle({ x: 10, y: 85, width: 60, height: 65, color: rgb(0, 0, 0) });
  last.drawText("PRIVATE", { x: 12, y: 120, size: 8 });
  const bytes = Buffer.from(await source.save());
  const first = await sanitizePdf(bytes, {
    pageOrder: [3, 1],
    pages: [{
      pageNumber: 3, expectedWidth: 120, expectedHeight: 130,
      bounds: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
    }],
  });
  const second = await sanitizePdf(bytes, { pageOrder: [2], pages: [] });
  assert.equal(first.renderDpi, 160);
  assert.deepEqual(first.pages.map(({ pageNumber, width, height }) => [pageNumber, width, height]),
    [[1, 120, 130], [2, 90, 100]]);
  const pdfBytes = await mergeForTest([first.pdf, second.pdf]);
  const merged = await PDFDocument.load(pdfBytes);
  assert.deepEqual(merged.getPages().map((page) => [page.getWidth(), page.getHeight()]),
    [[120, 130], [90, 100], [100, 110]]);
  const png = await renderPdfPreview(Buffer.from(pdfBytes), 1, { dpi: 72 });
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  assert.deepEqual([...context.getImageData(20, 20, 1, 1).data], [255, 255, 255, 255]);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      assert.equal((await (await doc.getPage(n)).getTextContent()).items.length, 0);
    }
  } finally { await doc.cleanup(); await doc.loadingTask.destroy(); }
  await assert.rejects(sanitizePdf(bytes, {
    pageOrder: [3], pages: [{ pageNumber: 3, expectedWidth: 180, expectedHeight: 160, bounds: [] }],
  }), /different source page dimensions/);
});

test("merge rejects malformed PDFs and aggregate count/byte overflow", async () => {
  await assert.rejects(mergeForTest([]), /Invalid private/);
  const directory = await mkdtemp(join(tmpdir(), "packet-merge-limit-"));
  try {
    const path = join(directory, "large.pdf");
    await writeFile(path, "%PDF-");
    await truncate(path, 51 * 1024 * 1024);
    await assert.rejects(mergePacketPdfFiles([path, path], join(directory, "merged.pdf")), /aggregate input byte/);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const document = await PDFDocument.create();
  for (let n = 0; n < 51; n++) document.addPage([10, 10]);
  const bytes = await document.save();
  await assert.rejects(mergeForTest([bytes, bytes]), /page count/);
  assert.equal(SANITIZED_BATCH_MERGE_LIMITS.maxOutputBytes, 100 * 1024 * 1024);
  await assert.rejects(mergeForTest([Buffer.from("%PDF-invalid")]), /parsed safely/);
});

test("disk merge reads private batches in order, refuses overwrite and preserves page limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "packet-merge-test-"));
  try {
    const paths = [];
    for (const width of [80, 90]) {
      const doc = await PDFDocument.create();
      doc.addPage([width, 100]);
      const batch = await sanitizePdf(Buffer.from(await doc.save()), { pages: [] });
      const path = join(directory, `${width}.pdf`);
      await writeFile(path, batch.pdf);
      paths.push(path);
    }
    const outputPath = join(directory, "merged.pdf");
    await mergePacketPdfFiles(paths, outputPath);
    const merged = await PDFDocument.load(await readFile(outputPath));
    assert.deepEqual(merged.getPages().map((page) => page.getWidth()), [80, 90]);
    await assert.rejects(mergePacketPdfFiles(paths, outputPath), /EEXIST/);
    await assert.rejects(mergePacketPdfFiles(Array(101).fill(paths[0]), join(directory, "overflow.pdf")),
      /Invalid private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("disk merge enforces analyzed page count and geometry for every batch", async () => {
  const first = await PDFDocument.create();
  first.addPage([80, 100]);
  first.addPage([90, 110]);
  const second = await PDFDocument.create();
  second.addPage([120, 130]);
  const batches = [await first.save(), await second.save()];
  const expected = [
    [{ width: 80, height: 100 }, { width: 90, height: 110 }],
    [{ width: 120, height: 130 }],
  ];

  const merged = await PDFDocument.load(await mergeForTest(batches, expected));
  assert.equal(merged.getPageCount(), 3);
  await assert.rejects(
    mergeForTest(batches, [[{ width: 80, height: 100 }], expected[1]!]),
    /count or geometry/,
  );
  await assert.rejects(
    mergeForTest(batches, [
      [{ width: 81, height: 100 }, { width: 90, height: 110 }],
      expected[1]!,
    ]),
    /count or geometry/,
  );
  await assert.rejects(
    mergeForTest(batches, [expected[0]!]),
    /Invalid expected batch page geometry/,
  );
});
