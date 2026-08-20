import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "../bridge/src/index.ts");
const rustc = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
const targetTriple = rustc.stdout?.trim();
if (rustc.status !== 0 || !targetTriple) {
  console.error("Unable to determine the Rust target triple for the embedded device engine.");
  process.exit(rustc.status ?? 1);
}
const extension = process.platform === "win32" ? ".exe" : "";
const output = resolve(root, `src-tauri/binaries/showpilot-bridge-${targetTriple}${extension}`);

mkdirSync(dirname(output), { recursive: true });
const target = process.platform === "win32"
  ? "bun-windows-x64-baseline"
  : process.platform === "linux"
    ? "bun-linux-x64-baseline"
    : process.arch === "arm64"
      ? "bun-darwin-arm64"
      : "bun-darwin-x64-baseline";
const executablePath = process.env.SHOWPILOT_BUN_EXECUTABLE_PATH;
const bunCommand = executablePath && process.platform === "win32" ? executablePath : "bun";
const args = ["build", "--compile"];
if (!executablePath || process.platform !== "win32") args.push(`--target=${target}`);
args.push(source, "--outfile", output);

const result = spawnSync(bunCommand, args, { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error("Unable to compile the embedded ShowPilot device engine. Install Bun to build releases.");
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
