#!/usr/bin/env python3
"""Check DeckLink support on the actual signed Desktop app; never enable output."""
import json
import pathlib
import plistlib
import subprocess
import sys

app = pathlib.Path(sys.argv[1])
entitlements = subprocess.run(
    ["codesign", "-d", "--entitlements", "-", "--xml", str(app)],
    check=True, capture_output=True,
).stdout
settings = plistlib.loads(entitlements)
if settings.get("com.apple.security.cs.disable-library-validation") is not True:
    raise SystemExit("Desktop cannot load Blackmagic's signed driver: missing library-validation exception")
if pathlib.Path("/Library/Frameworks/DeckLinkAPI.framework").exists():
    result = subprocess.run(
        [str(app / "Contents/MacOS/showpilot-desktop"), "--diagnose-decklink"],
        check=True, capture_output=True, text=True, timeout=30,
    )
    inventory = json.loads(result.stdout)
    if inventory.get("error"):
        raise SystemExit(inventory["error"])
    print(f"Signed Desktop loaded the Blackmagic driver; {len(inventory['devices'])} output channels detected.")
else:
    print("DeckLink signing entitlement verified; driver is not installed on this build runner.")
