#!/usr/bin/env node
// No network access: fixture is a PRIVATE /tmp directory containing source.pdf
// and fixture.json { geometry:[{pageNumber,width,height}], rectangles:{},
// analysisKey, manufacturer }. Never commit a fixture or benchmark PDF output.
// Usage: node scripts/src/task86-private-benchmark.mjs /tmp/private-fixture baseline [15,16]
//        node scripts/src/task86-private-benchmark.mjs /tmp/private-fixture current|session [all]
import { readFile, writeFile, mkdtemp, mkdir, symlink, stat, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { Worker } from "node:worker_threads";

const root = process.cwd();
const [fixtureArg, mode = "baseline", pagesArg = "all"] = process.argv.slice(2);
if (!fixtureArg || !["baseline", "current", "session"].includes(mode)) {
  throw new Error("Usage: task86-private-benchmark.mjs /tmp/private-fixture baseline|current|session [all|15,16]");
}
const fixtureDir = resolve(fixtureArg);
if (!fixtureDir.startsWith("/tmp/") || ((await stat(fixtureDir)).mode & 0o077)) {
  throw new Error("Fixture must be a private mode-0700 directory under /tmp");
}
for (const name of ["source.pdf", "fixture.json"]) {
  if ((await stat(join(fixtureDir, name))).mode & 0o077) throw new Error("Fixture files must be mode 0600");
}
const fixture = JSON.parse(await readFile(join(fixtureDir, "fixture.json"), "utf8"));
const bytes = await readFile(join(fixtureDir, "source.pdf"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceHash = hash(bytes);
if (fixture.analysisKey && hash(JSON.stringify(["packet-analysis-v1", sourceHash, fixture.manufacturer])) !== fixture.analysisKey) {
  throw new Error("Source bytes do not match production packet-analysis-v1 analysis key");
}
const log = (event) => console.log(JSON.stringify({ mode, sourceHash, ...event }));
const affinity = (await readFile("/proc/self/status", "utf8")).match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
const cpu = affinity?.split(/[,-]/)[0];
if (!cpu || !/^\d+$/.test(cpu)) throw new Error("Cannot establish one available CPU");
execFileSync("taskset", ["-apc", cpu, String(process.pid)], { stdio: "ignore" });
const scratch = await mkdtemp("/tmp/task86-engine-");
await chmod(scratch, 0o700);
await symlink(join(root, "artifacts/api-server/node_modules"), join(scratch, "node_modules"));
const relative = "artifacts/api-server/src/lib/packets";
let entry = join(root, relative, "engineWorker.ts");
let revision = "working-tree";
if (mode === "baseline") {
  revision = process.env.TASK86_BASELINE_REV ?? "fd1de4c3ea0ebd207bc3678b229fb1823856d427";
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, relative], { encoding: "utf8" }).trim().split("\n");
  await mkdir(join(scratch, "packets"));
  for (const path of paths.filter((p) => p.endsWith(".ts"))) {
    await writeFile(join(scratch, "packets", path.split("/").at(-1)), execFileSync("git", ["show", `${revision}:${path}`]), { mode: 0o600 });
  }
  entry = join(scratch, "packets/engineWorker.ts");
}
const require = createRequire(join(root, "artifacts/api-server/package.json"));
const { build } = require("esbuild");
const workerPath = join(scratch, "engineWorker.mjs");
await build({ entryPoints: [entry], outfile: workerPath, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
await chmod(workerPath, 0o600);
const batches = pagesArg === "all"
  ? fixture.geometry.reduce((out, page, index) => { if (index % 2 === 0) out.push([]); out.at(-1).push(page.pageNumber); return out; }, [])
  : [pagesArg.split(",").map(Number)];
if (batches.some((batch) => batch.some((n) => !fixture.geometry.some((p) => p.pageNumber === n)))) throw new Error("Invalid page selection");
log({ stage: "start", revision, pageCount: fixture.pageCount, batches: batches.length, cpu: Number(cpu), oldGenerationMb: 384, youngGenerationMb: 64, deadlineMs: 90000 });
const selectionPages = fixture.geometry.map(({ pageNumber, width, height }) => ({
  pageNumber, expectedWidth: width, expectedHeight: height,
  bounds: (fixture.rectangles[String(pageNumber)] ?? []).map((rect) => ({
    x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height,
  })),
}));
const makeWorker = () => new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64 } });
const request = (worker, message) => new Promise((resolveResult) => {
  const finish = (result) => {
    clearTimeout(timer);
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
    resolveResult(result);
  };
  const onMessage = (result) => {
    if (result.progress) {
      const { phase, pageNumber, elapsedMs, rss } = result.progress;
      log({ stage: phase, pageNumber, elapsedMs, rss });
    } else finish(result);
  };
  const onError = () => finish({ ok: false, error: { code: "WORKER_ERROR" } });
  const onExit = (code) => finish({ ok: false, error: { code: `WORKER_EXIT_${code}` } });
  const timer = setTimeout(() => finish({ ok: false, error: { code: "DEADLINE" } }), 90000);
  worker.on("message", onMessage);
  worker.once("error", onError);
  worker.once("exit", onExit);
  worker.postMessage(message);
});
const sessionWorker = mode === "session" ? makeWorker() : null;
if (sessionWorker) {
  const started = performance.now();
  const opened = await request(sessionWorker, { operation: "sessionOpen", bytes, selection: { pages: selectionPages } });
  log({ stage: opened.ok ? "session-open-complete" : "session-open-failed", elapsedMs: Math.round(performance.now() - started) });
  if (!opened.ok) { await sessionWorker.terminate(); process.exit(1); }
}
for (const pageOrder of batches) {
  const started = performance.now();
  const worker = sessionWorker ?? makeWorker();
  log({ stage: "batch-start", pageOrder });
  const result = await request(worker, sessionWorker
    ? { operation: "sessionBatch", pageOrder }
    : { operation: "sanitize", bytes, selection: { pageOrder, pages: selectionPages } });
  if (!sessionWorker) await worker.terminate();
  log({ stage: result.ok ? "batch-complete" : "batch-failed", pageOrder, elapsedMs: Math.round(performance.now() - started),
    ...(result.ok ? { pdfBytes: result.result.pdf.length, diagnostics: result.result.diagnostics } : { errorCode: result.error?.code ?? "SANITIZE_FAILED" }) });
  if (!result.ok) { process.exitCode = 1; break; }
}
if (sessionWorker) await sessionWorker.terminate();