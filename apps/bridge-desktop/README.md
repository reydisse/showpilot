# ShowPilot Bridge

Small installable connector for ShowPilot production equipment. This app is
intentionally separate from the complete ShowPilot Desktop operator product:
it only configures, supervises, and displays health for the local bridge
runtime used by remote devices, browser-only operators, and headless production
computers. ShowPilot Desktop already embeds this engine for its own local
devices, so those users do not install both applications on the same machine.

## Active and standby computers

Create a separate named installation key for each computer in Settings → API →
Bridge installations. The first connection becomes active. Additional computers
remain on standby, including after the active computer disconnects. Select
**Take control** on a connected standby and confirm to move device control.
The selected installation survives reconnects and server restarts.

During takeover the old Bridge must finish its current command and acknowledge
that its device connections and repeating outputs have stopped. A Bridge that
predates this handshake must be updated or stopped before takeover can succeed.
If the request fails, review the displayed active computer and refresh status
before trying again. Check the equipment before retrying any command reported as
interrupted by the handoff. Takeover stops the old Bridge clock; it does not start
another show's automation.

Keys for one installation share one connection slot, including during rotation.
Rotation keeps the existing connection valid for the overlap window; stop that
connection before reconnecting with the replacement key. A duplicate connection
is rejected with code 4410 and does not disconnect the original computer.

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
