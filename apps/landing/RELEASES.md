# Public Desktop and Bridge downloads

The landing Worker streams approved artifacts from the private
`showpilot-downloads` R2 bucket. It never exposes the private GitHub repository
or accepts an arbitrary R2 key from a request.

## One-time setup

From `apps/landing`, create the production bucket once:

```sh
pnpm exec wrangler r2 bucket create showpilot-downloads
```

Do not run this command when the bucket already exists. The bucket is private;
the landing Worker is the only public download path.

## Publish a release

1. Complete the product release checklist and test the downloaded artifact on
   the target operating system. For macOS, signing, notarization, and stapling
   must succeed before an artifact is public.
2. Calculate the SHA-256 checksum and byte size for every approved file.
3. Upload artifacts below a versioned key. Never overwrite a versioned object.

```sh
pnpm exec wrangler r2 object put \
  showpilot-downloads/releases/desktop/0.1.0/ShowPilot-Desktop_0.1.0_aarch64.dmg \
  --file=/absolute/path/ShowPilot-Desktop_0.1.0_aarch64.dmg --remote
```

4. Download the object through a staging Worker and verify its SHA-256 checksum
   matches the source artifact.
5. Update the manifest locally. The complete manifest is bounded to 20 entries
   and uses this shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-22T18:00:00.000Z",
  "releases": [
    {
      "id": "desktop-macos-arm64",
      "kind": "artifact",
      "product": "desktop",
      "version": "0.1.0",
      "status": "stable",
      "platform": "macOS",
      "architecture": "Apple Silicon",
      "label": "macOS · Apple Silicon",
      "key": "releases/desktop/0.1.0/ShowPilot-Desktop_0.1.0_aarch64.dmg",
      "fileName": "ShowPilot-Desktop_0.1.0_aarch64.dmg",
      "size": 29138349,
      "sha256": "replace-with-the-64-character-lowercase-sha256"
    }
  ]
}
```

Supported button IDs are:

- `desktop-macos-arm64`
- `desktop-macos-x64`
- `desktop-windows-x64`
- `bridge-macos-arm64`
- `bridge-macos-x64`
- `bridge-windows-x64`
- `mobile-ios`
- `mobile-android`

Desktop and Bridge entries use `"kind": "artifact"` and are streamed from
the private R2 bucket. Native mobile entries use `"kind": "store"` and an
allowlisted official store URL. iOS links must use `https://apps.apple.com`;
Android links must use `https://play.google.com`. The Worker rejects other
hosts, credentials in URLs, and a store that does not match the platform.

Desktop and Bridge auto-updates use additional stable artifact entries for the
signed Tauri updater bundles (`.app.tar.gz`, NSIS updater, or AppImage). Add the
matching `.sig` file contents as `updaterSignature`; never publish a signature
for a different file. The Worker derives `/updates/desktop/latest.json` and
`/updates/bridge/latest.json` independently from these entries, so the two
products can have different current versions while updater publication remains
one atomic manifest change.

```json
{
  "id": "desktop-update-macos-arm64",
  "kind": "artifact",
  "product": "desktop",
  "version": "0.1.0",
  "status": "stable",
  "platform": "macOS",
  "architecture": "Apple Silicon",
  "label": "macOS updater · Apple Silicon",
  "key": "releases/desktop/0.1.0/ShowPilot-Desktop_0.1.0_aarch64.app.tar.gz",
  "fileName": "ShowPilot-Desktop_0.1.0_aarch64.app.tar.gz",
  "size": 29138349,
  "sha256": "replace-with-the-64-character-lowercase-sha256",
  "updaterSignature": "paste-the-complete-matching-.sig-file-contents"
}
```

All updater entries for the same product must have one version and one artifact
per target. Supported mappings are macOS Apple Silicon/Intel, Windows x64, and
Linux x64. A missing updater entry returns HTTP 204, so public installer
downloads can exist before signed in-app updates are enabled.

```json
{
  "id": "mobile-ios",
  "kind": "store",
  "product": "mobile",
  "version": "1.0.0",
  "status": "stable",
  "platform": "iOS",
  "architecture": "Universal",
  "label": "Download on the App Store",
  "storeUrl": "https://apps.apple.com/app/showpilot/id1234567890"
}
```

Do not publish placeholder store IDs. Add each mobile entry only after its
store listing is public and the exact production build has passed the release
checklist.

6. Upload `manifests/releases.json` last. This is the atomic publication step:
   the landing page enables only entries in that manifest.

```sh
pnpm exec wrangler r2 object put \
  showpilot-downloads/manifests/releases.json \
  --file=/absolute/path/releases.json --remote
```

7. Confirm the landing page shows the intended versions. Test a full download
   and a resumed/range download, then compare checksums again.

To withdraw a bad release, remove its manifest entry first. Deleting the object
can happen later after caches expire.
