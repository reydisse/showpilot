import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkCoverage } from "./check-coverage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = new URL(import.meta.resolve("vitest/package.json"));
const vitest = fileURLToPath(new URL(JSON.parse(readFileSync(manifest, "utf8")).bin.vitest, manifest));
rmSync(new URL("../coverage/", import.meta.url), { recursive: true, force: true });
for (const args of [["run", "--coverage"], ["run", "--config", "vitest.worker.config.ts", "--coverage"]]) {
  const result = spawnSync(process.execPath, [vitest, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
checkCoverage();
