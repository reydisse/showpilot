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
   - `TAURI_SIGNING_PRIVATE_KEY`: updater signing key used by Desktop and Bridge
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: updater key password

## One-time Windows setup

Windows browser downloads must be Authenticode signed. Obtain a current code-
signing certificate or trusted-signing service for the ShowPilot legal entity;
do not publish an installer that asks operators to ignore SmartScreen.

For the PFX workflow currently encoded in GitHub Actions, add:

- `WINDOWS_CERTIFICATE`: the base64-encoded `.pfx`
- `WINDOWS_CERTIFICATE_PASSWORD`: the `.pfx` export password
- `WINDOWS_TIMESTAMP_URL`: the HTTP or HTTPS timestamp service supplied by the
  certificate issuer

The Windows job imports the certificate, discovers its thumbprint, merges it
into `ci-release.conf.json`, and refuses the release unless the application,
EXE installer, and MSI installer all have valid Authenticode signatures.

## Release a version

1. Run `pnpm native:verify`. It checks package, Cargo, lockfile, Tauri, updater,
   workflow, and landing-release contracts together.
2. Run the web, Bridge and Rust tests, then build an application bundle locally.
3. Push the reviewed desktop branch and merge it through its pull request.
4. Tag the merge commit, for example `desktop-v0.1.1`, and push the tag. The
   workflow rejects any tag that does not exactly match the committed version.
5. Wait for all four platform jobs. On macOS, verify signing, notarization and
   stapling succeeded. Test the Apple Silicon DMG on a second Mac after downloading
   it through a browser so Gatekeeper evaluates the quarantined artifact.
6. Publish the GitHub draft release only after the smoke test passes.
7. Upload each signed updater bundle and installer to the private downloads R2
   bucket. Add the updater bundle's matching `.sig` contents to the release
   manifest as `updaterSignature`, then publish the manifest last. Desktop
   checks `https://www.showpilot.tech/updates/desktop/latest.json`; it never
   reads the repository-wide GitHub “latest release.”

Never send certificate files, private keys, passwords or notarization credentials
in chat or commit them to the repository.
