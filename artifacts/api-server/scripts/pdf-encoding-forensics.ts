import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  degrees,
  rgb,
} from "pdf-lib";

import {
  rasterBoundsForNormalizedRect,
  sanitizePdf,
  type NormalizedRect,
} from "../src/lib/packets/engine";
const execFile = promisify(execFileCallback);
const SECRET = "FORENSIC_SECRET_7e31c0";

export interface PdfEncodingForensicsInput {
  /** The adversarial source PDF. An encoder must never copy objects from it. */
  sourcePdf: Buffer;
  /** Trusted, already-redacted raster pages to place in a new PDF. */
  pages: ReadonlyArray<{
    pageNumber: number;
    width: number;
    height: number;
    pngBytes: Buffer;
  }>;
  baseline: { pdf: Buffer };
}

export interface PdfEncodingForensicsCandidate {
  name: string;
  /** False for JPEG/lossy candidates. Lossless candidates are byte-pixel exact. */
  lossless: boolean;
  encode(input: PdfEncodingForensicsInput): Promise<Buffer | Uint8Array | { pdf: Buffer | Uint8Array }>;
}

export interface PdfEncodingForensicsResult {
  name: string;
  bytes: number;
  lossless: boolean;
  exactPixels: boolean;
  popplerChecked: boolean;
  redactionPixelsPass: boolean;
}

type Fixture = {
  sourcePdf: Buffer;
  redactions: readonly NormalizedRect[];
};

async function makeAdversarialFixture(): Promise<Fixture> {
  const document = await PDFDocument.create();
  document.setTitle(`${SECRET} title`);
  document.setAuthor(`${SECRET} author`);
  document.setSubject(`${SECRET} subject`);
  document.setKeywords([SECRET]);
  document.setProducer(`${SECRET} producer`);
  document.setCreator(`${SECRET} creator`);
  document.catalog.set(
    PDFName.of("OpenAction"),
    document.context.obj({ S: PDFName.of("JavaScript"), JS: PDFString.of(`app.alert("${SECRET}")`) }),
  );
  await document.attach(Buffer.from(`${SECRET} attachment`), `${SECRET}.txt`, {
    mimeType: "text/plain",
    description: SECRET,
  });

  const page = document.addPage([500, 400]);
  page.setCropBox(70, 55, 360, 240);
  page.setRotation(degrees(90));
  // Coordinates deliberately produce fractional pixel edges at 72 dpi.
  const redactions = [
    { x: 30.2 / 360, y: 35.2 / 240, width: 126.15 / 360, height: 45.15 / 240 },
    { x: 301.35 / 360, y: 191.4 / 240, width: 31.2 / 360, height: 22.2 / 240 },
  ] as const;
  page.drawRectangle({ x: 99, y: 214, width: 120, height: 39, color: rgb(1, 0, 0) });
  page.drawText(SECRET, { x: 102, y: 230, size: 12, color: rgb(0, 0, 0) });
  page.drawText("PUBLIC RASTER CONTENT", { x: 225, y: 155, size: 14, color: rgb(0, 0.2, 0.7) });
  page.drawRectangle({ x: 371, y: 61, width: 26, height: 18, color: rgb(1, 0, 0) });
  page.drawText("S", { x: 377, y: 65, size: 10, color: rgb(0, 0, 0) });

  // Keep interactive objects on an excluded page. They still exercise source
  // object isolation, without allowing annotation appearance rendering to
  // become part of the trusted raster supplied to an encoder.
  const hostilePage = document.addPage([180, 120]);
  const field = document.context.obj({
    FT: PDFName.of("Tx"),
    T: PDFString.of(`${SECRET}.field`),
    V: PDFString.of(SECRET),
  });
  const fieldRef = document.context.register(field);
  document.catalog.set(
    PDFName.of("AcroForm"),
    document.context.obj({ Fields: [fieldRef], NeedAppearances: true }),
  );

  const annotation = document.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [250, 180, 275, 205],
    Contents: PDFString.of(`${SECRET} annotation`),
    T: PDFString.of(SECRET),
  });
  const annotationRef = document.context.register(annotation);
  hostilePage.node.set(PDFName.of("Annots"), document.context.obj([annotationRef]));
  const sourceResources = page.node.Resources();
  const sourceXObjects = sourceResources.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (sourceXObjects?.keys().length === 0) sourceResources.delete(PDFName.of("XObject"));

  return {
    sourcePdf: Buffer.from(await document.save({ useObjectStreams: false })),
    redactions,
  };
}

