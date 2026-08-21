# ShowPilot Desktop release checklist

Desktop releases use `desktop-v*` tags and are created as GitHub draft releases.
The macOS jobs intentionally fail when the Apple signing credentials are absent;
we do not publish macOS downloads that Gatekeeper reports as damaged.

## One-time Apple setup

1. Enroll the ShowPilot legal entity in the paid Apple Developer Program. An
   organization account requires an authorized Account Holder, a D-U-N-S Number,
   an organization-domain email address, and a public organization website.
2. In Keychain Access, create a Certificate Signing Request.
3. As the Apple Developer Account Holder, create a **Developer ID Application**
   certificate, download it, and install it in the login keychain.
4. Export the certificate and private key from **My Certificates** as a password-
   protected `.p12`, then base64-encode it.
5. Create an app-specific password for the Apple Account used for notarization.
6. Add these GitHub Actions secrets without committing their values:
   - `APPLE_CERTIFICATE`: base64-encoded `.p12`
   - `APPLE_CERTIFICATE_PASSWORD`: `.p12` export password
   - `KEYCHAIN_PASSWORD`: a dedicated temporary-CI-keychain password
   - `APPLE_ID`: notarization Apple Account email
   - `APPLE_PASSWORD`: the app-specific password, not the Apple Account password
   - `APPLE_TEAM_ID`: Apple Developer Team ID

## Release a version

1. Confirm the desktop package, Cargo package and Tauri config versions match.
2. Run the web, Bridge and Rust tests, then build an application bundle locally.
3. Push the reviewed desktop branch and merge it through its pull request.
4. Tag the merge commit, for example `desktop-v0.1.0`, and push the tag.
5. Wait for all four platform jobs. On macOS, verify signing, notarization and
   stapling succeeded. Test the Apple Silicon DMG on a second Mac after downloading
   it through a browser so Gatekeeper evaluates the quarantined artifact.
6. Publish the GitHub draft release only after the smoke test passes.

Never send certificate files, private keys, passwords or notarization credentials
in chat or commit them to the repository.
