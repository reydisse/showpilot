import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LINUX_ENGINE_FILENAME,
  linuxEngineBundleFiles,
  linuxEngineWrapper,
  publishLinuxEngine,
} from "./linux-bridge-sidecar.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("places the Bun engine outside the directory linuxdeploy scans", () => {
  assert.deepEqual(linuxEngineBundleFiles("showpilot-desktop"), {
    "/usr/share/showpilot-desktop/showpilot-bridge": `binaries/${LINUX_ENGINE_FILENAME}`,
  });
  const wrapper = linuxEngineWrapper("showpilot-desktop");
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /\/share\/showpilot-desktop\/showpilot-bridge/);
  assert.doesNotMatch(wrapper, /usr\/bin\/showpilot-bridge-linux-real/);
  assert.throws(() => linuxEngineWrapper("ShowPilot Desktop"), /Invalid Linux engine directory/);
});

test("packaged installs prefer the share path and unpacked builds use the compile output", () => {
  const directory = mkdtempSync(join(tmpdir(), "showpilot-linux-engine-"));
  try {
    const bin = join(directory, "usr/bin");
    const share = join(directory, "usr/share/showpilot-desktop");
    const unpacked = join(directory, "src-tauri/target/release");
    const compiled = join(directory, "src-tauri/binaries", LINUX_ENGINE_FILENAME);
    for (const path of [bin, share, unpacked, dirname(compiled)]) {
      spawnSync("mkdir", ["-p", path], { stdio: "inherit" });
    }
    writeExecutable(join(share, "showpilot-bridge"), "#!/bin/sh\necho packaged\n");
    writeExecutable(compiled, "#!/bin/sh\necho unpacked\n");

    const packagedWrapper = join(bin, "showpilot-bridge");
    publishLinuxEngine({
      compilePath: compiled,
      sidecarPath: packagedWrapper,
      shareDirectory: "showpilot-desktop",
    });
    const packaged = spawnSync(packagedWrapper, [], { encoding: "utf8" });
    assert.equal(packaged.status, 0);
    assert.equal(packaged.stdout, "packaged\n");

    const devWrapper = join(unpacked, "showpilot-bridge");
    writeFileSync(devWrapper, readFileSync(packagedWrapper));
    chmodSync(devWrapper, 0o755);
    const dev = spawnSync(devWrapper, ["--no-open"], { encoding: "utf8" });
    assert.equal(dev.status, 0);
    assert.equal(dev.stdout, "unpacked\n");

    rmSync(compiled);
    const missing = spawnSync(devWrapper, [], { encoding: "utf8" });
    assert.equal(missing.status, 127);
    assert.match(missing.stderr, /device engine is missing/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Desktop and Bridge keep the same Linux engine layout", () => {
  for (const [app, shareDirectory] of [
    ["apps/desktop", "showpilot-desktop"],
    ["apps/bridge-desktop", "showpilot-bridge"],
  ]) {
    const config = JSON.parse(readFileSync(resolve(root, app, "src-tauri/tauri.conf.json"), "utf8"));
    const files = linuxEngineBundleFiles(shareDirectory);
    assert.deepEqual(config.bundle.linux.appimage.files, files);
    assert.deepEqual(config.bundle.linux.deb.files, files);
    assert.deepEqual(config.bundle.linux.rpm.files, files);
    const buildScript = readFileSync(resolve(root, app, "scripts/build-bridge.mjs"), "utf8");
    assert.match(buildScript, /publishLinuxEngine\(/);
    assert.match(buildScript, new RegExp(`shareDirectory: "${shareDirectory}"`));
    assert.match(buildScript, /resolve\(root, "src-tauri\/binaries", LINUX_ENGINE_FILENAME\)/);
  }
});
