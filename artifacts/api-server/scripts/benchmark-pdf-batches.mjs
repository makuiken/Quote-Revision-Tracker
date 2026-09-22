import { Worker } from "node:worker_threads";
import { cpus, tmpdir } from "node:os";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import { PDFDocument } from "pdf-lib";

const BATCH_SIZE = 2;
const INTERRUPT_AFTER_PAGES = 10;
const RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 384,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8,
};
let workerPath;
const root = resolve("../..");
const keep = process.argv.includes("--keep");
const runBaseline = process.argv.includes("--baseline");
const explicitSource = process.argv.find((argument) => argument.endsWith(".pdf"));

async function findFortyPageSource() {
  if (explicitSource) {
    const path = resolve(explicitSource);
    const pdf = await PDFDocument.load(await readFile(path));
    if (pdf.getPageCount() !== 40) throw new Error("The supplied benchmark PDF must have exactly 40 pages.");
    return path;
  }
  const directory = join(root, "attached_assets");
  for (const name of (await readdir(directory)).filter((value) => value.toLowerCase().endsWith(".pdf"))) {
    const path = join(directory, name);
    try {
      const pdf = await PDFDocument.load(await readFile(path));
      if (pdf.getPageCount() === 40) return path;
    } catch {
      // Ignore unrelated malformed attachments without printing private names.
    }
  }
  throw new Error("No 40-page PDF was found under attached_assets.");
}

async function runWorker(request) {
  const worker = new Worker(workerPath, {
    resourceLimits: RESOURCE_LIMITS,
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
  });
  return await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Worker exceeded the 90-second production hard limit."));
    }, 90_000);
    const finish = async (callback) => {
      clearTimeout(timer);
      await worker.terminate();
      callback();
    };
    worker.once("message", (message) => {
      if (message?.ok) void finish(() => resolveResult(message.result));
      else void finish(() => reject(new Error(message?.error?.message ?? "Worker failed.")));
    });
    worker.once("error", (error) => void finish(() => reject(error)));
    worker.postMessage(request);
  });
}

async function validPersistedBatch(pdfPath, metadataPath, startPage, endPage) {
  try {
    const [bytes, metadata] = await Promise.all([
      readFile(pdfPath),
      readFile(metadataPath, "utf8").then(JSON.parse),
    ]);
    const expectedCount = endPage - startPage + 1;
    return metadata.startPage === startPage
      && metadata.endPage === endPage
      && (await PDFDocument.load(bytes)).getPageCount() === expectedCount;
  } catch {
    return false;
  }
}

async function main() {
  const harnessDirectory = await mkdtemp(join(tmpdir(), "pdf-worker-harness-"));
  workerPath = join(harnessDirectory, "packets-engine-worker.mjs");
  await symlink(resolve("node_modules"), join(harnessDirectory, "node_modules"), "dir");
  await build({
    entryPoints: [resolve("src/lib/packets/engineWorker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: workerPath,
    external: ["*.node", "@napi-rs/canvas", "pdfjs-dist", "pdfjs-dist/*"],
    logLevel: "silent",
  });
  const sourcePath = await findFortyPageSource();
  const sourceBytes = await readFile(sourcePath);
  const source = await PDFDocument.load(sourceBytes);
  const sourcePages = source.getPageCount();
  const directory = await mkdtemp(join(tmpdir(), "pdf-batch-benchmark-"));
  const batchDirectory = join(directory, "batches");
  await mkdir(batchDirectory, { mode: 0o700 });

  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  const started = performance.now();
  const timings = [];
  let skippedOnResume = 0;

  async function processRange(startPage) {
    const endPage = Math.min(sourcePages, startPage + BATCH_SIZE - 1);
    const id = String(startPage).padStart(3, "0");
    const pdfPath = join(batchDirectory, `${id}.pdf`);
    const metadataPath = join(batchDirectory, `${id}.json`);
    if (await validPersistedBatch(pdfPath, metadataPath, startPage, endPage)) {
      skippedOnResume++;
      return;
    }
    const batchStarted = performance.now();
    const result = await runWorker({
      operation: "sanitize",
      bytes: new Uint8Array(sourceBytes),
      selection: {
        pages: [],
        pageOrder: Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index),
      },
    });
    if (result.pageCount !== endPage - startPage + 1) {
      throw new Error("Worker returned an unexpected batch page count.");
    }
    await writeFile(pdfPath, result.pdf);
    await writeFile(metadataPath, JSON.stringify({ startPage, endPage }));
    timings.push(performance.now() - batchStarted);
  }

  try {
    // Phase one intentionally stops after ten pages. The second pass starts at
    // page one and proves that valid disk artifacts are skipped.
    for (let page = 1; page <= INTERRUPT_AFTER_PAGES; page += BATCH_SIZE) await processRange(page);
    const interruptionElapsedMs = performance.now() - started;
    for (let page = 1; page <= sourcePages; page += BATCH_SIZE) await processRange(page);

    const inputPaths = [];
    for (let page = 1; page <= sourcePages; page += BATCH_SIZE) {
      inputPaths.push(join(batchDirectory, `${String(page).padStart(3, "0")}.pdf`));
    }
    const mergedPath = join(batchDirectory, "merged.pdf");
    const mergeStarted = performance.now();
    await runWorker({ operation: "mergeSanitizedBatchFiles", inputPaths, outputPath: mergedPath });
    const mergeMs = performance.now() - mergeStarted;
    const mergedPages = (await PDFDocument.load(await readFile(mergedPath))).getPageCount();
    const batchElapsedMs = performance.now() - started;
    const batchPeakRss = peakRss;

    let baseline = null;
    if (runBaseline) {
      peakRss = process.memoryUsage().rss;
      const baselineStarted = performance.now();
      const result = await runWorker({
        operation: "sanitize",
        bytes: new Uint8Array(sourceBytes),
        selection: {
          pages: [],
          pageOrder: Array.from({ length: sourcePages }, (_, index) => index + 1),
        },
      });
      baseline = {
        elapsedMs: Math.round(performance.now() - baselineStarted),
        pages: result.pageCount,
        peakRssMiBIncludingWorkerThreads: Math.round(peakRss / 1024 / 1024),
      };
    }
    clearInterval(sample);
    const report = {
      constraints: {
        cpuAffinity: process.env.BENCHMARK_CPU_AFFINITY ?? `${cpus().length} visible CPUs (not pinned)`,
        productionWorkerResourceLimits: RESOURCE_LIMITS,
        note: "Local constraint only; not a production measurement.",
      },
      source: { label: "attached 40-page benchmark PDF", pages: sourcePages },
      batching: {
        batchSize: BATCH_SIZE,
        persistedBatches: inputPaths.length,
        interruptionAfterPages: INTERRUPT_AFTER_PAGES,
        interruptionElapsedMs: Math.round(interruptionElapsedMs),
        skippedPersistedBatchesOnResume: skippedOnResume,
        elapsedMs: Math.round(batchElapsedMs),
        maxBatchMs: Math.round(Math.max(...timings)),
        mergeMs: Math.round(mergeMs),
        peakRssMiBIncludingWorkerThreads: Math.round(batchPeakRss / 1024 / 1024),
        selectedPages: sourcePages,
        mergedPages,
        requestedSequentialPageOrderAndCountVerified: mergedPages === sourcePages,
      },
      baseline,
      artifactsRetained: keep ? directory : false,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearInterval(sample);
    if (!keep) await rm(directory, { recursive: true, force: true });
    await rm(harnessDirectory, { recursive: true, force: true });
  }
}

await main();