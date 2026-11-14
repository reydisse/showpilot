"""Install downloaded bundles on disposable CI runners; no org credentials.

Bridge installs before Desktop. GUI startup and installed engines are checked.
Demo sign-in is a separate check on the personal Apple Silicon Mac.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import sys
import time

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Refusing installer changes outside a disposable GitHub runner")
root = Path(sys.argv[1]).resolve()
evidence = Path("native-install-evidence").resolve()
evidence.mkdir()
installed_root = Path(os.environ["RUNNER_TEMP"]) / "showpilot-installed"
installed_root.mkdir()
records = []


def run(args, **kwargs):
    print("RUN", json.dumps([str(x) for x in args]), flush=True)
    result = subprocess.run([str(x) for x in args], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=240, **kwargs)
    print(result.stdout, flush=True)
    if result.returncode:
        raise RuntimeError(f"Command exited {result.returncode}: {result.stdout}")
    return result.stdout


def product_name(name):
    return "".join(c.lower() for c in name if c.isalnum())


def one(paths):
    paths = list(paths)
    if len(paths) != 1:
        raise RuntimeError(f"Expected exactly one matching installed artifact: {paths}")
    return paths[0]


def launch(executable, product):
    log = evidence / f"{product}-launch.log"
    with log.open("w") as output:
        child = subprocess.Popen([str(executable)], stdout=output,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        try:
            time.sleep(10)
            if child.poll() is not None:
                raise RuntimeError(f"{product} exited during startup ({child.returncode}): {log.read_text()}")
            return {"survived_startup_seconds": 10, "pid": child.pid}
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)


def install_product(product, app, cargo, workspace):
    expected = json.loads(Path(f"apps/{workspace}/package.json").read_text())["version"]
    record = {"product": product, "expected_version": expected,
              "unsigned": True, "physical_equipment": False}
    records.append(record)
    if sys.platform == "darwin":
        installer = one(x for x in root.rglob("*.dmg") if product_name(app) in product_name(x.name))
        mount_info = plistlib.loads(subprocess.check_output(
            ["hdiutil", "attach", "-nobrowse", "-readonly", "-plist", str(installer)]))
        mount = one(Path(x["mount-point"]) for x in mount_info["system-entities"] if "mount-point" in x)
        try:
            source_app = one(mount.glob(app + ".app"))
            target = installed_root / source_app.name
            run(["ditto", source_app, target])
        finally:
            run(["hdiutil", "detach", mount])
        info = plistlib.loads((target / "Contents/Info.plist").read_bytes())
        assert info["CFBundleShortVersionString"] == expected, info
        executable = target / "Contents/MacOS" / info["CFBundleExecutable"]
        engine = target / "Contents/MacOS/showpilot-bridge"
        arch = run(["lipo", "-archs", executable]).strip()
        assert ("arm64" if platform.machine() == "arm64" else "x86_64") in arch, arch
        run(["codesign", "--verify", "--deep", "--strict", target])
        record.update(version=info["CFBundleShortVersionString"], architecture=arch)
    elif sys.platform == "win32":
        installer = one(x for x in root.rglob("*.exe") if product_name(app) in product_name(x.name) and x.parent.name == "nsis")
        target = installed_root / product
        run([installer, "/S", f"/D={target}"])
        exact = [x for x in target.rglob("*.exe") if x.name.lower() == cargo + ".exe"]
        executable = one(exact if exact else (x for x in target.rglob("*.exe") if product_name(x.stem) == product_name(app)))
        engine = one(target.rglob("showpilot-bridge.exe"))
        env = {**os.environ, "SP_INSTALL_APP": str(executable)}
        version = run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                       "(Get-Item -LiteralPath $env:SP_INSTALL_APP).VersionInfo.ProductVersion"], env=env).strip()
        assert version == expected, version
        signature = run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                         "(Get-AuthenticodeSignature -FilePath $env:SP_INSTALL_APP).Status.ToString()"], env=env).strip()
        assert signature == "NotSigned", signature
        record.update(version=version, signature=signature)
    else:
        installer = one(x for x in root.rglob("*.deb") if product_name(app) in product_name(x.name))
        package = run(["dpkg-deb", "-f", installer, "Package"]).strip()
        version = run(["dpkg-deb", "-f", installer, "Version"]).strip()
        assert version == expected, version
        run(["sudo", "apt-get", "install", "-y", installer])
        files = [Path(x) for x in run(["dpkg-query", "-L", package]).splitlines()]
        executable = one(x for x in files if x.name == cargo and x.is_file())
        engine = one(x for x in files if str(x) == "/usr/bin/showpilot-bridge" and x.is_file())
        record.update(version=version, package=package)
    with installer.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    record.update(installer=str(installer.relative_to(root)), sha256=digest,
                  installed_executable=str(executable))
    record["launch"] = launch(executable, product)
    run(["node", "scripts/smoke-macos-engine.mjs", engine])
    record["packaged_engine"] = "authenticated_loopback_status_and_10000_roundtrips_pass"
    record["passed"] = True


failures = []
for args in [
    ("bridge", "ShowPilot Bridge", "showpilot-bridge-desktop", "bridge-desktop"),
    ("desktop", "ShowPilot Desktop", "showpilot-desktop", "desktop"),
]:
    try:
        install_product(*args)
    except Exception as error:
        import traceback
        traceback.print_exc()
        failures.append({"product": args[0], "error": str(error)})
        if records and records[-1].get("product") == args[0]:
            records[-1]["error"] = str(error)
(evidence / "results.json").write_text(json.dumps(records, indent=2) + "\n")
print(json.dumps({"passed": not failures, "install_order": ["bridge", "desktop"], "products": records}), flush=True)
if failures:
    raise SystemExit(1)
