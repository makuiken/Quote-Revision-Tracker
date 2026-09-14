import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readdir } from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const source = await readFile(path.join(root, "lib/db/src/schema-release.ts"), "utf8");
const match = source.match(/SCHEMA_RELEASE_ID\s*=\s*"([^"]+)"/);
if (!match) throw new Error("SCHEMA_RELEASE_ID is missing.");

const manifest = JSON.parse(await readFile(path.join(root, "ops/schema-releases.json"), "utf8"));
if (!Array.isArray(manifest.releases) || manifest.releases.length === 0) {
  throw new Error("Schema release manifest is empty.");
}
const ids = manifest.releases.map((release) => release.id);
if (new Set(ids).size !== ids.length) throw new Error("Schema release IDs must be unique.");
if (ids.at(-1) !== match[1]) {
  throw new Error(`Current schema release ${match[1]} is not the latest manifest entry.`);
}
const schemaDir = path.join(root, "lib/db/src/schema");
const schemaFiles = (await readdir(schemaDir))
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => path.join(schemaDir, name));
const contractFiles = [path.join(root, "lib/db/src/ensure-schema.ts"), ...schemaFiles];
const hash = createHash("sha256");
for (const file of contractFiles) {
  hash.update(path.relative(root, file));
  hash.update("\0");
  hash.update(await readFile(file));
  hash.update("\0");
}
const contractHash = hash.digest("hex");
const latest = manifest.releases.at(-1);
if (latest.contractHash !== contractHash) {
  throw new Error(
    `Schema contract changed without a matching release entry. Expected contractHash ${contractHash}.`,
  );
}
const hashSuffix = contractHash.slice(0, 12);
if (!match[1].endsWith(`-${hashSuffix}`)) {
  throw new Error(`SCHEMA_RELEASE_ID must end with the contract hash suffix ${hashSuffix}.`);
}
if (latest.codeReference !== `schema-contract:${contractHash}`) {
  throw new Error("Latest schema release must use its immutable schema-contract hash as codeReference.");
}
console.log(`Release gate verified for schema contract ${match[1]} (${contractHash.slice(0, 12)}).`);