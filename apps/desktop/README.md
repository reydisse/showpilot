# ShowPilot Desktop

ShowPilot Desktop is the native host for the complete ShowPilot web app. Development
loads the local web app. Release builds start from a bundled bootstrap, open
`https://app.showpilot.tech` when reachable and safe to leave local control, and
otherwise show the prepared local rundown and device cues. Active and finished
local sessions stay visible until the operator returns control or reviews progress.
Desktop-only features are exposed through a small, validated Tauri command
boundary.

## Run locally

Install the workspace dependencies and the current stable Rust toolchain,
then run from this directory:

```bash
pnpm desktop:dev
```

Build the native application and installer with:

```bash
pnpm desktop:build
```

macOS artifacts are written under
`apps/desktop/src-tauri/target/release/bundle`.

`desktop:dev` compiles and supervises the real ShowPilot device engine, starts the web app
on its reserved port 3001, and opens it in the native window. Release builds point the
webview at the production origin, so the desktop and browser products cannot drift.

The desktop dev server uses strict port binding so it fails clearly instead of
silently loading a different worktree's frontend. Set
`SHOWPILOT_DESKTOP_WEB_URL=http://localhost:3001` when overriding companion
window origins in debug builds. This debug-only override is rejected for
non-local URLs; release companion windows always use `https://showpilot.tech`.

## Native boundary

- `engine_info` confirms the UI is running inside the native engine and
  returns the platform and application-data location.
- `cache_service` validates, size-limits and atomically writes an active-show
  snapshot to the ShowPilot application-data directory.
- `get_cached_service` remains available for older hosted clients. The current
  offline screen uses `local_show_command` and the encrypted Bridge preparation.
- `local_show_command` runs prepared timer and device actions through the native
  engine. Device receipts persist before dispatch; retries reuse their request ID.
  Returning control pauses the local timer and preserves its revision-bound journal.
- `open_local_show` opens the bundled local controls from the main workspace. Both
  local commands are restricted to the main window and trusted ShowPilot origins.
- `open_companion_window` opens validated dedicated Timer, Show Board and
  Check-in windows; live output windows stay on top.
- The embedded, architecture-matched ShowPilot device engine provides the same
  ProPresenter, OBS, vMix and profile-driven device capabilities as the standalone Bridge.
- The native notification plugin delivers personal ShowPilot notifications while
  Desktop is running, including when its window is in the background; clicking
  one focuses the app and opens its validated organization destination.
- The signed native updater checks ShowPilot's private-R2-backed release
  manifest, downloads the correct platform bundle and restarts after install.

Bundled content and the exact `https://showpilot.tech` and
`https://app.showpilot.tech` origins receive native capability access.

The standalone ShowPilot Bridge remains the supported agent for remote devices,
browser-only operators and headless production computers. A machine running
ShowPilot Desktop does not need the standalone Bridge for its own local devices.

## Local control verification

`pnpm --filter @showpilot/desktop test:offline` builds the Bridge and runs the
rendered offline controls against its actual local-show manager. It covers timer
advance, confirmations, a lost device reply, pending equipment, unknown outcomes,
restart recovery, saved review journals, status retry and keyboard focus.

Desktop's rundown page offers **Prepare this show** after the cloud state is
saved. It requires current rundown control, device and timecode access, plus this
computer's active Bridge installation. **Local show** opens the bundled controls.
After **Finish local control**, return to the saved show's rundown to review the
local timer and device receipts, download a public record, or sync timer progress.
Sync always uses the original cloud revision. A conflict preserves both versions;
a retry can confirm an earlier successful sync and never replays device cues.
Discarding or replacing a saved record requires confirmation.

The device engine holds a process-owned SQLite transaction lock before opening
its journal or device connections. A second engine cannot take the same local
store while the first is alive, even if the Desktop window process crashes.
The OS releases ownership when the engine exits. Pending device receipts recover
as unknown and are never automatically replayed. The `owner.sqlite` file contains
no show data; do not delete it while an engine is running.

From the repository root, `node apps/bridge/scripts/check-local-show.mjs` exercises
the compiled engine with
the real OS keychain and disposable equipment. It checks competing engines,
forced termination with a pending device reply, held recovery, duplicate
suppression and cloud handoff. Ownership unit tests also kill the engine's parent
and verify that a surviving orphan retains its lock. Development local control
requires Node 24; packaged applications use their bundled Bun runtime.

Local-mode rollout is still in progress. Hosted preparation/review and offline
controls have been exercised together with disposable equipment fixtures. Full
native/cloud product rehearsal and current all-platform bundles remain required
before release. See the Phase 2.3 entries in `docs/safety-pass-status.json`.
