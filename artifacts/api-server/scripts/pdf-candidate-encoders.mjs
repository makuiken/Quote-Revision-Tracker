import {
  PDFDocument,
  PDFRawStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { deflateSync } from "node:zlib";

function normalizePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new TypeError("At least one raster page is required.");
  }
  return pages.map((page, index) => {
    if (!page?.pngBytes || !page?.width || !page?.height) {
      throw new TypeError(`Raster page ${index + 1} is incomplete.`);
    }
    return page;
  });
}

function initializeDocument() {
  return PDFDocument.create().then((document) => {
    document.setTitle("");
    document.setAuthor("");
    document.setSubject("");
    document.setKeywords([]);
    document.setProducer("");
    document.setCreator("");
    document.setCreationDate(new Date(0));
    document.setModificationDate(new Date(0));
    return document;
  });
}

/** Decode sanitized PNGs and flatten any alpha onto white RGB. */
export async function decodePngPages(pages) {
  return Promise.all(normalizePages(pages).map(async (page) => {
    const image = await loadImage(page.pngBytes);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;
    const rgb = Buffer.allocUnsafe(image.width * image.height * 3);
    for (let source = 0, target = 0; source < rgba.length; source += 4) {
      rgb[target++] = rgba[source];
      rgb[target++] = rgba[source + 1];
      rgb[target++] = rgba[source + 2];
    }
    return { ...page, pixelWidth: image.width, pixelHeight: image.height, rgb };
  }));
}

/** Current-policy comparator: pdf-lib's regular embedPng path. */
export async function encodePngPdf(pages) {
  const document = await initializeDocument();
  for (const page of normalizePages(pages)) {
    const embedded = await document.embedPng(page.pngBytes);
    document.addPage([page.width, page.height]).drawImage(embedded, {
      x: 0,
      y: 0,
      width: page.width,
      height: page.height,
    });
  }
  return Buffer.from(await document.save({ addDefaultPage: false, useObjectStreams: true }));
}

/**
 * Forensic candidate: direct DeviceRGB image XObjects with explicit Flate level.
 * Input must be decoded RGB from decodePngPages; source PDF objects are never used.
 */
export async function encodeRgbFlatePdf(decodedPages, level) {
  if (level !== 1 && level !== 6) throw new RangeError("Flate level must be 1 or 6.");
  const document = await initializeDocument();
  for (const [index, raster] of decodedPages.entries()) {
    if (raster.rgb.length !== raster.pixelWidth * raster.pixelHeight * 3) {
      throw new TypeError(`RGB page ${index + 1} has an invalid byte length.`);
    }
    const compressed = deflateSync(raster.rgb, { level });
    const dictionary = document.context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: raster.pixelWidth,
      Height: raster.pixelHeight,
      BitsPerComponent: 8,
      ColorSpace: "DeviceRGB",
      Filter: "FlateDecode",
    });
    const reference = document.context.register(PDFRawStream.of(dictionary, compressed));
    const page = document.addPage([raster.width, raster.height]);
    const imageName = page.node.newXObject("BenchmarkImage", reference);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(raster.width, 0, 0, raster.height, 0, 0),
      drawObject(imageName),
      popGraphicsState(),
    );
  }
  return Buffer.from(await document.save({ addDefaultPage: false, useObjectStreams: true }));
}

/** Lossy comparator: transcode decoded RGB to JPEG quality 95, then embed. */
export async function encodeJpeg95Pdf(decodedPages) {
  const document = await initializeDocument();
  for (const raster of decodedPages) {
    const canvas = createCanvas(raster.pixelWidth, raster.pixelHeight);
    const context = canvas.getContext("2d");
    const rgba = context.createImageData(raster.pixelWidth, raster.pixelHeight);
    for (let source = 0, target = 0; source < raster.rgb.length; source += 3) {
      rgba.data[target++] = raster.rgb[source];
      rgba.data[target++] = raster.rgb[source + 1];
      rgba.data[target++] = raster.rgb[source + 2];
      rgba.data[target++] = 255;
    }
    context.putImageData(rgba, 0, 0);
    const jpeg = canvas.toBuffer("image/jpeg", 95);
    const embedded = await document.embedJpg(jpeg);
    document.addPage([raster.width, raster.height]).drawImage(embedded, {
      x: 0,
      y: 0,
      width: raster.width,
      height: raster.height,
    });
  }
  return Buffer.from(await document.save({ addDefaultPage: false, useObjectStreams: true }));
}