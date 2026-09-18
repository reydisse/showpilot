import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../src/", import.meta.url);
const allowedDirectPollingFiles = new Set([
  "hooks/use-mobile-bootstrap.ts",
  "providers/app-providers.tsx",
]);

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const rootPath = root.pathname;
const violations = filesUnder(rootPath)
  .filter((path) => statSync(path).isFile() && /\.tsx?$/.test(path))
  .flatMap((path) => {
    const file = relative(rootPath, path);
    if (allowedDirectPollingFiles.has(file)) return [];
    const source = readFileSync(path, "utf8");
    return source
      .split("\n")
      .map((line, index) => ({ file, line: index + 1, text: line.trim() }))
      .filter(({ text }) => text.includes("refetchInterval:"))
      .filter(({ text }) => !text.includes("pollingInterval") && !text.includes("isScreenFocused"));
  });

assert.deepEqual(
  violations,
  [],
  `Every mobile polling query must stop when its route loses focus:\n${violations.map((item) => `${item.file}:${item.line} ${item.text}`).join("\n")}`,
);

console.log("Mobile polling boundary check passed.");
