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

Local-mode rollout is still in progress. The authenticated preparation service and
offline controls are implemented; the hosted preparation and revision-conflict
review UI, complete product rehearsal and native ownership audit remain required
before release. See the Phase 2.3 entries in `docs/safety-pass-status.json`.
