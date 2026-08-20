# ShowPilot Bridge

Small installable connector for ShowPilot production equipment. This app is
intentionally separate from the complete ShowPilot Desktop operator product:
it only configures, supervises, and displays health for the local bridge
runtime used by remote devices, browser-only operators, and headless production
computers. ShowPilot Desktop already embeds this engine for its own local
devices, so those users do not install both applications on the same machine.

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
