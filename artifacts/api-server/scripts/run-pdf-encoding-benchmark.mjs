import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const outdir = await mkdtemp(join(process.cwd(), ".pdf-encoding-benchmark-"));
try {
  await build({
    entryPoints: ["scripts/pdf-encoding-benchmark.ts"],
    outfile: join(outdir, "benchmark.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["*.node", "@napi-rs/canvas", "pdfjs-dist", "pdfjs-dist/*"],
  });
  const child = spawn(process.execPath, [join(outdir, "benchmark.mjs"), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  process.exitCode = code ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}