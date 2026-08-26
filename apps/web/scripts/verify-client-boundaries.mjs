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

const sensitiveLoggingContracts = [
  {
    path: "src/lib/auth.ts",
    pattern: /console\.log\s*\(/,
    message: "Authentication flows must not log account identifiers, verification URLs, or reset tokens.",
  },
  {
    path: "src/lib/email.ts",
    pattern: /console\.log\s*\(/,
    message: "Email delivery must not log recipients, subjects, or provider response bodies.",
  },
  {
    path: "src/lib/email.ts",
    pattern: /\b(?:res|response)\.text\s*\(/,
    message: "Email delivery must not read raw provider error bodies into application diagnostics.",
  },
];

for (const contract of sensitiveLoggingContracts) {
  const source = readFileSync(resolve(webRoot, contract.path), "utf8");
  if (contract.pattern.test(source)) throw new Error(contract.message);
}

const launchIntegrityContracts = [
  {
    path: "src/lib/data.ts",
    pattern: /\b(?:getCueSheets|addCueSheet|updateCueSheet|deleteCueSheet)\s*=/,
    message: "Legacy standalone cue-sheet CRUD must not return. Cue rows and write access belong to the rundown-backed cue-sheet module.",
  },
  {
    path: "src/lib/permissions.ts",
    pattern: /\bPLANNED\b/,
    message: "The production permission registry must contain only implemented capabilities.",
  },
];

for (const contract of launchIntegrityContracts) {
  const source = readFileSync(resolve(webRoot, contract.path), "utf8");
  if (contract.pattern.test(source)) throw new Error(contract.message);
}

console.log("Client boundary check passed.");
