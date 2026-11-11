#!/usr/bin/env python3
"""Verify AppImage staging kept the embedded engine intact and executable."""
import importlib.util
import json
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
    # usr/bin contains the launcher; the ELF payload deliberately lives outside
    # linuxdeploy's scan. Verify both against the build outputs, then start the
    # packaged launcher so a broken lookup cannot be hidden by direct execution.
    tauri = root / "apps" / app / "src-tauri"
    files = json.loads((tauri / "tauri.conf.json").read_text())["bundle"]["linux"]["appimage"]["files"]
    if len(files) != 1:
        raise RuntimeError(f"Expected one packaged engine mapping for {app}")
    destination, compiled = next(iter(files.items()))
    engine = target.parents[2] / destination.lstrip("/")
    source_engine = tauri / compiled
    if not engine.is_file() or module.digest(source_engine) != module.digest(engine):
        raise RuntimeError(f"Bundling changed or omitted the {app} engine payload")
    dependencies = subprocess.run(["ldd", str(engine)], check=True, capture_output=True, text=True)
    if "not found" in dependencies.stdout:
        raise RuntimeError(f"{app} engine has unresolved dependencies: {dependencies.stdout}")
    with tempfile.TemporaryDirectory(prefix="showpilot-sidecar-check-") as directory:
        result = subprocess.run([str(target), "--desktop", "--no-open"], cwd=directory,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        if result.returncode != 0:
            raise RuntimeError(f"{app} embedded engine failed to start: {result.stderr[-2000:]}")
    print(f"{app}: bundled launcher and engine match source, engine dependencies resolve, and launcher startup succeeds")
