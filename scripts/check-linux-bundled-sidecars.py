#!/usr/bin/env python3
"""Verify AppImage staging kept the embedded engine intact and executable."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("preserve_bun", root / "scripts/preserve-bun-rpath.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

for app in ("desktop", "bridge-desktop"):
    staged = list((root / "apps" / app / "src-tauri/target/release/bundle/appimage").glob("*.AppDir/usr/bin/showpilot-bridge"))
    if len(staged) != 1:
        raise RuntimeError(f"Expected one bundled engine for {app}, found {len(staged)}")
    target = staged[0]
    source = module.source_for_sidecar(target, root)
    if source is None or module.digest(source) != module.digest(target):
        raise RuntimeError(f"Bundling changed the {app} embedded engine")
    subprocess.run(["ldd", str(target)], check=True, capture_output=True, text=True)
    with tempfile.TemporaryDirectory(prefix="showpilot-sidecar-check-") as directory:
        result = subprocess.run([str(target), "--desktop", "--no-open"], cwd=directory,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        if result.returncode != 0:
            raise RuntimeError(f"{app} embedded engine failed to start: {result.stderr[-2000:]}")
    print(f"{app}: bundled sidecar matches source, dependencies resolve, and startup succeeds")
