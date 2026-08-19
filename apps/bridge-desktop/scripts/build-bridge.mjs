import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "../bridge/src/index.ts");
const output = resolve(root, "src-tauri/binaries/showpilot-bridge");

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync("bun", ["build", "--compile", source, "--outfile", output], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error("Unable to compile the bridge sidecar. Install Bun to build releases.");
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
