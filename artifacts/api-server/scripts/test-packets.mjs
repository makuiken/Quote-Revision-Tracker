import { build } from "esbuild";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Keep output under this package so ESM externals walk up to its node_modules.
const outdir = await mkdtemp(join(process.cwd(), ".packet-tests-"));
try {
  await build({
    entryPoints: [
      "src/lib/packets/engine.test.ts",
      "src/lib/packets/workerClient.test.ts",
      "src/lib/packets/signoffDocument.test.ts",
      "src/lib/packets/recovery.test.ts",
      "src/lib/packets/documentBudget.test.ts",
    ],
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["*.node", "@napi-rs/canvas", "pdfjs-dist", "pdfjs-dist/*"],
  });
  await cp("assets", join(outdir, "assets"), { recursive: true });
  const files = [
    "engine.test.js",
    "workerClient.test.js",
    "signoffDocument.test.js",
    "recovery.test.js",
    "documentBudget.test.js",
  ].map((file) => join(outdir, file));
  const child = spawn(process.execPath, ["--test", ...files], {
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  process.exitCode = code ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}