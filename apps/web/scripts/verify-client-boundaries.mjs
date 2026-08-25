import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(webRoot, "src");

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

const runtimeStripeImports = [
  /^\s*import\s+(?!type\b)(?:[^"']+\s+from\s+)?["']stripe["'];?/m,
  /\bimport\(\s*["']stripe["']\s*\)/,
  /\brequire\(\s*["']stripe["']\s*\)/,
];
const violations = walk(sourceRoot)
  .filter((filePath) => /\.[cm]?[jt]sx?$/.test(filePath))
  .filter((filePath) => !filePath.endsWith(".server.ts"))
  .filter((filePath) => {
    const source = readFileSync(filePath, "utf8");
    return runtimeStripeImports.some((pattern) => pattern.test(source));
  })
  .map((filePath) => relative(webRoot, filePath));

if (violations.length > 0) {
  throw new Error(
    `Stripe's server SDK must stay behind a dynamic .server import. Runtime imports found in: ${violations.join(", ")}`,
  );
}

console.log("Client boundary check passed.");
