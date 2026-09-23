import { build } from "esbuild";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1") {
  throw new Error("This integration harness is development-only.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = await mkdtemp(join(root, ".checkpoint-evidence-"));
try {
  // pg belongs to the DB workspace rather than the API workspace. Preserve its
  // native package layout while exposing it only to this temporary bundle.
  const dbRequire = createRequire(resolve(root, "../../lib/db/package.json"));
  await mkdir(join(out, "node_modules"));
  await symlink(dirname(dbRequire.resolve("pg/package.json")), join(out, "node_modules/pg"), "dir");
  await symlink(resolve(root, "../../lib/db/node_modules/drizzle-zod"), join(out, "node_modules/drizzle-zod"), "dir");
  await build({
    entryPoints: {
      harness: join(root, process.argv.includes("--safe-page-reuse-cleanup")
        ? "scripts/safe-page-reuse-cleanup-development.ts" : process.argv.includes("--safe-page-reuse")
        ? "scripts/safe-page-reuse-development.ts" : "scripts/checkpoint-resume-development.ts"),
      "packets-engine-worker": join(root, "src/lib/packets/engineWorker.ts"),
    },
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    packages: "external",
    alias: { "@workspace/db": resolve(root, "../../lib/db/src/index.ts") },
    platform: "node",
    format: "esm",
    target: "node20",
  });
  const child = spawn(process.execPath, [join(out, "harness.mjs")], {
    cwd: root, stdio: "inherit", env: process.env,
  });
  process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
} finally {
  await rm(out, { recursive: true, force: true });
}