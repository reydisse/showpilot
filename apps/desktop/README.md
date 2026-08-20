# ShowPilot Desktop

ShowPilot Desktop is the native host for the complete ShowPilot web app. It
does not maintain a second dashboard or a second navigation model: development
loads the local web app and release builds load `https://showpilot.tech`.
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

`desktop:dev` starts the real app in `apps/web` on port 3000 and opens it in
the native window. Release builds point the webview at the production origin,
so the desktop and browser products cannot drift.

## Native boundary

- `engine_info` confirms the UI is running inside the native engine and
  returns the platform and application-data location.
- `cache_service` validates, size-limits and atomically writes an active-show
  snapshot to the ShowPilot application-data directory.
- `get_cached_service` reads that snapshot for the future offline bootstrap.
- `open_companion_window` opens validated dedicated Timer, Show Board and
  Check-in windows; live output windows stay on top.

Only bundled development content and the exact `https://showpilot.tech`
origin receive native capability access.

## Next engine slices

1. Add SQLite-backed service snapshots and an append-only local event journal.
2. Reconcile local events with Cloudflare after reconnecting.
3. Add OSC and MIDI discovery/output behind Rust commands.
4. Add OBS, vMix and ProPresenter connections through the local engine.
