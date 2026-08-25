#!/usr/bin/env bash

set -euo pipefail

bundle_dir="${1:?usage: verify-macos-release.sh <bundle-dir> <product-name>}"
product_name="${2:?usage: verify-macos-release.sh <bundle-dir> <product-name>}"
app_path="$bundle_dir/macos/$product_name.app"

if [[ ! -d "$app_path" ]]; then
  echo "::error::macOS app bundle not found: $app_path"
  exit 1
fi

shopt -s nullglob
dmg_paths=("$bundle_dir"/dmg/*.dmg)
shopt -u nullglob

if [[ "${#dmg_paths[@]}" -ne 1 ]]; then
  echo "::error::Expected exactly one macOS DMG in $bundle_dir/dmg; found ${#dmg_paths[@]}"
  exit 1
fi

dmg_path="${dmg_paths[0]}"

verify_developer_id_signature() {
  local artifact_path="$1"
  local details

  codesign --verify --deep --strict --verbose=2 "$artifact_path"
  details="$(codesign --display --verbose=4 "$artifact_path" 2>&1)"

  if ! grep -q '^Authority=Developer ID Application:' <<<"$details"; then
    echo "::error::Refusing release: $artifact_path is not signed with a Developer ID Application certificate"
    exit 1
  fi

  if grep -q '^TeamIdentifier=not set$' <<<"$details" || ! grep -Eq '^TeamIdentifier=.+$' <<<"$details"; then
    echo "::error::Refusing release: $artifact_path does not contain an Apple Developer Team identifier"
    exit 1
  fi
}

verify_developer_id_signature "$app_path"
verify_developer_id_signature "$dmg_path"

xcrun stapler validate "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_path"

echo "Verified Developer ID signatures, the app notarization ticket, and Gatekeeper acceptance for $product_name."
