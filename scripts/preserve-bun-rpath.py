#!/usr/bin/env python3
"""Keep linuxdeploy's patchelf from rewriting a compiled Bun sidecar.

The first dependency scan succeeds, but rewriting Bun 1.4.0's ELF RPATH makes
the GTK plugin's second ldd scan fail. This standalone runtime uses system
libraries; it does not need the GUI executable's AppDir RPATH. Preserve only
the exact compiled source bytes at the expected AppDir location. Everything
else, including dependency discovery, uses the real tool unchanged.

linuxdeploy supports this adapter through its PATCHELF environment variable:
https://github.com/linuxdeploy/linuxdeploy/blob/659c9db/src/core/elf_file.cpp
"""
import hashlib
from pathlib import Path
import subprocess
import sys


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.digest()


def source_for_sidecar(target, root):
    target = target.resolve()
    for app in ("desktop", "bridge-desktop"):
        tauri = (root / "apps" / app / "src-tauri").resolve()
        if not target.is_relative_to(tauri / "target"):
            continue
        if (target.name == "showpilot-bridge" and target.parent.name == "bin"
                and target.parent.parent.name == "usr"
                and target.parents[2].name.endswith(".AppDir")):
            return tauri / "binaries/showpilot-bridge-x86_64-unknown-linux-gnu"
    return None


def main(args):
    root = Path(__file__).resolve().parent.parent
    if len(args) == 3 and args[0] == "--set-rpath":
        target = Path(args[2])
        source = source_for_sidecar(target, root)
        if source is not None:
            if not source.is_file() or not target.is_file() or digest(source) != digest(target):
                raise RuntimeError("Bundled Bridge sidecar differs from its compiled source")
            print("Preserving the compiled Bridge sidecar without an RPATH rewrite", file=sys.stderr)
            return 0
    # An absolute executable avoids recursively invoking this adapter through PATH.
    return subprocess.run(["/usr/bin/patchelf", *args], check=False).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
