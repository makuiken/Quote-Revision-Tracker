import { build } from "esbuild";
import { copyFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = await mkdtemp(join(process.cwd(), ".pdf-encoding-forensics-"));
try {
  const outfile = join(outdir, "pdf-encoding-forensics.mjs");
  await build({
    entryPoints: ["scripts/pdf-encoding-forensics.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: [
      "*.node",
      "@napi-rs/canvas",
      "pdfjs-dist",
      "pdfjs-dist/*",
      "./pdf-candidate-encoders.mjs",
    ],
  });
  await copyFile("scripts/pdf-candidate-encoders.mjs", join(outdir, "pdf-candidate-encoders.mjs"));
  const { runPdfEncodingForensics } = await import(pathToFileURL(outfile).href);
  const results = [];
  for (const dpi of [72, 140, 160]) {
    results.push(...(await runPdfEncodingForensics(undefined, dpi)).map(row => ({ dpi, ...row })));
  }
  console.table(results);
  await mkdir("scripts/results", { recursive: true });
  await writeFile("scripts/results/pdf-encoding-forensics.json", JSON.stringify(results, null, 2) + "\n");
} finally {
  await rm(outdir, { recursive: true, force: true });
}