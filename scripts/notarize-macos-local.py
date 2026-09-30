#!/usr/bin/env python3
"""Notarize a signed app, staple it, and create a signed, stapled DMG.

Credentials remain in the named macOS Keychain profile. Re-running resumes
Apple submissions from receipts; changing the app requires a new output folder.
"""
import argparse
import hashlib
import json
import plistlib
import re
import subprocess
import sys
from pathlib import Path


def run(*args, capture=False):
    print("Running " + " ".join(map(str, args[:3])), flush=True)
    result = subprocess.run(list(map(str, args)), text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if capture and result.returncode:
        print(result.stdout or "", file=sys.stderr)
        print(result.stderr or "", file=sys.stderr)
    result.check_returncode()
    return result


def signature(path):
    run("codesign", "--verify", "--deep", "--strict", path)
    result = subprocess.run(["codesign", "-dv", "--verbose=4", str(path)],
                            check=True, capture_output=True, text=True)
    details = result.stderr
    if "Authority=Developer ID Application:" not in details:
        raise RuntimeError(f"Not Developer ID signed: {path}")
    return re.search(r"^CDHash=(.+)$", details, re.M).group(1)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("app", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--identity", required=True)
parser.add_argument("--profile", default="ShowPilot-notarization")
parser.add_argument("--wait-timeout", default="15m",
                    help="Maximum wait per Apple submission, for example 15m or 24h")
args = parser.parse_args()
source = args.app.resolve()
output = args.output.resolve()
source_hash = signature(source)
output.mkdir(parents=True, exist_ok=True)
manifest_path = output / "source.json"
manifest = {"app": source.name, "cdhash": source_hash}
if manifest_path.exists():
    if json.loads(manifest_path.read_text()) != manifest:
        raise RuntimeError("Output belongs to another build. Choose a new folder.")
else:
    if list(output.iterdir()):
        raise RuntimeError("Output folder must initially be empty.")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

app = output / "macos" / source.name
if not app.exists():
    app.parent.mkdir(exist_ok=True)
    run("ditto", source, app)
if signature(app) != source_hash:
    raise RuntimeError("Staged app differs from the requested build.")


def notarize(artifact, label, staple_target):
    receipt = output / f"{label}-submission.json"
    auth = ["--keychain-profile", args.profile, "--output-format", "json"]
    if receipt.exists():
        submission = json.loads(receipt.read_text())
    else:
        submission = json.loads(run("xcrun", "notarytool", "submit", artifact,
                                    *auth, capture=True).stdout)
        receipt.write_text(json.dumps(submission, indent=2) + "\n")
    submission_id = submission["id"]
    print(f"{label}: Apple submission {submission_id}", flush=True)
    status = json.loads(run("xcrun", "notarytool", "info", submission_id,
                            *auth, capture=True).stdout)
    if status["status"] == "In Progress":
        run("xcrun", "notarytool", "wait", submission_id, "--keychain-profile",
            args.profile, "--timeout", args.wait_timeout)
        status = json.loads(run("xcrun", "notarytool", "info", submission_id,
                                *auth, capture=True).stdout)
    (output / f"{label}-status.json").write_text(json.dumps(status, indent=2) + "\n")
    run("xcrun", "notarytool", "log", submission_id, output / f"{label}-log.json",
        "--keychain-profile", args.profile)
    if status["status"] != "Accepted":
        raise RuntimeError(f"Apple did not accept {label}: {status['status']}")
    run("xcrun", "stapler", "staple", staple_target)
    run("xcrun", "stapler", "validate", staple_target)


archive = output / "app-for-notarization.zip"
if not archive.exists():
    run("ditto", "-c", "-k", "--keepParent", app, archive)
notarize(archive, "app", app)
run("spctl", "--assess", "--type", "execute", "--verbose=4", app)

with (app / "Contents/Info.plist").open("rb") as stream:
    info = plistlib.load(stream)
binary = app / "Contents/MacOS" / info["CFBundleExecutable"]
arch = run("lipo", "-archs", binary, capture=True).stdout.strip().replace(" ", "-")
version = info["CFBundleShortVersionString"]
dmg_dir = output / "dmg"
dmg_dir.mkdir(exist_ok=True)
dmg = dmg_dir / f"{source.stem.replace(' ', '_')}_{version}_{arch}.dmg"
if not dmg.exists():
    contents = output / "installer-contents"
    contents.mkdir(exist_ok=True)
    run("ditto", app, contents / source.name)
    applications = contents / "Applications"
    if not applications.is_symlink():
        applications.symlink_to("/Applications")
    pending = dmg_dir / "pending.dmg"
    run("hdiutil", "create", "-ov", "-volname", source.stem, "-srcfolder", contents,
        "-format", "UDZO", pending)
    run("codesign", "--force", "--sign", args.identity, "--timestamp", pending)
    signature(pending)
    pending.rename(dmg)
notarize(dmg, "dmg", dmg)
signature(app)
signature(dmg)
run("spctl", "--assess", "--type", "open", "--context", "context:primary-signature",
    "--verbose=4", dmg)
checksum = hashlib.sha256(dmg.read_bytes()).hexdigest()
(output / "SHA256SUMS").write_text(f"{checksum}  dmg/{dmg.name}\n")
print(f"Ready: {dmg}", flush=True)
