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
      "src/lib/packets/engine.batches.test.ts",
      "src/lib/packets/engine.session.test.ts",
      "src/lib/packets/workerClient.test.ts",
      "src/lib/packets/previewSingleflight.test.ts",
      "src/lib/privateObjectHeaders.test.ts",
      "src/lib/packets/signoffDocument.test.ts",
      "src/lib/packets/recovery.test.ts",
      "src/lib/packets/checkpoints.test.ts",
      "src/lib/packets/pageReuse.test.ts",
      "src/lib/packets/pipeline.test.ts",
      "src/lib/packets/documentBudget.test.ts",
      "src/lib/packets/capacity.test.ts",
      "src/lib/packets/contention.test.ts",
      "src/lib/scopedApprovalModel.test.ts",
      "src/lib/quoteApprovalImpact.test.ts",
      "src/lib/legacyApproval.test.ts",
      "src/lib/scopedPublicQuote.test.ts",
      "src/lib/packets/manifestScope.test.ts",
      "src/lib/packets/templates.test.ts",
      "src/lib/templateLifecycle.test.ts",
      "src/lib/attachmentUploads.test.ts",
    ],
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: [
      "*.node",
      "@napi-rs/canvas",
      "pdfjs-dist",
      "pdfjs-dist/*",
      "playwright-core",
      "chromium-bidi",
      "react",
      "react-dom",
      "react-dom/server",
      "@workspace/db",
    ],
  });
  await build({
    entryPoints: ["src/lib/packets/engineWorker.ts"],
    outfile: join(outdir, "packets", "packets-engine-worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
  });
  // Bundled packet modules retain their `src/lib/packets` relative layout;
  // signoffDocument resolves embedded fonts adjacent to that output folder.
  await cp("assets", join(outdir, "packets", "assets"), { recursive: true });
  await cp(
    "../quote-tracker/public/logo.png",
    join(outdir, "packets", "assets", "logo.png"),
  );
  const files = [
    "packets/checkpoints.test.js",
    "packets/pageReuse.test.js",
    "packets/pipeline.test.js",
    "packets/engine.test.js",
    "packets/engine.batches.test.js",
    "packets/engine.session.test.js",
    "packets/workerClient.test.js",
    "packets/previewSingleflight.test.js",
    "privateObjectHeaders.test.js",
    "packets/signoffDocument.test.js",
    "packets/recovery.test.js",
    "packets/documentBudget.test.js",
    "packets/capacity.test.js",
    "packets/contention.test.js",
    "scopedApprovalModel.test.js",
    "quoteApprovalImpact.test.js",
    "legacyApproval.test.js",
    "scopedPublicQuote.test.js",
    "packets/manifestScope.test.js",
    "packets/templates.test.js",
    "templateLifecycle.test.js",
    "attachmentUploads.test.js",
  ].map((file) => join(outdir, file));
  const child = spawn(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  process.exitCode = code ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}