function candidatePdf(value: Buffer | Uint8Array | { pdf: Buffer | Uint8Array }): Buffer {
  const bytes = typeof value === "object" && value !== null && "pdf" in value ? value.pdf : value;
  const pdf = Buffer.from(bytes);
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")), "candidate did not return a PDF");
  return pdf;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile("sh", ["-c", `command -v ${command} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

async function assertNoExtractableText(pdf: Buffer, directory: string): Promise<boolean> {
  if (await commandExists("pdftotext")) {
    const pdfPath = join(directory, "candidate.pdf");
    const textPath = join(directory, "candidate.txt");
    await writeFile(pdfPath, pdf);
    await execFile("pdftotext", [pdfPath, textPath]);
    assert.equal((await readFile(textPath, "utf8")).trim(), "", "Poppler extracted text from output");
    return true;
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    disableWorker: true,
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: false,
  });
  const loaded = await task.promise;
  try {
    const text: string[] = [];
    for (let index = 1; index <= loaded.numPages; index += 1) {
      const page = await loaded.getPage(index);
      const content = await page.getTextContent();
      text.push(
        ...content.items.map((item: unknown) =>
          typeof item === "object" && item !== null && "str" in item ? String(item.str) : "",
        ),
      );
      page.cleanup();
    }
    assert.equal(text.join("").trim(), "", "PDF.js extracted text from raster-only output");
  } finally {
    await loaded.cleanup();
    await task.destroy();
  }

  return false;
}

function assertFreshRasterOnlyStructure(pdf: Buffer): Promise<void> {
  return PDFDocument.load(pdf, { ignoreEncryption: false, updateMetadata: false }).then((document) => {
    assert.equal(document.getPageCount(), 1);
    const forbiddenKeys = new Set([
      "AcroForm",
      "AA",
      "Annots",
      "EmbeddedFiles",
      "Font",
      "JavaScript",
      "JS",
      "Metadata",
      "OpenAction",
      "Outlines",
    ]);

    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      for (const key of object.keys()) {
        const keyName = key.decodeText();
        const value = object.lookup(key);
        const harmlessEmptyContainer =
          (keyName === "Annots" && value instanceof PDFArray && value.size() === 0) ||
          (keyName === "Font" && value instanceof PDFDict && value.keys().length === 0);
        assert.equal(
          forbiddenKeys.has(keyName) && !harmlessEmptyContainer,
          false,
          `forbidden source capability/resource /${keyName} survived`,
        );
      }
    }

    const page = document.getPage(0);
    const outputAnnotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    assert.equal(outputAnnotations?.size() ?? 0, 0, "page contains annotations");
    const resources = page.node.Resources();
    assert.ok(resources instanceof PDFDict, "page has no resource dictionary");
    for (const key of resources.keys()) {
      if (key.decodeText() === "XObject") continue;
      const value = resources.lookup(key);
      assert.ok(
        value instanceof PDFDict && value.keys().length === 0,
        `page contains non-image /${key.decodeText()} resources`,
      );
    }
    const xObjects = resources.lookup(PDFName.of("XObject"));
    assert.ok(xObjects instanceof PDFDict, "page XObject resource is missing");
    const imageStreams = xObjects
      .keys()
      .map((key) => xObjects.lookup(key))
      .filter((object) => object instanceof PDFRawStream);
    assert.equal(imageStreams.length, 1, "page must reference exactly one fresh raster image");
    assert.equal(
      imageStreams[0]!.dict.get(PDFName.of("Subtype"))?.toString(),
      "/Image",
      "page XObject is not an image",
    );

    const serialized = pdf.toString("latin1");
    assert.equal(serialized.includes(SECRET), false, "secret source metadata/object survived");
    assert.equal(serialized.includes("/Type /Font"), false, "source font survived");
  });
}

async function rgba(png: Buffer): Promise<{ width: number; height: number; data: Buffer }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data: Buffer.from(pixels.data) };
}

async function extractRaster(pdf: Buffer, directory: string, candidateName: string): Promise<Buffer> {
  assert.equal(await commandExists("pdfimages"), true, "Poppler pdfimages is required for stream forensics");
  const pdfPath = join(directory, "candidate.pdf");
  await writeFile(pdfPath, pdf);
  const listing = await execFile("pdfimages", ["-list", pdfPath]);
  const pageImages = listing.stdout
    .split(/\r?\n/)
    .filter((line) => /^\s*1\s+\d+\s+image\s+/.test(line));
  assert.equal(
    pageImages.length,
    1,
    `${candidateName}: candidate PDF must contain exactly one decodable page image`,
  );
  const imagePrefix = join(directory, "decoded");
  await execFile("pdfimages", ["-png", pdfPath, imagePrefix]);
  const decodedImages = (await readdir(directory))
    .filter((file) => /^decoded-\d+\.png$/.test(file))
    .sort();
  if (decodedImages.length > 0) {
    return readFile(join(directory, decodedImages[0]!));
  }
  assert.equal(await commandExists("pdftoppm"), true, "Poppler pdftoppm is required for pixel forensics");
  const prefix = join(directory, "rendered");
  await execFile("pdftoppm", ["-r", String(DPI), "-f", "1", "-singlefile", "-png", pdfPath, prefix]);
  return readFile(`${prefix}.png`);
}

function assertWhiteRedactions(
  pixels: { width: number; height: number; data: Buffer },
  redactions: readonly NormalizedRect[],
  lossless: boolean,
): void {
  const minimum = lossless ? 255 : 245;
  for (const rect of redactions) {
    const bounds = rasterBoundsForNormalizedRect(rect, pixels.width, pixels.height);
    for (let y = bounds.top; y < bounds.top + bounds.height; y += 1) {
      for (let x = bounds.left; x < bounds.left + bounds.width; x += 1) {
        const offset = (y * pixels.width + x) * 4;
        assert.ok(
          pixels.data[offset]! >= minimum &&
            pixels.data[offset + 1]! >= minimum &&
            pixels.data[offset + 2]! >= minimum,
          `${lossless ? "lossless" : "JPEG"} candidate leaked a non-white redaction pixel at ${x},${y}`,
        );
      }
    }
  }
}

export async function runPdfEncodingForensics(
  alternatives?: readonly PdfEncodingForensicsCandidate[],
  dpi = 160,
): Promise<PdfEncodingForensicsResult[]> {
  const fixture = await makeAdversarialFixture();
  // Load after source rasterization. Besides keeping setup cheap for callers
  // that inject candidates, this makes the source-to-raster security boundary
  // visibly independent from every benchmark encoder.
  // @ts-expect-error The deliberately plain .mjs benchmark helper has no declarations.
  const encoders = alternatives ? undefined : await import("./pdf-candidate-encoders.mjs");
  const sanitized = await sanitizePdf(fixture.sourcePdf, {
    pages: [{ pageNumber: 1, bounds: fixture.redactions, expectedWidth: 360, expectedHeight: 240 }],
    pageOrder: [1],
  }, { dpi });
  const pages = sanitized.pages;
  const baselinePdf = encoders
    ? Buffer.from(await encoders.encodePngPdf(pages))
    : Buffer.from(await PDFDocument.create().then(async (document) => {
      const image = await document.embedPng(pages[0]!.pngBytes);
      document.addPage([pages[0]!.width, pages[0]!.height]).drawImage(image, {
        x: 0,
        y: 0,
        width: pages[0]!.width,
        height: pages[0]!.height,
      });
      return document.save({ addDefaultPage: false, useObjectStreams: true });
    }));
  const baseline = { pdf: baselinePdf };
  const input: PdfEncodingForensicsInput = {
    sourcePdf: fixture.sourcePdf,
    pages,
    baseline,
  };
  let decodedPages: Promise<unknown> | undefined;
  const decoded = () => {
    decodedPages ??= encoders!.decodePngPages(input.pages);
    return decodedPages;
  };
  const benchmarkAlternatives: PdfEncodingForensicsCandidate[] = [
    {
      name: "rgb-flate-level-1",
      lossless: true,
      encode: async () => encoders!.encodeRgbFlatePdf(await decoded(), 1),
    },
    {
      name: "rgb-flate-level-6",
      lossless: true,
      encode: async () => encoders!.encodeRgbFlatePdf(await decoded(), 6),
    },
    {
      name: "jpeg-quality-95",
      lossless: false,
      encode: async () => (encoders!.encodeJpegPdf ?? encoders!.encodeJpeg95Pdf)(await decoded(), 95),
    },
  ];
  const candidates: PdfEncodingForensicsCandidate[] = [
    {
      name: "pdf-lib-png-baseline",
      lossless: true,
      encode: async () => baselinePdf,
    },
    ...(alternatives ?? benchmarkAlternatives),
  ];
  assert.equal(
    new Set(candidates.map(({ name }) => name)).size,
    candidates.length,
    "candidate names must be unique",
  );

  const results: PdfEncodingForensicsResult[] = [];
  for (const candidate of candidates) {
    const directory = await mkdtemp(join(tmpdir(), "pdf-encoding-forensics-"));
    try {
      const pdf = candidatePdf(await candidate.encode(input));
      // Decode the serialized candidate before handing its Buffer to any PDF
      // object model; this guarantees the pixel check evaluates emitted bytes.
      const actual = await rgba(await extractRaster(pdf, directory, candidate.name));
      const popplerChecked = await assertNoExtractableText(pdf, directory);
      await assertFreshRasterOnlyStructure(pdf);
      const expected = await rgba(pages[0]!.pngBytes);
      assert.equal(actual.width, expected.width, `${candidate.name}: image width changed`);
      assert.equal(actual.height, expected.height, `${candidate.name}: image height changed`);
      let redactionPixelsPass = true;
      try {
        assertWhiteRedactions(actual, fixture.redactions, candidate.lossless);
      } catch (error) {
        if (candidate.lossless) throw error;
        redactionPixelsPass = false;
        console.warn(`[pdf-encoding-forensics] REJECT ${candidate.name}: ${String(error)}`);
      }
      const exactPixels = actual.data.equals(expected.data);
      if (candidate.lossless) {
        assert.equal(exactPixels, true, `${candidate.name}: lossless image stream changed pixels`);
      } else if (!exactPixels) {
        console.warn(`[pdf-encoding-forensics] ${candidate.name}: non-exact JPEG pixels; not eligible for adoption`);
      }
      results.push({ name: candidate.name, bytes: pdf.length, lossless: candidate.lossless, exactPixels, popplerChecked, redactionPixelsPass });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return results;
}
