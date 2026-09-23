#!/usr/bin/env node
// Six fresh child processes; local disk checkpoints only. No network operations.
// node scripts/src/task86-private-comparison.mjs /tmp/task86-private
import { readFile, writeFile, mkdtemp, mkdir, symlink, chmod, stat } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
const root = process.cwd();
const fixture = resolve(process.argv[2] ?? "");
if (!fixture.startsWith("/tmp/") || ((await stat(fixture)).mode & 0o077)) throw Error("Private /tmp fixture required");
const require = createRequire(join(root, "artifacts/api-server/package.json"));
const { build } = require("esbuild");
const cpu = (await readFile("/proc/self/status", "utf8")).match(/^Cpus_allowed_list:\s*(\d+)/m)?.[1];
if (!cpu) throw Error("No available CPU");
const scratch = await mkdtemp("/tmp/task86-comparison-");
await chmod(scratch, 0o700);
await symlink(join(root, "artifacts/api-server/node_modules"), join(scratch, "node_modules"));
const revision = process.env.TASK86_BASELINE_REV ?? "fd1de4c3ea0ebd207bc3678b229fb1823856d427";
const packetDir = "artifacts/api-server/src/lib/packets";
const results = [];
for (const mode of ["baseline", "session"]) {
  const dir = join(scratch, mode);
  await mkdir(dir, { mode: 0o700 });
  let sourceDir = join(root, packetDir);
  if (mode === "baseline") {
    sourceDir = join(dir, "source");
    await mkdir(sourceDir, { mode: 0o700 });
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, packetDir], { encoding: "utf8" }).trim().split("\n");
    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      await writeFile(join(sourceDir, file.split("/").at(-1)), execFileSync("git", ["show", `${revision}:${file}`]), { mode: 0o600 });
    }
  }
  await build({ entryPoints: [join(sourceDir, "engineWorker.ts")], outfile: join(dir, "packets-engine-worker.mjs"), bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const code = `
import * as engine from ${JSON.stringify(join(sourceDir, "engine.ts"))};
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const [fixture,output,validate]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
const f=JSON.parse(await readFile(fixture+'/fixture.json','utf8'));
const bytes=await readFile(fixture+'/source.pdf');
const sourceHash=hash(bytes);
if(hash(JSON.stringify(['packet-analysis-v1',sourceHash,f.manufacturer]))!==f.analysisKey)throw Error('Source mismatch');
await mkdir(output,{mode:0o700});
const before=process.memoryUsage(); let peakRss=before.rss;
const sample=()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss)};
const timer=setInterval(sample,20);
const pages=[];const paths=[];const geometry=[];const timings=[];const progress=[];
const started=performance.now();
const persist=async(result,order,start)=>{
  const path=output+'/batch-'+paths.length+'.pdf';
  await writeFile(path,result.pdfBytes,{mode:0o600});
  paths.push(path);geometry.push(result.pages.map(p=>({width:p.width,height:p.height})));
  for(let i=0;i<result.pages.length;i++){
    const p=result.pages[i];pages.push({pageNumber:order[i],pngHash:hash(p.pngBytes)});
    await writeFile(output+'/page-'+order[i]+'.png',p.pngBytes,{mode:0o600});
  }
  sample();timings.push({order,elapsedMs:performance.now()-start});
};
const input={bytes,pageDimensions:f.geometry,redactionsByPage:f.rectangles};
if(${JSON.stringify(mode)}==='session'){
  await engine.withPacketSanitizationSession(input,async(session)=>{
    for(const p of f.geometry){const start=performance.now();await persist(await session.generateBatch([p.pageNumber]),[p.pageNumber],start);}
  },{onProgress:p=>{peakRss=Math.max(peakRss,p.rss);progress.push({phase:p.phase,pageNumber:p.pageNumber,elapsedMs:p.elapsedMs,rss:p.rss});}});
}else{
  for(let i=0;i<f.geometry.length;i+=2){
    const order=f.geometry.slice(i,i+2).map(p=>p.pageNumber);const start=performance.now();
    await persist(await engine.packetEngine.generateSanitizedPacket({...input,manufacturer:f.manufacturer,pageOrder:order}),order,start);
  }
}
const renderMs=performance.now()-started;
const mergeStart=performance.now();
await engine.mergePacketPdfFilesInWorker(paths,output+'/merged.pdf',geometry);
const totalMs=performance.now()-started;sample();clearInterval(timer);
const after=process.memoryUsage();
const result={mode:${JSON.stringify(mode)},sourceHash,totalMs,renderMs,mergeMs:performance.now()-mergeStart,peakRss,before,after,timings,progress,pages};
// Validation is deliberately outside benchmark timing and memory sampling.
if(validate==='yes'){
  const {PDFDocument}=await import('pdf-lib');
  const {createCanvas,loadImage}=await import('@napi-rs/canvas');
  const merged=await readFile(output+'/merged.pdf');const parsed=await PDFDocument.load(merged);
  if(parsed.getPageCount()!==f.geometry.length)throw Error('Merged page count mismatch');
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading=pdfjs.getDocument({data:new Uint8Array(merged),useSystemFonts:true,isEvalSupported:false});
  const doc=await loading.promise;
  for(const p of pages){
    const image=await loadImage(await readFile(output+'/page-'+p.pageNumber+'.png'));
    const canvas=createCanvas(image.width,image.height);const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    p.pixelHash=hash(ctx.getImageData(0,0,image.width,image.height).data);
    const page=await doc.getPage(p.pageNumber);const viewport=page.getViewport({scale:160/72});
    const raster=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));const context=raster.getContext('2d');
    await page.render({canvasContext:context,viewport}).promise;
    p.finalPdfPixelHash=hash(context.getImageData(0,0,raster.width,raster.height).data);
    p.finalWidth=raster.width;p.finalHeight=raster.height;page.cleanup();
  }
  await loading.destroy();
}
await writeFile(output+'/result.json',JSON.stringify(result),{mode:0o600});
console.log(JSON.stringify({stage:'complete',mode:result.mode,sourceHash,totalMs,renderMs,mergeMs:result.mergeMs,peakRss,beforeRss:before.rss,afterRss:after.rss}));
`;
  await build({ stdin: { contents: code, sourcefile: "comparison.ts", resolveDir: root }, outfile: join(dir, "run.mjs"), bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  for (let run = 1; run <= 3; run++) {
    const output = join(dir, "run-" + run);
    await new Promise((ok, fail) => {
      const child = spawn("taskset", ["-c", cpu, process.execPath, join(dir, "run.mjs"), fixture, output, run === 1 ? "yes" : "no"], { stdio: ["ignore", "pipe", "pipe"] });
      let logs = "";
      child.stdout.on("data", (b) => { logs += b; });
      child.stderr.on("data", (b) => { logs += b; });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 240000);
      child.on("error", fail);
      child.on("close", async (exit) => {
        clearTimeout(deadline);
        await writeFile(join(dir, "run-" + run + ".log"), logs, { mode: 0o600 });
        if (exit) fail(Error("Benchmark child failed; private log in " + dir));
        else ok();
      });
    });
    const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
    results.push({ ...result, run });
    console.log(JSON.stringify({ stage: "run-complete", mode, run, totalMs: result.totalMs, peakRss: result.peakRss }));
  }
}
const baseline = results.find((r) => r.mode === "baseline");
const session = results.find((r) => r.mode === "session");
const equality = baseline.pages.every((p, i) => ["pngHash", "pixelHash", "finalPdfPixelHash", "finalWidth", "finalHeight"].every((k) => p[k] === session.pages[i][k]));
const summary = { cpu: Number(cpu), revision, runs: results.map(({ mode, run, totalMs, renderMs, mergeMs, peakRss, before, after }) => ({ mode, run, totalMs, renderMs, mergeMs, peakRss, before, after })), exactAllPagesEqual: equality };
for (const mode of ["baseline", "session"]) {
  const times = results.filter((r) => r.mode === mode).map((r) => r.totalMs).sort((a, b) => a - b);
  summary[mode] = { medianMs: times[1], p95NearestRankMs: times[2], n: 3 };
}
summary.medianImprovementPercent = 100 * (1 - summary.session.medianMs / summary.baseline.medianMs);
await writeFile(join(fixture, "comparison-summary.json"), JSON.stringify(summary), { mode: 0o600 });
await writeFile(join(fixture, "comparison-location.txt"), scratch, { mode: 0o600 });
console.log(JSON.stringify(summary));