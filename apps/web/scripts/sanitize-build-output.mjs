import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(webRoot, "dist");
const clientAssetsRoot = resolve(buildRoot, "client", "assets");
const MAX_CLIENT_ENTRY_BYTES = 600_000;
const MAX_CLIENT_ENTRY_GZIP_BYTES = 175_000;

function isLocalEnvironmentFile(filePath) {
  const name = basename(filePath);
  return name === ".env"
    || name.startsWith(".env.")
    || name === ".dev.vars"
    || name.startsWith(".dev.vars.");
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

const localEnvironmentFiles = walk(buildRoot).filter(isLocalEnvironmentFile);
for (const filePath of localEnvironmentFiles) rmSync(filePath);

const remainingSensitiveFiles = walk(buildRoot).filter(isLocalEnvironmentFile);
if (remainingSensitiveFiles.length > 0) {
  throw new Error(`Production output still contains local environment files: ${remainingSensitiveFiles.join(", ")}`);
}

if (localEnvironmentFiles.length > 0) {
  console.log(`Removed ${localEnvironmentFiles.length} local environment file(s) from production output.`);
}

const clientEntryBundles = walk(clientAssetsRoot).filter((filePath) =>
  /^main-[\w-]+\.js$/.test(basename(filePath)),
);
if (clientEntryBundles.length !== 1) {
  throw new Error(
    `Expected one client main bundle, found ${clientEntryBundles.length}.`,
  );
}

const clientEntryBytes = statSync(clientEntryBundles[0]).size;
const clientEntryGzipBytes = gzipSync(readFileSync(clientEntryBundles[0])).byteLength;
if (clientEntryBytes > MAX_CLIENT_ENTRY_BYTES) {
  throw new Error(
    `Client main bundle is ${clientEntryBytes.toLocaleString()} bytes; the launch budget is ${MAX_CLIENT_ENTRY_BYTES.toLocaleString()} bytes.`,
  );
}
if (clientEntryGzipBytes > MAX_CLIENT_ENTRY_GZIP_BYTES) {
  throw new Error(
    `Client main bundle compresses to ${clientEntryGzipBytes.toLocaleString()} bytes; the launch budget is ${MAX_CLIENT_ENTRY_GZIP_BYTES.toLocaleString()} bytes.`,
  );
}

console.log(
  `Client main bundle: ${clientEntryBytes.toLocaleString()} / ${MAX_CLIENT_ENTRY_BYTES.toLocaleString()} raw bytes; ${clientEntryGzipBytes.toLocaleString()} / ${MAX_CLIENT_ENTRY_GZIP_BYTES.toLocaleString()} gzip bytes.`,
);
