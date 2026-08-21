# ShowPilot development handoff

Updated: 2026-08-21 (Africa/Accra)

Read this file, `CLAUDE.md`, and the live Git state before making changes. Always
check whether the intended branch/worktree already exists before creating one.

## Current production state

- Repository: `reydisse/showpilot`
- Production branch: `main`
- Current checkout: `/Users/aopare/faithfire-cf`
- Base release: `e48ecd3` (`release/desktop-production-ready`)
- Integration PR [#38](https://github.com/reydisse/showpilot/pull/38) merged into
  the release candidate; release PR
  [#39](https://github.com/reydisse/showpilot/pull/39) merged into `main`.
- Product release commit `4098024a` passed three GitHub CI runs, passed the D1
  migration-manifest gate, and deployed successfully to `showpilot.tech` on
  2026-08-21. The health endpoint reported that exact commit after deployment.
- The merged remote integration branch was deleted; its local branch remains
  available for historical comparison.
- The former temporary integration worktree was removed after this branch was
  moved into the clean primary checkout.

Commits added above the release candidate:

- `7269755` — multi-operator rundown synchronization and authoritative runtime
  persistence.
- `9a5341d` — targeted Planning Room collaboration, message destinations, and
  notification behavior.
- `08d47bc` — completed production workflows: grouped Assets, check-in,
  checklist attribution, reports/exports, templates, and accessibility.
- `c40230c` — completed remote Bridge command/event routing and ProPresenter
  slide import.

The release base already contains the completed multiple-show foundation,
comfortable light mode, profile-photo saving, timer additions beyond assigned
duration, full desktop host, and Bridge sidecar packaging work.

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

## Verification completed

- Web tests: 39 files, 481 tests passed.
- Bridge tests: 3 files, 15 tests passed.
- TypeScript: `pnpm --filter @showpilot/web exec tsc --noEmit` passed.
- Production web client/SSR build passed without `.dev.vars` in output.
- Native macOS desktop `.app` and ARM64 `.dmg` builds passed using the Bun 1.4.0
  executable pinned by `.github/workflows/desktop-release.yml`.
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
  `0027_enable_multiple_show_instances.sql`.
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
