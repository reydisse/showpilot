"""CTO-approved supplemental packaging repair; never compiles application code."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

assert os.environ.get("GITHUB_ACTIONS") == "true", "Disposable CI runner required"
assert sys.platform == "darwin"
root = Path("downloaded-bundles").resolve()
out = Path("supplemental-native-bundles").resolve()
out.mkdir()
work = Path(os.environ["RUNNER_TEMP"]) / "bridge-supplemental-package"
work.mkdir()
volume = work / "volume"
volume.mkdir()
proof_dir = work / "binary-proof"
proof_dir.mkdir()


def run(args):
    result = subprocess.run([str(x) for x in args], capture_output=True, check=True)
    return result.stdout


def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def one(items):
    items = list(items)
    assert len(items) == 1, items
    return items[0]


def entitlements(path):
    return plistlib.loads(run(["codesign", "-d", "--entitlements", ":-", path]))


def tree(app):
    return {str(p.relative_to(app)): digest(p) for p in app.rglob("*") if p.is_file()}


bridge_dmg = one(x for x in root.rglob("*.dmg") if x.name.startswith("ShowPilot Bridge_"))
desktop_dmg = one(x for x in root.rglob("*.dmg") if x.name.startswith("ShowPilot Desktop_"))
source_bridge = plistlib.loads(Path("apps/bridge-desktop/src-tauri/entitlements.plist").read_bytes())
source_desktop = plistlib.loads(Path("apps/desktop/src-tauri/entitlements.plist").read_bytes())
assert source_bridge == {"com.apple.security.device.audio-input": True}
assert source_desktop == {"com.apple.security.cs.disable-library-validation": True}
union = {**source_bridge, **source_desktop}
union_file = work / "sidecar-entitlements.plist"
union_file.write_bytes(plistlib.dumps(union))
mount_info = plistlib.loads(run(["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", bridge_dmg]))
mount = one(Path(x["mount-point"]) for x in mount_info["system-entities"] if "mount-point" in x)
app = volume / "ShowPilot Bridge.app"
try:
    run(["ditto", mount / app.name, app])
finally:
    run(["hdiutil", "detach", mount])
info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
assert info["CFBundleShortVersionString"] == "0.1.14"
main = app / "Contents/MacOS" / info["CFBundleExecutable"]
engine = app / "Contents/MacOS/showpilot-bridge"
assert entitlements(engine) == source_bridge
assert entitlements(main) == source_bridge
before = tree(app)
original = {}
for binary in [main, engine]:
    copy = proof_dir / (binary.name + "-original")
    shutil.copy2(binary, copy)
    run(["codesign", "--remove-signature", copy])
    original[binary.name] = digest(copy)

# Preserve Bridge's audio permission. Only the sidecar receives the additional
# library-validation exception already used by Desktop at the pinned source.
run(["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", union_file, engine])
run(["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", "apps/bridge-desktop/src-tauri/entitlements.plist", app])
run(["codesign", "--verify", "--deep", "--strict", app])
assert entitlements(engine) == union
assert entitlements(main) == source_bridge
normalized = {}
for binary in [main, engine]:
    copy = proof_dir / (binary.name + "-repaired")
    shutil.copy2(binary, copy)
    run(["codesign", "--remove-signature", copy])
    normalized[binary.name] = digest(copy)
assert normalized == original, "Executable bytes changed beyond code signatures"
after = tree(app)
allowed = {"Contents/MacOS/" + main.name, "Contents/MacOS/showpilot-bridge", "Contents/_CodeSignature/CodeResources"}
assert before.keys() == after.keys()
changed = {p for p in before if before[p] != after[p]}
assert changed <= allowed, changed
os.symlink("/Applications", volume / "Applications")
arch = run(["lipo", "-archs", main]).decode().strip()
suffix = "aarch64" if arch == "arm64" else "x64"
assert arch in ["arm64", "x86_64"], arch
repaired = out / f"ShowPilot Bridge_0.1.14_{suffix}_SUPPLEMENTAL-ENTITLEMENTS-UNSIGNED.dmg"
run(["hdiutil", "create", "-volname", "ShowPilot Bridge unsigned supplemental", "-srcfolder", volume, "-format", "UDZO", repaired])
shutil.copy2(desktop_dmg, out / desktop_dmg.name)
assert digest(desktop_dmg) == digest(out / desktop_dmg.name)
report = {
    "source_head": os.environ["EXPECTED_SHA"], "original_build_run": os.environ["BUILD_RUN"],
    "label": "SUPPLEMENTAL PACKAGING REPAIR — UNSIGNED / AD-HOC, NOT NOTARIZED",
    "application_recompiled": False, "application_source_changed": False,
    "architecture": arch, "bridge_version": "0.1.14",
    "sidecar_entitlements_before": source_bridge, "sidecar_entitlements_after": union,
    "main_app_entitlements_unchanged": source_bridge,
    "only_changed_bundle_files": sorted(changed),
    "signature_stripped_binary_sha256_before": original,
    "signature_stripped_binary_sha256_after": normalized,
    "original_bridge_dmg_sha256": digest(bridge_dmg),
    "repaired_bridge_dmg_sha256": digest(repaired),
    "desktop_dmg_unchanged_sha256": digest(desktop_dmg),
    "root_cause": "Original Bridge sidecar cannot load the embedded keyring native module under macOS library validation",
    "required_next_step": "Download this uploaded artifact on a fresh runner and the owner Mac, install Bridge first, and repeat engine and Demo checks",
}
(out / "SUPPLEMENTAL-PACKAGING-PROOF.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
