import { build } from "esbuild";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1") {
  throw new Error("Checkpoint cleanup integration is development-only.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = await mkdtemp(join(root, ".checkpoint-cleanup-tests-"));
try {
  const dbRequire = createRequire(resolve(root, "../../lib/db/package.json"));
  await mkdir(join(out, "node_modules"));
  await symlink(dirname(dbRequire.resolve("pg/package.json")), join(out, "node_modules/pg"), "dir");
  await symlink(resolve(root, "../../lib/db/node_modules/drizzle-zod"), join(out, "node_modules/drizzle-zod"), "dir");
  await build({
    entryPoints: [join(root, "scripts/checkpoint-cleanup-development.ts")],
    outfile: join(out, "test.mjs"), bundle: true, packages: "external",
    alias: { "@workspace/db": resolve(root, "../../lib/db/src/index.ts") },
    platform: "node", format: "esm", target: "node20",
  });
  const child = spawn(process.execPath, [join(out, "test.mjs")], { cwd: root, stdio: "inherit", env: process.env });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`Checkpoint integration exited ${code}`);
} finally {
  await rm(out, { recursive: true, force: true });
}