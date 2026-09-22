import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { sanitizePdf } from "../src/lib/packets/engine";
import {
  decodePngPages,
  encodeJpeg95Pdf,
  encodePngPdf,
  encodeRgbFlatePdf,
} from "./pdf-candidate-encoders.mjs";

type RasterPage = { pngBytes: Buffer; width: number; height: number };
type TimedResult = { timesMs: number[]; medianMs: number; bytes: number };

const root = resolve(process.cwd(), "../..");
const assets = join(root, "attached_assets");
const outputDir = process.env.PDF_BENCH_TMP ?? "/tmp/pdf-encoding-benchmark";
const jsonPath = join(process.cwd(), "scripts/results/pdf-encoding-benchmark.json");
const samples = [
  { id: "A", maker: "Andersen", file: "2026-09-01_Quote_LouroDev-314Chicago_Andersen-9703008_1789228199124.pdf", pages: [1, 10, 21], kind: "fine print / product drawings" },
  { id: "B", maker: "Marvin", file: "2026-09-03_Quote_SBernard-95Clairmont_Marvin-CNRZHQY_1789228214042.pdf", pages: [1, 8, 16], kind: "fine print / product drawings" },
  { id: "C", maker: "Reeb", file: "2026-09-11_Quote_AshleyGrace-7CaitlinCt_Reeb-10668758_1789228223436.pdf", pages: [1, 11, 22], kind: "fine print / product drawings" },
  { id: "D", maker: "Hallmark", file: "2026-09-03_Quote_HallConstr-1000Morris_SQAP005760-2_1789228231973.pdf", pages: [1, 9, 17], kind: "fine print / product drawings" },
];
const workload = {
  id: "W40",
  maker: "Marvin/GRT",
  file: "GRT_Enterprises_-_17_Old_Wood_Main_REV6.8.26_1789759175437.pdf",
  pages: Array.from({ length: 40 }, (_, index) => index + 1),
  kind: "40-page product quote with drawings and terms",
};

function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

async function timedEncode(fn: () => Promise<Buffer>, retainPath?: string): Promise<TimedResult> {
  const timesMs: number[] = [];
  let bytes = 0;
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    const pdf = await fn();
    timesMs.push(Number((performance.now() - started).toFixed(1)));
    bytes = pdf.length;
    if (run === 2 && retainPath) await writeFile(retainPath, pdf);
  }
  return { timesMs, medianMs: median(timesMs), bytes };
}

async function sanitize(sample: typeof workload, dpi: number) {
  const source = await readFile(join(assets, sample.file));
  const started = performance.now();
  const packet = await sanitizePdf(
    source,
    { pages: [], pageOrder: sample.pages },
    { dpi, limits: { maxElapsedMs: 300_000 } },
  );
  return {
    packet,
    wallMs: Number((performance.now() - started).toFixed(1)),
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  };
}

async function evaluate(sample: typeof workload, dpi: number, keepPdfs: boolean) {
  console.log(`Rendering ${sample.id} at ${dpi} dpi (${sample.pages.length} pages)`);
  const { packet, wallMs, sourceSha256 } = await sanitize(sample, dpi);
  const pages: RasterPage[] = packet.pages;
  const decodeStarted = performance.now();
  const decoded = await decodePngPages(pages);
  const pngDecodeMs = Number((performance.now() - decodeStarted).toFixed(1));
  const prefix = join(outputDir, `${sample.id}-${dpi}`);
  const retained = (name: string) => keepPdfs ? `${prefix}-${name}.pdf` : undefined;
  const candidates = {
    png: await timedEncode(() => encodePngPdf(pages), retained("png")),
    rgbFlate1: await timedEncode(() => encodeRgbFlatePdf(decoded, 1), retained("flate1")),
    rgbFlate6: await timedEncode(() => encodeRgbFlatePdf(decoded, 6), retained("flate6")),
    jpeg95: await timedEncode(() => encodeJpeg95Pdf(decoded), retained("jpeg95")),
  };
  const renderMs = packet.diagnostics.renderAndPngMs;
  return {
    sampleId: sample.id,
    manufacturer: sample.maker,
    content: sample.kind,
    sourceSha256,
    dpi,
    pageCount: packet.pageCount,
    pixels: decoded.reduce((sum: number, page: any) => sum + page.pixelWidth * page.pixelHeight, 0),
    reference: {
      sanitizeWallMs: wallMs,
      renderAndPngMs: renderMs,
      originalPdfEncodeMs: packet.diagnostics.pdfEncodeMs,
      originalTotalMs: packet.diagnostics.totalMs,
      originalBytes: packet.pdf.length,
      pagePngBytes: pages.reduce((sum, page) => sum + page.pngBytes.length, 0),
    },
    extraPngDecodeMs: pngDecodeMs,
    candidates,
    estimatedEndToEndMedianMs: Object.fromEntries(
      Object.entries(candidates).map(([key, value]) => [
        key,
        Number((renderMs + (key === "png" ? 0 : pngDecodeMs) + value.medianMs).toFixed(1)),
      ]),
    ),
  };
}

