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
const bunCommand = executablePath || "bun";
const args = ["build", "--compile"];
if (!(executablePath && process.platform === "win32")) args.push(`--target=${target}`);
args.push(source, "--outfile", output);

// Bun 1.3.12+ can emit a truncated Mach-O signature when compiling a macOS
// executable. Suppress that generated signature and let codesign create a
// structurally valid ad-hoc signature. Tauri replaces it with Developer ID in
// signed release builds.
const result = spawnSync(bunCommand, args, {
  cwd: root,
  stdio: "inherit",
  env: process.platform === "darwin"
    ? { ...process.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" }
    : process.env,
});
if (result.error) {
  console.error("Unable to compile the embedded ShowPilot device engine. Install Bun to build releases.");
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

if (process.platform === "darwin") {
  const sign = spawnSync("codesign", ["--force", "--sign", "-", "--timestamp=none", output], {
    stdio: "inherit",
  });
  if (sign.error) {
    console.error("Unable to ad-hoc sign the embedded ShowPilot device engine.");
    console.error(sign.error.message);
    process.exit(1);
  }
  if (sign.status !== 0) process.exit(sign.status ?? 1);

  const verify = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", output], {
    stdio: "inherit",
  });
  if (verify.error) {
    console.error("Unable to verify the embedded ShowPilot device engine signature.");
    console.error(verify.error.message);
    process.exit(1);
  }
  if (verify.status !== 0) process.exit(verify.status ?? 1);
}
