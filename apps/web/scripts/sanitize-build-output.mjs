import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(webRoot, "dist");
const clientAssetsRoot = resolve(buildRoot, "client", "assets");
const serverAssetsRoot = resolve(buildRoot, "server", "assets");
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

const startManifestFiles = walk(serverAssetsRoot).filter((filePath) =>
  /^_tanstack-start-manifest_v-[\w-]+\.js$/.test(basename(filePath)),
);
if (startManifestFiles.length !== 1) {
  throw new Error(
    `Expected one TanStack Start manifest, found ${startManifestFiles.length}.`,
  );
}

const { tsrStartManifest } = await import(pathToFileURL(startManifestFiles[0]));
const clientEntryScripts = tsrStartManifest().routes.__root__.scripts.filter(
  (script) => script.attrs?.type === "module" && script.attrs?.src,
);
if (clientEntryScripts.length !== 1) {
  throw new Error(
    `Expected one manifest-declared client entry, found ${clientEntryScripts.length}.`,
  );
}

const clientEntrySource = clientEntryScripts[0].attrs.src;
if (!clientEntrySource.startsWith("/assets/") || !clientEntrySource.endsWith(".js")) {
  throw new Error(`Unexpected client entry source: ${clientEntrySource}`);
}

const clientEntryBundle = resolve(
  clientAssetsRoot,
  clientEntrySource.slice("/assets/".length),
);
if (!existsSync(clientEntryBundle)) {
  throw new Error(`Manifest-declared client entry is missing: ${clientEntrySource}`);
}

const clientEntryBytes = statSync(clientEntryBundle).size;
const clientEntryGzipBytes = gzipSync(readFileSync(clientEntryBundle)).byteLength;
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
