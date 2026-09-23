// Isolated renderer probe only: not a production replacement or full pipeline.
import { spawnSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { createCanvas, loadImage } from "@napi-rs/canvas";
const root = "/tmp/task89-private";
const source = await readFile("/tmp/task86-private/source.pdf");
const rows = [];
for (const page of [15, 16]) {
  const started = performance.now();
  const proc = spawnSync("bash", ["-c", 'ulimit -v 1048576; exec timeout 60 pdftoppm -f "$1" -l "$1" -singlefile -r 160 -png "$2" "$3"', "probe", String(page), "/tmp/task86-private/source.pdf", `${root}/native-${page}`], { timeout: 65000, stdio: "pipe" });
  if (proc.status !== 0) throw new Error(`Native renderer probe failed, exit ${proc.status}`);
  const nativeMs = performance.now() - started;
  const workerStarted = performance.now();
  const worker = new Worker(new URL("../.pipeline89-baseline/packets-engine-worker.mjs", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 } });
  const bytes = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Worker timeout")); }, 65000);
    worker.once("error", error => { clearTimeout(timer); reject(error); });
    worker.on("message", message => {
      if (typeof message.ok !== "boolean") return;
      clearTimeout(timer);
      if (message.ok) resolve(message.result); else reject(new Error("Worker preview failed"));
    });
    worker.postMessage({ operation: "preview", bytes: source, pageNumber: page, options: { dpi: 160 } });
  });
  await worker.terminate();
  const workerMs = performance.now() - workerStarted;
  const native = await loadImage(await readFile(`${root}/native-${page}.png`));
  const current = await loadImage(Buffer.from(bytes));
  let changed = null;
  if (native.width === current.width && native.height === current.height) {
    const data = image => { const canvas = createCanvas(image.width,image.height); const context=canvas.getContext("2d");context.drawImage(image,0,0);return context.getImageData(0,0,image.width,image.height).data; };
    const a=data(native), b=data(current);
    changed=0;
    for(let i=0;i<a.length;i+=4) if(a[i]!==b[i] || a[i+1]!==b[i+1] || a[i+2]!==b[i+2] || a[i+3]!==b[i+3]) changed++;
  }
  rows.push({page,nativeMs:Math.round(nativeMs),workerMs:Math.round(workerMs),nativeDimensions:[native.width,native.height],currentDimensions:[current.width,current.height],changedPixels:changed});
  await rm(`${root}/native-${page}.png`);
}
await writeFile(`${root}/native.json`, JSON.stringify(rows,null,2),{mode:0o600});
console.log(JSON.stringify(rows));