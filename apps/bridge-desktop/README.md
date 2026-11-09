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

## Approved device destinations

An administrator with API-key or integration settings access must approve each
device's host, port and protocol in Settings before it can connect. ProPresenter
needs approval for both its stage-display port and API port, including when its
connection is configured locally in the Bridge. Prepare these approvals before
switching a venue to the updated Bridge.

Deploy the server and updated native apps during a maintenance window. The server
refuses old Bridges without device-policy support, including existing sockets
restored after deployment. The updated Bridge also refuses device traffic when
an older server supplies no approval policy. There is no permissive fallback.

Removing approval blocks further commands and closes affected native connections.
This stops repeating lighting output and ProPresenter polling. The settings page
waits for the active Bridge to acknowledge that it applied the policy. If an older
or unresponsive Bridge cannot acknowledge it, the saved policy remains in force,
its cloud connection closes, and the page tells the operator to check the equipment
and update or restart the Bridge. A saved policy alone does not prove that physical
equipment has stopped. This changes connections, not the equipment's last state.

## Audio timecode

In the Bridge's **Timecode input** card, choose the audio interface, input channel,
and LTC frame rate, then choose **Connect LTC**. Match the source's drop-frame or
non-drop-frame setting. On macOS, allow microphone access when prompted. Audio
is decoded locally; only timecode labels leave the computer.

The input meter shows audio activity. **LTC locked** means the decoder has coherent,
advancing LTC frames; ordinary audio or a stopped label does not establish a clock.
The last decoded position remains visible after signal loss, with an increasing
frame age. The server holds the clock and pauses automation on missing feeds.
An unplugged interface is retried automatically; **Stop LTC** cancels reconnection.

MTC and LTC share one source selection. Switching inputs replaces the previous
input only after the new connection succeeds. Saving the connection settings
preserves the current input selection. The web Timecode screen identifies active
LTC and shows signal loss; configure audio devices in this native Bridge app.
A changed frame rate still requires the operator's timeline-format confirmation.

LTC capture currently lives in the standalone Bridge app. If Desktop is already
controlling the same equipment, stop its local-device engine before activating
this Bridge installation. Keep only the intended installation active.

Developer checks after building the Bridge UI and compiled sidecar:

```bash
node apps/bridge-desktop/scripts/smoke-timecode-inputs.mjs
node apps/bridge/scripts/check-native-timecode.mjs
```

The first check uses the production UI with simulated native device responses.
The second sends independently generated PCM through the native decoder and
compiled sidecar to a local WebSocket server. It substitutes the audio capture
stream, so a physical LTC input rehearsal is still required for hardware validation.

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
