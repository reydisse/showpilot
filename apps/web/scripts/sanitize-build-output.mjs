import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(webRoot, "dist");

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
