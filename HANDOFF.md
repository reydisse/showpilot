# ShowPilot development handoff

Updated: 2026-08-23 (Africa/Accra)

Read this file, `CLAUDE.md`, and the live Git state before making changes. Always
check whether the intended branch/worktree already exists before creating one.

## Current production state

- Repository: `reydisse/showpilot`
- Production branch: `main`
- Current checkout: `/Users/aopare/faithfire-cf`
- Production commit: `44a60a6`, merged by
  [PR #44](https://github.com/reydisse/showpilot/pull/44).
- GitHub CI and the D1 migration-manifest gate passed for `44a60a6`.
- The protected deploy workflow released Cloudflare version
  `e7f6b767-bdc8-4aa7-9b7b-51ea62821948` on 2026-08-23.
- `https://showpilot.tech/api/health` reports `44a60a6f429c86979a4adc77aefb24a9a5d635fc`.
- The root checkout is clean on `main`. The merged remote feature branch was
  deleted.

Commits in the 2026-08-23 release:

- `3c8c314`: Desktop and Bridge release hardening, native notifications,
  updater support, and explicit local-device ownership.
- `4430389`: web rundown drag ordering, dated service pickers, and persistent
  native chat history.
- `47b708a`: rundown automation routing to the Production Chat Durable Object.
- `3edd7f4`: generated Cloudflare binding types and the separate secret-binding
  declaration.

This release also contains the earlier multiple-show foundation, comfortable
light mode, profile-photo saving, timer additions beyond assigned duration,
weekly access grants, custom call times, and multi-operator rundown sync.

## Rundown synchronization

The Cloudflare RundownRelay Durable Object is authoritative for the selected
organization/show room. It now:

- hydrates and persists state deterministically;
- stores a monotonically increasing revision and recent command IDs;
- rejects duplicate or stale simultaneous commands and returns canonical state;
- persists timer, item status, actual start/end, reset, and clear changes to D1;
- rebases relay timestamps to each receiving client's clock;
- ignores stale WebSocket callbacks and reconnects safely;
- activates a show only when it actually starts, not when someone browses it;
- keeps operator, desktop, PM dashboard, and kiosk state aligned.

Real two-browser testing covered simultaneous Next commands, reconnect/hydrate,
timer adjustment beyond assigned duration, and live kiosk updates.

## Completed recovered WIP

- Planning Room targeted member links, notification deep links, focused chat
  messages, client-generated message IDs, and Stage Manager invite authority.
- Desktop-aware notification refresh and accessible profile/production controls.
- Grouped Assets with quantities and independent per-unit status, location,
  serial, and notes. Bulk creation never duplicates a physical serial number.
- Authenticated checklist attribution and Stage Manager check-in access.
- Rectangular multi-section CSV reports and working pdfmake 0.3 PDF downloads.
- Additional scripture/lower-third templates.
- ProPresenter current-slide import through direct LAN or remote Bridge paths.
- BridgeRelay now forwards all command responses and device events to browser
  clients; the prior behavior could show Bridge online while equipment commands
  timed out.
- Responsive Check-in header and the accessibility findings from the smoke WIP.
- Rundown row drag ordering on the web and Desktop-hosted web UI.
- Service date labels on shared service pickers.
- Native chat history in Durable Object SQLite storage.
- Desktop notification delivery and notification-click routing.
- Desktop local-device mode with explicit venue-computer confirmation. Remote
  Desktop operators continue to use the venue Bridge.
- Standalone Bridge parent-process supervision, connection diagnostics, safer
  config storage, and ProPresenter readiness checks.

## Verification completed

- Web tests: 48 files, 514 tests passed.
- Bridge tests: 6 files, 29 tests passed.
- TypeScript: `pnpm --filter @showpilot/web exec tsc --noEmit` passed.
- Cloudflare types: `pnpm exec wrangler types --check` passed from `apps/web`.
- Production web client/SSR build passed without `.dev.vars` in output.
- Desktop Rust tests: 12 passed. Standalone Bridge Desktop Rust tests: 6 passed.
- Desktop `0.1.1` and standalone Bridge `0.1.8` ARM64 app and DMG builds passed.
- The installed `/Applications/ShowPilot Desktop.app` is Desktop `0.1.1`. The
  prior install remains at
  `/Applications/ShowPilot Desktop 0.1.0 Pre-0.1.1 Backup.app`.
- The local macOS builds use ad-hoc signatures. Do not publish or tag them.
  Wait for the Apple Developer ID certificate and notarization secrets.
- Wrangler strict dry-run passed. The final rendered production login smoke
  passed on both production domains without page or console errors.
- Rendered local QA passed for Assets bulk grouping/per-unit editing, Planning
  Room messaging, profile-photo upload/save, ProPresenter connection states,
  mobile Check-in layout, and real CSV/PDF downloads.

## Preserved recovery stashes

The two audited dirty trees were stashed only after their work was integrated
and committed. Do not apply or drop these unless doing a recovery comparison:

- `stash@{0}` at handoff creation — former `fix/web-smoke-findings` WIP,
  integrated into `c40230c` and its preceding commits.
- `stash@{1}` at handoff creation — former root
  `feature/multiple-show-instances` WIP, integrated into the same branch.
- Older stashes remain intact: Tauri desktop spike, team chat redesign, and the
  historical main WIP. Stash numbers can shift; identify them by message.

## Database and release boundary

- The migration manifest records migrations through
  `0029_weekly_access_grants.sql`.
- This integration adds no new migration.
- Do not run a remote migration merely for local testing.
- Future code changes must start on a checked, purpose-specific feature/fix
  branch and require fresh authorization before push, merge, deployment,
  release, or production mutation.

## Product roles

- `apps/desktop` is the full ShowPilot product in a native Tauri host. It uses
  local-network capabilities when the operator is at the venue and the Bridge
  path for remote equipment access.
- `apps/bridge` is the local device engine.
- `apps/bridge-desktop` is the standalone Bridge supervisor/tray installer.
- Do not confuse the full desktop product with the standalone Bridge app.

## Separate React Native work

- `/private/tmp/showpilot-react-native-mobile` remains on
  `feature/react-native-mobile`.
- That worktree contains uncommitted React Native source, mobile API changes,
  and `0030_multitenant_push_subscriptions.sql`.
- The branch still starts at `9a1bfe5`. Merge current `main` into the feature
  branch and resolve its overlapping Worker files before release validation.
- Do not apply migration `0030` or deploy the mobile API until that branch has
  passed its mobile, web, and migration checks.
- Existing web, Desktop `0.1.0`, Desktop `0.1.1`, and Bridge `0.1.7` clients
  remain compatible with the current production protocol. Older Desktop builds
  do not have the new native updater, notification, or local-device controls.