async function simulatedScan(source: RasterPage) {
  const image = await loadImage(source.pngBytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#eeeae1";
  context.fillRect(0, 0, image.width, image.height);
  context.globalAlpha = 0.91;
  context.drawImage(image, 4, 3, image.width - 8, image.height - 6);
  context.globalAlpha = 1;
  const data = context.getImageData(0, 0, image.width, image.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const deterministicNoise = ((i * 17) % 13) - 6;
    data.data[i] = Math.max(0, Math.min(255, data.data[i]! + deterministicNoise));
    data.data[i + 1] = Math.max(0, Math.min(255, data.data[i + 1]! + deterministicNoise));
    data.data[i + 2] = Math.max(0, Math.min(255, data.data[i + 2]! + deterministicNoise));
  }
  context.putImageData(data, 0, 0);
  return { ...source, pngBytes: canvas.toBuffer("image/png") };
}

async function makeContactSheet(sourcePages: RasterPage[]) {
  const scan = await simulatedScan(sourcePages[0]!);
  const cases = [
    { label: "FINE PRINT — reference PNG", page: sourcePages[0]! },
    { label: "DRAWING — reference PNG", page: sourcePages[1]! },
    { label: "SIMULATED SCAN — reference PNG", page: scan },
  ];
  const rows: Array<{ label: string; bytes: Buffer }> = [];
  for (const item of cases) {
    const decoded = await decodePngPages([item.page]);
    const jpegPdf = await encodeJpeg95Pdf(decoded);
    await writeFile(join(outputDir, "contact-temp.pdf"), jpegPdf);
    // The contact sheet itself uses decoded JPEG bytes so the visible lossy path is genuine.
    const canvas = createCanvas(decoded[0].pixelWidth, decoded[0].pixelHeight);
    const context = canvas.getContext("2d");
    const rgba = context.createImageData(decoded[0].pixelWidth, decoded[0].pixelHeight);
    for (let s = 0, t = 0; s < decoded[0].rgb.length; s += 3) {
      rgba.data[t++] = decoded[0].rgb[s];
      rgba.data[t++] = decoded[0].rgb[s + 1];
      rgba.data[t++] = decoded[0].rgb[s + 2];
      rgba.data[t++] = 255;
    }
    context.putImageData(rgba, 0, 0);
    const jpeg = canvas.toBuffer("image/jpeg", 95);
    rows.push({ label: `${item.label} (lossless candidates are pixel-identical)`, bytes: item.page.pngBytes });
    rows.push({ label: `${item.label.replace("reference PNG", "JPEG q95")}`, bytes: jpeg });
  }
  const sheet = createCanvas(1600, rows.length * 360);
  const context = sheet.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.font = "24px sans-serif";
  context.fillStyle = "#111111";
  for (let index = 0; index < rows.length; index += 1) {
    const image = await loadImage(rows[index]!.bytes);
    const y = index * 360;
    context.fillText(rows[index]!.label, 20, y + 30);
    // Center crop at native scale where practical; fine detail remains inspectable.
    const cropWidth = Math.min(image.width, 1500);
    const cropHeight = Math.min(image.height, 300);
    context.drawImage(image, Math.floor((image.width - cropWidth) / 2), Math.floor((image.height - cropHeight) / 2), cropWidth, cropHeight, 20, y + 45, 1500, 300);
  }
  await writeFile(join(outputDir, "visual-comparison-contact-sheet.png"), sheet.toBuffer("image/png"));
}

await mkdir(outputDir, { recursive: true });
await mkdir(join(process.cwd(), "scripts/results"), { recursive: true });

const representative = [];
for (const sample of samples) representative.push(await evaluate(sample as typeof workload, 160, false));
const workload160 = await evaluate(workload, 160, true);
const workload140 = await evaluate(workload, 140, true);

const contactReference = await sanitize(samples[0] as typeof workload, 160);
await makeContactSheet([contactReference.packet.pages[0]!, contactReference.packet.pages[1]!]);

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, timedRuns: 3 },
  method: {
    referenceApi: "sanitizePdf",
    policyBaseline: "160 dpi + pdf-lib embedPng",
    candidateInputs: "reference sanitized pagePngs; Flate/JPEG include separately reported PNG decode",
    securityBoundary: "raster-only; no source page copy or overlay",
  },
  representative,
  workload40: { dpi160: workload160, dpi140: workload140 },
  artifacts: {
    sensitiveOutputDirectory: outputDir,
    contactSheet: join(outputDir, "visual-comparison-contact-sheet.png"),
  },
};
await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Results: ${jsonPath}`);
console.log(`Sensitive visual/PDF outputs: ${outputDir}`);