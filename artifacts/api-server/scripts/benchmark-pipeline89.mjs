// Development-only, real processPacket/DB/object-storage benchmark. No HTTP server.
// Run from artifacts/api-server. Private results stay outside the repository.
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PDFDocument } from "pdf-lib";

const root = resolve("../..");
const privateDir = "/tmp/task89-private";
const mode = process.argv[2] ?? "baseline";
const count = Number(process.argv[3] ?? 3);
const fixture = process.argv[4] ?? "31";
if (!["baseline", "candidate"].includes(mode) || ![31, 40].includes(Number(fixture)) || !Number.isInteger(count) || count < 1 || count > 3) throw new Error("Usage: benchmark-pipeline89.mjs baseline|candidate 1..3 31|40");
if (process.env.REPLIT_DEPLOYMENT || new URL(process.env.DATABASE_URL).hostname !== "helium") throw new Error("Refusing non-development database/environment.");
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const baseline = "2d583bf87051b1d7770b6a062570f89b99ce8dd2";
const outdir = resolve(`.pipeline89-${mode}`);
await mkdir(outdir, { recursive: true, mode: 0o700 });
let source = "/tmp/task86-private/source.pdf";
if (fixture === "40") {
  source = "";
  for (const name of await readdir(join(root, "attached_assets"))) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const path = join(root, "attached_assets", name);
    if ((await PDFDocument.load(await readFile(path))).getPageCount() === 40) { source = path; break; }
  }
  if (!source) throw new Error("Authentic 40-page attachment unavailable.");
}
const frozen = {
  name: "frozen-baseline",
  setup(builder) {
    builder.onLoad({ filter: /\/src\/lib\/logger\.ts$/ }, () => ({
      contents: `export const logger = { info(data, msg) { if (msg === "Packet processing stage timings" || msg === "Packet page checkpoint committed") console.log(JSON.stringify({event:msg,...data})); }, warn(){}, error(){}, debug(){} };`,
      loader: "ts",
    }));
    if (mode === "candidate") builder.onLoad({ filter: /\/src\/lib\/packets\/pipeline\.ts$/ }, async ({ path }) => ({
      contents: (await readFile(path, "utf8")).replace(
        "return Object.values(input).every",
        'const admitted = Object.values(input).every',
      ).replace(
        "768 * MiB;",
        '768 * MiB; console.log(JSON.stringify({event:"benchmark-admission",...input,admitted})); return admitted;',
      ),
      loader: "ts", resolveDir: resolve(path, ".."),
    }));
    if (mode === "baseline") builder.onLoad({ filter: /\/src\/lib\/packets\/.*\.ts$/ }, ({ path }) => ({
      contents: execFileSync("git", ["show", baseline + ":" + path.slice(root.length + 1)], { cwd: root, encoding: "utf8" }),
      loader: "ts", resolveDir: resolve(path, ".."),
    }));
  },
};
const options = {
  bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["pg-native", "pino", "@google-cloud/storage", "google-auth-library", "@napi-rs/canvas", "pdfjs-dist", "pdfjs-dist/*", "playwright-core", "react", "react-dom", "react-dom/server"],
  plugins: [frozen],
  banner: { js: 'import {createRequire as __cr} from "node:module"; const require = __cr(import.meta.url);' },
};
await build({ ...options, entryPoints: ["src/lib/packets/engineWorker.ts"], outfile: join(outdir, "packets-engine-worker.mjs") });
await build({ ...options, stdin: { contents: `
import { readFile, writeFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID, createHash } from "node:crypto";
import { db, pool, quotesTable, manufacturerPacketsTable, packetCheckpointObjectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ObjectStorageService } from "./src/lib/objectStorage";
import { processPacket } from "./src/lib/packets/service";
import { checkpointObjectPaths } from "./src/lib/packets/checkpoints";
import { PDFDocument } from "pdf-lib";
const storage = new ObjectStorageService();
// Recover only this harness's interrupted fixtures, never arbitrary packet rows.
for(const name of await readdir(${JSON.stringify(privateDir)})) {
  if(!name.startsWith("benchmark89-") || !name.endsWith(".json")) continue;
  const ledgerPath=${JSON.stringify(privateDir)}+"/"+name;
  const ledger=JSON.parse(await readFile(ledgerPath,"utf8"));
  if(ledger.cleaned) continue;
  const [q]=await db.select().from(quotesTable).where(eq(quotesTable.id,ledger.quoteId));
  if(q && q.quoteNumber!==name.slice(0,-5)) throw new Error("Cleanup ownership mismatch");
  const paths=new Set(ledger.paths);
  if(ledger.packetId) {
    const [p]=await db.select().from(manufacturerPacketsTable).where(eq(manufacturerPacketsTable.id,ledger.packetId));
    if(p && p.quoteId!==ledger.quoteId) throw new Error("Cleanup packet ownership mismatch");
    if(p?.status==="processing") throw new Error("Interrupted fixture may have live writer; wait for recovery before cleanup.");
    if(p) {
      checkpointObjectPaths(p.processingState).forEach(x=>paths.add(x));
      (p.sanitizedPageObjectPaths??[]).forEach(x=>paths.add(x));
      if(p.sanitizedPdfObjectPath) paths.add(p.sanitizedPdfObjectPath);
    }
    for(const row of await db.select().from(packetCheckpointObjectsTable).where(eq(packetCheckpointObjectsTable.packetId,ledger.packetId))) paths.add(row.objectPath);
  }
  for(const path of paths) await storage.deleteObjectEntity(path);
  if(ledger.packetId) await db.delete(packetCheckpointObjectsTable).where(eq(packetCheckpointObjectsTable.packetId,ledger.packetId));
  if(q) await db.delete(quotesTable).where(eq(quotesTable.id,q.id));
  await writeFile(ledgerPath,JSON.stringify({cleaned:true,objectCount:paths.size}),{mode:0o600});
}
const source = await readFile(${JSON.stringify(source)});
const fixture = JSON.parse(await readFile("/tmp/task86-private/fixture.json","utf8"));
const results = [];
try {
for (let iteration = 1; iteration <= ${count}; iteration++) {
  const tag = "benchmark89-" + randomUUID();
  let quoteId, packetId;
  const paths = new Set();
  const ledger = ${JSON.stringify(privateDir)} + "/" + tag + ".json";
  try {
    const [quote] = await db.insert(quotesTable).values({quoteNumber:tag,customerName:"Temporary performance fixture",categories:[],createdById:tag,createdByName:"Benchmark"}).returning();
    quoteId = quote.id;
    const sourcePath = "/objects/benchmark89/" + tag + "/source.pdf";
    paths.add(sourcePath);
    await writeFile(ledger, JSON.stringify({quoteId, paths:[...paths]}), {mode:0o600});
    await storage.saveObjectEntityImmutable(sourcePath,source,"application/pdf");
    const [packet] = await db.insert(manufacturerPacketsTable).values({
      quoteId,originalName:"benchmark.pdf",declaredSize:source.length,uploadObjectPath:sourcePath,sourceObjectPath:sourcePath,
      manufacturer:${fixture === "31" ? "fixture.manufacturer" : "null"},manualRedactions:${fixture === "31" ? "fixture.rectangles" : "{}"},status:"queued"
    }).returning();
    packetId=packet.id;
    await writeFile(ledger, JSON.stringify({quoteId,packetId,paths:[...paths]}), {mode:0o600});
    console.log(JSON.stringify({event:"benchmark-start",mode:${JSON.stringify(mode)},fixture:${fixture},iteration,packetId}));
    const start = performance.now();
    const outcome = await processPacket(packetId,false);
    const elapsedMs = Math.round(performance.now()-start);
    const [finished] = await db.select().from(manufacturerPacketsTable).where(eq(manufacturerPacketsTable.id,packetId));
    if (outcome !== "processed" || finished.status !== "ready_for_approval") throw new Error("Benchmark failed: " + finished.status + " / " + finished.failureMessage);
    const bytes = await storage.downloadObjectBytesBounded(finished.sanitizedPdfObjectPath,120*1024*1024);
    const pdf = await PDFDocument.load(bytes);
    if(pdf.getPageCount() !== ${fixture}) throw new Error("Output page count mismatch.");
    const pageHashes=[];
    for(const path of finished.sanitizedPageObjectPaths) {
      const bytes=await storage.downloadObjectBytesBounded(path,40*1024*1024);
      pageHashes.push(createHash("sha256").update(bytes).digest("hex"));
    }
    results.push({mode:${JSON.stringify(mode)},fixture:${fixture},iteration,elapsedMs,pageCount:pdf.getPageCount(),outputBytes:bytes.length,pageHashes,geometry:pdf.getPages().map(p=>p.getSize())});
    console.log(JSON.stringify({event:"benchmark-result",...results.at(-1)}));
  } finally {
    if (packetId) {
      const [packet] = await db.select().from(manufacturerPacketsTable).where(eq(manufacturerPacketsTable.id,packetId));
      if(packet) {
        for (const p of checkpointObjectPaths(packet.processingState)) paths.add(p);
        for (const p of packet.sanitizedPageObjectPaths ?? []) paths.add(p);
        if(packet.sanitizedPdfObjectPath) paths.add(packet.sanitizedPdfObjectPath);
      }
      for (const row of await db.select().from(packetCheckpointObjectsTable).where(eq(packetCheckpointObjectsTable.packetId,packetId))) paths.add(row.objectPath);
    }
    await writeFile(ledger,JSON.stringify({quoteId,packetId,paths:[...paths]}),{mode:0o600});
    // processPacket has settled; no writer remains. Delete registry rows only after all objects.
    for (const path of paths) await storage.deleteObjectEntity(path);
    if(packetId) await db.delete(packetCheckpointObjectsTable).where(eq(packetCheckpointObjectsTable.packetId,packetId));
    if(quoteId) await db.delete(quotesTable).where(eq(quotesTable.id,quoteId));
    await writeFile(ledger,JSON.stringify({cleaned:true,objectCount:paths.size}),{mode:0o600});
    console.log(JSON.stringify({event:"benchmark-cleanup",objects:paths.size,rowsRemoved:true}));
  }
}
await writeFile(${JSON.stringify(join(privateDir, `${mode}-${fixture}.json`))},JSON.stringify(results,null,2),{mode:0o600});
} finally { await pool.end(); }
`, resolveDir: process.cwd(), sourcefile: "pipeline89-run.ts", loader: "ts" }, outfile: join(outdir, "run.mjs") });
await writeFile(join(privateDir, `${mode}-${fixture}-build.json`), JSON.stringify({ baseline, mode, fixture, count, builtAt: new Date().toISOString() }), { mode: 0o600 });
const child = spawn(process.execPath, [join(outdir, "run.mjs")], { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
child.on("exit", code => process.exitCode = code ?? 1);