import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "../bridge/src/index.ts");
const output = resolve(root, "src-tauri/binaries/showpilot-bridge");

mkdirSync(dirname(output), { recursive: true });
// The default x64 Bun executable uses AVX2 instructions. Bridge machines are
// often older production PCs, so compile x64 builds against Bun's baseline
// target to avoid an illegal-instruction crash before the agent can connect.
const target = process.platform === "win32"
  ? "bun-windows-x64-baseline"
  : process.platform === "linux"
    ? "bun-linux-x64-baseline"
    : process.arch === "arm64"
      ? "bun-darwin-arm64"
      : "bun-darwin-x64-baseline";
const result = spawnSync("bun", ["build", "--compile", `--target=${target}`, source, "--outfile", output], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error("Unable to compile the bridge sidecar. Install Bun to build releases.");
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
