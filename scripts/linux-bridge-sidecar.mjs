import { chmodSync, writeFileSync } from "node:fs";

// linuxdeploy only inspects ELF executables in AppDir/usr/bin. It rewrites
// their rpath, then the GTK plugin runs that scan again. Bun's compiled
// engine is a dynamic ELF with its payload appended after the binary. The
// rpath rewrite leaves `ldd` exiting 1, and the plugin aborts AppImage
// packaging. usr/share is outside both scans, so the real engine stays there
// and usr/bin only receives this wrapper.
export const LINUX_ENGINE_FILENAME = "showpilot-bridge-linux-real";

const SHARE_DIRECTORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function linuxEngineDestination(shareDirectory) {
  if (!SHARE_DIRECTORY.test(shareDirectory)) {
    throw new Error(`Invalid Linux engine directory: ${shareDirectory}`);
  }
  return `/usr/share/${shareDirectory}/showpilot-bridge`;
}

export function linuxEngineBundleFiles(shareDirectory) {
  return {
    [linuxEngineDestination(shareDirectory)]: `binaries/${LINUX_ENGINE_FILENAME}`,
  };
}

export function linuxEngineWrapper(shareDirectory) {
  const packaged = linuxEngineDestination(shareDirectory)
    .replace(/^\//, "")
    .replace(/^usr\//, "../");
  return `#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
packaged="$here/${packaged}"
unpacked="$here/../../binaries/${LINUX_ENGINE_FILENAME}"
if [ -x "$packaged" ]; then
  exec "$packaged" "$@"
fi
if [ -x "$unpacked" ]; then
  exec "$unpacked" "$@"
fi
echo "ShowPilot device engine is missing." >&2
exit 127
`;
}

export function publishLinuxEngine({ compilePath, sidecarPath, shareDirectory }) {
  chmodSync(compilePath, 0o755);
  writeFileSync(sidecarPath, linuxEngineWrapper(shareDirectory), { mode: 0o755 });
  chmodSync(sidecarPath, 0o755);
}
