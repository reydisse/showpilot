# ShowPilot Bridge release checklist

ShowPilot Bridge is released independently from the unfinished operator desktop.
Only tags matching `bridge-v*` publish this bundle.

## One-time GitHub setup

Add these repository secrets before creating the first public release:

- `TAURI_SIGNING_PRIVATE_KEY`: the complete contents of the private updater key
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the key password (empty only if the key
  was deliberately generated without one)
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and
  `APPLE_SIGNING_IDENTITY`: Developer ID Application signing credentials
- `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`: notarization credentials

The updater public key is embedded in `src-tauri/tauri.conf.json`. Never commit
the private key. The fresh local key generated while preparing this bundle is at
`/private/tmp/showpilot-bridge-updater-key-v2`; move it to a password manager and
GitHub Actions secret before publishing.

## Release a version

1. Update the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json` so the installer and updater report the same
   version.
2. Run `pnpm install --lockfile-only` if package metadata changed.
3. Verify locally with `pnpm -C apps/bridge-desktop build`,
   `pnpm -C apps/bridge build`, and
   `cargo check --offline --manifest-path apps/bridge-desktop/src-tauri/Cargo.toml`.
4. Commit and push the version change.
5. Create and push a tag, for example:

   ```bash
   git tag bridge-v0.1.6
   git push origin bridge-v0.1.6
   ```

The workflow builds macOS Intel/Apple Silicon, Windows, and Linux installers,
signs updater artifacts, and creates a draft GitHub release. Review the assets
and publish the draft when the release notes and signing checks are complete.

Until Apple Developer enrollment is complete, the macOS jobs intentionally
produce unsigned builds. They are suitable for internal testing only; users
must manually approve them in Gatekeeper. Add the Apple secrets above later and
rerun the release to produce trusted macOS downloads.

## Operator behavior

The app starts the local bridge, keeps it supervised, and adds a tray/status-bar
menu. Closing the setup window hides it; it does not stop the bridge. Use the
tray menu to reopen the setup, restart the bridge, or quit it. Existing site,
organization, ProPresenter, and key settings are preserved across updates.

The app checks for signed updates shortly after launch and the **Check for
updates** action can also be used manually. Users should restart the app after
an update is installed.
