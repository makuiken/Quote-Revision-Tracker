// Deterministic simulated scan, not a substitute for physical scanner samples.
import { createCanvas } from "@napi-rs/canvas";
import { writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { decodePngPages, encodePngPdf, encodeRgbFlatePdf, encodeJpeg95Pdf } from "./pdf-candidate-encoders.mjs";

const canvas = createCanvas(1360, 1760);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#eeeae1";
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = "#222";
ctx.font = "18px sans-serif";
for (let y = 80; y < 900; y += 25) {
  ctx.fillText("Limited warranty: verify rough opening 32 1/8 in. x 56 7/16 in.; tolerance ± 1/16 in.", 60, y);
}
ctx.lineWidth = 1;
for (let x = 60; x < 1250; x += 100) ctx.strokeRect(x, 980, 80, 400);
const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
let seed = 12345;
for (let i = 0; i < pixels.data.length; i += 4) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const noise = (seed % 17) - 8;
  for (let c = 0; c < 3; c++) pixels.data[i + c] += noise;
}
ctx.putImageData(pixels, 0, 0);
const pages = [{ width: 612, height: 792, pngBytes: canvas.toBuffer("image/png") }];
const start = performance.now();
const decoded = await decodePngPages(pages);
const decodeMs = performance.now() - start;
const results = {};
for (const [name, encode] of Object.entries({
  png: () => encodePngPdf(pages),
  flate1: () => encodeRgbFlatePdf(decoded, 1),
  flate6: () => encodeRgbFlatePdf(decoded, 6),
  jpeg95: () => encodeJpeg95Pdf(decoded),
})) {
  const timesMs = [];
  let pdf;
  for (let i = 0; i < 3; i++) {
    const before = performance.now();
    pdf = await encode();
    timesMs.push(performance.now() - before);
  }
  results[name] = { timesMs, medianMs: [...timesMs].sort((a,b) => a-b)[1], bytes: pdf.length };
  await mkdir("/tmp/pdf-encoding-scan", { recursive: true });
  await writeFile(`/tmp/pdf-encoding-scan/${name}.pdf`, pdf);
}
await mkdir("scripts/results", { recursive: true });
await writeFile("scripts/results/pdf-scan-encoding-benchmark.json", JSON.stringify({
  kind: "deterministic synthetic noisy scan; no physical scan available",
  dpi: 160, decodeMs, results,
}, null, 2) + "\n");
console.log(results);