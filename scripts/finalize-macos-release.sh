#!/usr/bin/env bash
# Create installers and updater archives from the same stapled, verified app.
set -euo pipefail

app="${1:?usage: finalize-macos-release.sh <app> <empty-output-dir> <version>}"
output="${2:?output directory required}"
expected_version="${3:?version required}"
: "${APPLE_SIGNING_IDENTITY:?Developer ID identity required}"
: "${TAURI_SIGNING_PRIVATE_KEY:?Updater signing key required}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
product_name="$(basename "$app" .app)"
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")"
test "$version" = "$expected_version"
case "$product_name" in
  'ShowPilot Desktop'|'ShowPilot Bridge') ;;
  *) echo "Unexpected product: $product_name" >&2; exit 1 ;;
esac

python3 "$script_dir/notarize-macos-local.py" "$app" "$output" \
  --identity "$APPLE_SIGNING_IDENTITY" --profile "${SHOWPILOT_NOTARY_PROFILE:-ShowPilot-ci}"
bash "$script_dir/verify-macos-release.sh" "$output" "$product_name"

executable="$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$output/macos/$product_name.app/Contents/Info.plist")"
case "$(lipo -archs "$output/macos/$product_name.app/Contents/MacOS/$executable")" in
  arm64) artifact_arch=aarch64 ;;
  x86_64) artifact_arch=x64 ;;
  *) echo 'Unsupported Mac architecture' >&2; exit 1 ;;
esac
asset_prefix="${product_name// /.}"
mkdir -p "$output/downloads"
shopt -s nullglob
installers=("$output"/dmg/*.dmg)
test "${#installers[@]}" -eq 1
cp "${installers[0]}" "$output/downloads/${asset_prefix}_${version}_${artifact_arch}.dmg"
archive="$output/downloads/${asset_prefix}_${artifact_arch}.app.tar.gz"
tar -czf "$archive" -C "$output/macos" "$product_name.app"
cd "$repo_root"
pnpm --filter @showpilot/desktop exec tauri signer sign "$archive"

# Confirm the archive retained the ticket, not just the staging directory.
mkdir "$output/archive-check"
tar -xzf "$archive" -C "$output/archive-check"
xcrun stapler validate "$output/archive-check/$product_name.app"
codesign --verify --deep --strict "$output/archive-check/$product_name.app"
echo "Verified Mac release files: $output/downloads"
