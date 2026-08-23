import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "../bridge/src/index.ts");
const desktopPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const enginePackage = JSON.parse(readFileSync(resolve(root, "../bridge/package.json"), "utf8"));
const tauriConfig = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const cargoManifest = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = [desktopPackage.version, enginePackage.version, tauriConfig.version, cargoVersion];
if (versions.some((version) => !version) || new Set(versions).size !== 1) {
  console.error(
    `Bridge versions must match before packaging (desktop=${desktopPackage.version}, engine=${enginePackage.version}, tauri=${tauriConfig.version}, cargo=${cargoVersion ?? "missing"}).`,
  );
  process.exit(1);
}
const rustc = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" });
const targetTriple = rustc.stdout?.trim();
if (rustc.status !== 0 || !targetTriple) {
  console.error("Unable to determine the Rust target triple for the Bridge engine.");
  process.exit(rustc.status ?? 1);
}
const extension = process.platform === "win32" ? ".exe" : "";
const output = resolve(root, `src-tauri/binaries/showpilot-bridge-${targetTriple}${extension}`);

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
const executablePath = process.env.SHOWPILOT_BUN_EXECUTABLE_PATH;
// On Windows, run the extracted baseline Bun directly. This avoids Bun's
// cross-target cache move (which fails with EPERM on hosted runners) while
// still embedding the baseline runtime into the output executable.
const bunCommand = executablePath || "bun";
const args = ["build", "--compile"];
if (!(executablePath && process.platform === "win32")) args.push(`--target=${target}`);
args.push(source, "--outfile", output);
const result = spawnSync(bunCommand, args, {
  cwd: root,
  stdio: "inherit",
  // Avoid Bun's malformed generated Mach-O signature. A valid ad-hoc
  // signature keeps local/test bundles intact, and Tauri replaces it with the
  // configured Developer ID identity for notarized releases.
  env: process.platform === "darwin"
    ? { ...process.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" }
    : process.env,
});

if (result.error) {
  console.error("Unable to compile the bridge sidecar. Install Bun to build releases.");
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

if (process.platform === "darwin") {
  const sign = spawnSync("codesign", ["--force", "--sign", "-", "--timestamp=none", output], {
    stdio: "inherit",
  });
  if (sign.error) {
    console.error("Unable to ad-hoc sign the bridge sidecar.");
    console.error(sign.error.message);
    process.exit(1);
  }
  if (sign.status !== 0) process.exit(sign.status ?? 1);

  const verify = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", output], {
    stdio: "inherit",
  });
  if (verify.error) {
    console.error("Unable to verify the bridge sidecar signature.");
    console.error(verify.error.message);
    process.exit(1);
  }
  if (verify.status !== 0) process.exit(verify.status ?? 1);
}
