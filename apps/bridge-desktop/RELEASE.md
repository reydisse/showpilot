# ShowPilot Bridge release checklist

ShowPilot Bridge is released independently from the complete ShowPilot Desktop
operator product. It serves remote devices, browser-only operators, and
headless production computers; ShowPilot Desktop embeds the same local engine.
Only tags matching `bridge-v*` publish this bundle.

## One-time GitHub setup

Add these repository secrets before creating the first public release:

- `TAURI_SIGNING_PRIVATE_KEY`: the complete contents of the private updater key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password (empty only if the key
  was deliberately generated without one)
- `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD`: Developer ID
  Application signing credentials
- `APPLE_SIGNING_IDENTITY`: optional explicit identity; Tauri infers it from
  `APPLE_CERTIFICATE` when this secret is absent
- `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`: notarization credentials

The updater public key and product-specific ShowPilot update endpoint are
embedded in `src-tauri/tauri.conf.json`. Never commit
the private key. The fresh local key generated while preparing this bundle is at
`/private/tmp/showpilot-bridge-updater-key-v2`; move it to a password manager and
GitHub Actions secret before publishing.

## Release a version

1. Update the version in `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json`, and `../bridge/package.json` so the installer,
   updater, and embedded engine report the same version. Packaging refuses to
   run when they differ.
2. Run `pnpm install --lockfile-only` if package metadata changed.
3. Verify locally with `pnpm -C apps/bridge-desktop build`,
   `pnpm -C apps/bridge build`, and
   `cargo check --offline --manifest-path apps/bridge-desktop/src-tauri/Cargo.toml`.
4. Commit and push the version change.
5. Create and push a tag, for example:

   ```bash
   git tag bridge-v0.1.8
   git push origin bridge-v0.1.8
   ```

The workflow builds macOS Intel/Apple Silicon, Windows, and Linux installers,
signs updater artifacts, and creates a draft GitHub release. Review the assets
and publish the draft only when the release notes, signing checks, and clean-
machine smoke tests are complete. Upload the approved installers and signed
updater bundles to the private downloads R2 bucket, then publish the release
manifest last by following `apps/landing/RELEASES.md`. Bridge checks
`https://www.showpilot.tech/updates/bridge/latest.json`; it never reads the
repository-wide GitHub “latest release.”

Label the download choices prominently in every published release:

- Apple Silicon Macs (M1 and newer): `aarch64.dmg`
- Intel Macs: `x64.dmg`
- Windows: `.exe`, or `.msi` for managed deployment

The Apple Silicon installer must be the first Mac option in the release notes.
Do not describe the Intel build as the generic macOS download.

The workflow refuses to publish macOS artifacts when Apple signing or
notarization credentials are missing. Never publish an unsigned macOS DMG or ask
operators to bypass Gatekeeper. Before publishing, install both Mac builds on
fresh machines and verify them with `spctl --assess --type execute --verbose`.

## Operator behavior

The app starts the local bridge, keeps it supervised, and adds a tray/status-bar
menu. Closing the setup window hides it; it does not stop the bridge. Use the
tray menu to reopen the setup, restart the bridge, or quit it. Existing site,
organization, ProPresenter, and key settings are preserved across updates.

The app checks for signed updates shortly after launch and the **Check for
updates** action can also be used manually. Users should restart the app after
an update is installed.
