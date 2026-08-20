# ShowPilot Bridge

Small installable desktop connector for ShowPilot production equipment. This
app is intentionally separate from the unfinished operator desktop: it only
configures, supervises, and displays health for the local bridge runtime.

## Development

From the repository root:

```bash
pnpm -C apps/bridge build
pnpm bridge-desktop:dev
```

## Release build

Install Bun and build on the target platform:

```bash
pnpm bridge-desktop:build
```

The release bundles the compiled bridge runtime under the application
resources, so operators do not need Node.js installed. The app restores its
configuration on launch and restarts the bridge if the process exits.

See [RELEASE.md](./RELEASE.md) for signing, GitHub Actions, public downloads,
and updater setup. Once configured, the app can launch at login and stay in the
system tray while the bridge runs in the background.
