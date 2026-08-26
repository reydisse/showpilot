# ShowPilot development handoff

Updated: 2026-08-26 (Africa/Accra)

Read this file, `CLAUDE.md`, and the live Git state before making changes. Always
check whether the intended branch/worktree already exists before creating one.

## Current production state

- Repository: `reydisse/showpilot`
- Production branch: `main`
- Production checkout: `/Users/aopare/faithfire-cf`
- Launch-candidate worktree: `/private/tmp/showpilot-launch-candidate`
- Production commit: `5e630c2`, merged by
  [PR #46](https://github.com/reydisse/showpilot/pull/46).
- `https://showpilot.tech/api/health` reported
  `5e630c2a1ee9d884a9f80858eb5039d83d019131` on 2026-08-25.
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
- The launch candidate adds `0030_multitenant_push_subscriptions.sql` and
  `0031_expo_push_receipts.sql`. Neither is applied to production yet.
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

## Launch candidate and React Native app

- `release/launch-candidate-2026-08-25` integrates the completed UI,
  landing/download, and React Native branches. The integration merge is
  `6e5db6b`; it is local only and has not been pushed or deployed.
- The native app is Expo SDK 54 / React Native 0.81.5 and targets the production
  API by default. Its package IDs are `tech.showpilot.mobile` on iOS and
  Android.
- The app includes native authentication, organization switching, rundown and
  timer synchronization, schedule responses, chat, incidents, Bridge-backed
  device controls, notifications, and profile-photo updates.
- Store-safe icon sources and 1024x1024 platform PNGs live in
  `apps/mobile/assets`. The verifier rejects transparent iOS icons, changed
  package IDs, and unused camera or microphone permissions.
- Native query refresh follows device connectivity and foreground state. Offline
  chat queues are discarded at organization/room boundaries, and service times
  are rendered in the venue timezone rather than the phone timezone.
- Full launch-candidate verification passed: 557 web tests, 19 landing tests,
  web production build, both Wrangler dry runs, all-platform mobile export, and
  Expo Doctor 18/18.
- Follow-up branch `fix/mobile-api-cors` is local-only on top of the launch
  candidate. It fixes credentialed Expo web auth, private-LAN trusted origins,
  browser-safe chat/rundown WebSockets, and native-only notifications/haptics.
  Credentialed LAN CORS is limited to local/private API hosts; production no
  longer trusts arbitrary LAN sites or historical hard-coded development IPs.
  Rendered 390x844 QA passed sign-in, organization selection, every primary
  tab, profile-name save, chat send/echo, and live rundown connection. Its full
  verification passes 563 web tests, the production web build, all-platform
  mobile export, and Expo Doctor 18/18.
- Stacked follow-up branch `fix/mobile-notification-integrity` is local-only on
  top of `fix/mobile-api-cors`. It makes unread totals independent of inbox page
  limits, adds the native tab badge and pull-to-refresh, refreshes foreground
  pushes, and carries the notification and organization IDs through Expo push.
  Tapping an alert now activates its workspace before routing and marks that
  inbox record read. Verification passes 564 web tests, the production build,
  iOS/Android/web exports, mobile TypeScript/lint, and Expo Doctor 18/18.
- Stacked follow-up branch `fix/mobile-onboarding` is local-only on top of the
  notification branch. Native sign-up now includes the legal links and no
  longer strands a new user without a workspace: it supports verification
  resend/refresh, account switching, validated workspace names/URLs, native
  organization creation, and immediate activation. A fresh local-only account
  completed the rendered 390x844 path from sign-up through owner command center
  without page or console errors.
- Stacked follow-up branch `feature/mobile-settings-profile` is local-only on
  top of onboarding. It separates identity from device preferences, adds a
  persisted system/light/dark appearance choice, exposes the real notification
  permission state, and gives mobile users password recovery, legal links, and
  non-sensitive app/service diagnostics from a dedicated Settings screen.
- Stacked follow-up branch `fix/mobile-launch-polish` is local-only on top of
  the settings/profile branch. It owns the shared bootstrap polling interval in
  the tab shell instead of every mounted screen, memoizes and bounds chat row
  rendering, aligns device/operation/assignment icons with their actions, and
  fixes mobile assignment and incident touch/accessibility targets.
- Stacked follow-up branch `fix/web-settings-notification-integrity` is
  local-only on top of the mobile launch-polish branch. Web and Desktop now
  show only notification controls that are actually enforced, explain the
  always-on operational alert policy, keep per-device notification permission
  visible, and share unread counts without competing Desktop polling loops.
  The account profile adds email-verification and password-reset status, and
  wide profile photos are cropped from the full square source before scaling.
  Verification passes 570 web tests, TypeScript, the production build, and a
  strict Wrangler dry-run. Rendered desktop and 390x844 QA covered Settings,
  the account menu, the full profile/security panel, and a real 1200x630 photo
  upload that produced a correctly served 256x256 avatar.
- Stacked follow-up branch `fix/landing-release-pipeline` is local-only on top
  of the web settings/notification branch. It adds landing type/test/build/
  Worker dry-run gates to CI, deploys the landing Worker from the exact
  CI-validated `main` commit, blocks both production deployments when the
  private downloads bucket is missing, and smoke-tests the live download
  center and manifest after deployment. The reusable smoke tool passes against
  the real local Worker at desktop and 390x844 widths.
- Stacked follow-up branch `fix/native-release-readiness` is local-only on top
  of the landing pipeline. It adds a repository-wide Desktop/Bridge release
  verifier, exact tag-to-version gates, checked-in updater build configs,
  previously missing native Rust CI, and fail-closed Windows Authenticode
  signing plus post-build verification. The verifier covers package, Cargo,
  lockfile, Tauri identity/version, updater key/endpoint, workflow, and landing
  download-route drift. GitHub's competing `latest.json` output is disabled;
  only the verified ShowPilot landing manifest is authoritative for updates.
  Local verification passed 6 verifier tests, 12 Desktop
  Rust tests, 6 Bridge Desktop Rust tests, and real no-bundle Tauri builds for
  both products with their embedded Apple Silicon Bridge sidecars.
- Stacked follow-up branch `fix/mobile-release-readiness` is local-only on top
  of the native release gate. It adds SDK 54-compatible development-client and
  update modules, an `appVersion` runtime policy, explicit EAS environments and
  channels, manual build-only internal/production workflows, CI mobile
  verification, and a release gate that requires the approved Expo owner,
  project UUID, matching update URL, and authenticated workflow validation.
  The ordinary gate passes locally with all-platform exports and Expo Doctor
  18/18. Clean native generation, an Android debug APK (530 Gradle tasks), and
  a local release AAB (874 Gradle tasks) also pass; both artifacts contain
  Reanimated and Worklets libraries for all four configured ABIs. The local AAB
  is intentionally self-signed with the generated debug key and is not a store
  artifact. CocoaPods installed all 108 iOS pods, including Dev Client and
  Updates; local Xcode compilation is waiting on its missing iOS 26.5 platform
  component. The release gate intentionally remains red until the owner links
  the real EAS project. No Expo project, credential, cloud build, update, or
  submission was created.
- Stacked follow-up branch `fix/launch-audit-findings` is local-only on top of
  mobile release readiness. It fixes Durable Object hibernation recovery for
  chat mutations, lower-thirds subscribers, and timecode subscribers; adds a
  safe all-numbered-migrations local D1 runner; and gives rundown timer
  adjustments distinct accessible names. Real browser QA covered onboarding,
  profile-photo save, notification scrolling, chat mentions and persistence,
  two-operator rundown/timer sync, drag ordering, and time additions beyond the
  assigned duration. The same branch reduces the iOS/Android Hermes bundle from
  about 7.72 MB to 5.88 MB by replacing the Lucide package barrel with direct
  icon imports. CI now rejects barrel regressions and native bundles above 6.5
  MB. The all-platform native verifier and Expo Doctor 18/18 pass, and rendered
  mobile QA confirmed the optimized Home, Operations, Inbox, and Profile icons.
  Profile name changes now refresh route-owned crew and duty data immediately.
  ShowPilot-managed avatar uploads store same-origin paths instead of the upload
  machine's origin. Web, kiosk, and native clients also normalize old absolute
  avatar records. A real browser upload stored the portable path, served a
  256x256 image through the LAN origin, and survived a full reload.
- The same launch-audit branch now hardens the landing download center. The
  exact `/downloads` path reaches the Worker and redirects to `/#downloads`,
  unpublished updater checks return `204` instead of a false outage, and known
  public button IDs fail closed when their product/platform metadata drifts.
  Customer-facing product status now ignores hidden updater artifacts and
  distinguishes an unpublished release from a manifest/network failure. Static
  assets ship CSP, clickjacking, permissions, referrer, and MIME-sniffing
  protections. Keyboard focus, reduced-motion behavior, and 44px mobile nav
  targets are covered in rendered QA. The reusable smoke test now proves the
  security headers and direct-download redirect; the native release verifier
  locks all Worker-first routes. Local proof passed 22 landing tests, the full
  landing verify/dry-run, seven release-contract tests, empty/outage/published
  browser states, real artifact and byte-range responses, and 1440x900 plus
  390x844 layouts without overflow or console errors.
- The launch-audit branch now separates a new RundownRelay room from an
  authoritative empty rundown with a persisted `initialized` flag. An ordinary
  loader seed can initialize a room once. Later stale clients cannot restore
  items after `clear-all`; a forced template load can still replace the state.
  Legacy relay snapshots infer initialization from their items and revision so
  existing rooms stay compatible. Web, PM dashboard, Show display, and React
  Native clients now use the same contract. Browser-generated rundown and chat
  IDs also work on private-LAN HTTP origins where `crypto.randomUUID()` is not
  available.
- Real two-client LAN QA created and cleared a rundown, then sent a stale seed
  at the accepted revision. The relay kept revision 3 and both clients stayed
  empty after reload. A separate chat message completed send, edit, and delete
  on the same HTTP origin. The rundown's fragile timed second-click clear action
  is now an accessible confirmation dialog; rendered 1280x800 and 390x844 QA
  covered both Cancel and Clear rundown. Fresh page-error logs were empty.
  Verification passes 580 web tests, web and mobile TypeScript, the production
  web build, Desktop/Bridge readiness, all-platform Expo export, Expo Doctor
  18/18, and the 6.5 MB native bundle budgets.
- The launch-audit branch now lets members with `schedule:manage` create a show
  from the React Native app. The native and web entry points call one
  server-only creation core, so plan limits, venue-timezone conversion,
  inventory or previous-show cloning, execution-state resets, and partial-write
  cleanup cannot drift between platforms. The native form validates title,
  real calendar date, optional 24-hour start time, and location before opening
  the new rundown. Incident reports also use and display the venue's calendar
  date instead of the phone's local or UTC date. Expo's generated route types
  now prove every changed navigation target; the verifier rejects double-cast
  `Href` workarounds.
- The web Schedule now treats `show` and `date` search parameters as loader
  dependencies and fetches an explicitly selected show/date alongside its
  bounded default window. This fixes notification links and far-future shows
  without querying every intervening month. The create form no longer caps
  planning at 31 days, the calendar follows the selected month, and deleting an
  explicitly selected show clears its stale URL. Real browser QA created a show
  for October 2027, opened it from combined, date-only, and show-only links at
  390x844 and 1280x800, reloaded it, and then deleted it. Follow-up local D1
  queries confirmed that both temporary QA shows and their related records were
  gone.
- Current verification passes 66 web test files and 589 tests, web and mobile
  TypeScript, the production web build, Wrangler type generation checks, a
  strict Worker dry-run, Desktop/Bridge readiness, all-platform Expo export,
  Expo Doctor 18/18, and native lint. The web main bundle is 494,025 bytes raw
  and 155,560 bytes gzip. The iOS and Android Hermes bundles are 5,896,829 and
  5,897,498 bytes, respectively, below the enforced 6.5 MB ceiling.
- A live Core Web Vitals trace is still outstanding because the current agent
  environment does not expose the Chrome DevTools MCP required by the
  performance-audit workflow. Production web bundle budgets and browser smoke
  tests pass, but they are not substitutes for that trace.
- A read-only production audit on 2026-08-26 found that `www.showpilot.tech`
  still serves the June landing deployment without the download center and
  that the `showpilot-downloads` R2 bucket does not exist. Do not create the
  bucket or deploy this branch without fresh authorization. After approval,
  create the private bucket first; the pipeline will then deploy and prove the
  new `www` surface. Signed/notarized installers and reviewed store listings
  remain separate publication gates before their buttons can activate.
- GitHub currently has the updater private-key secret but not the required
  Apple signing/notarization or Windows code-signing secrets. Do not create a
  native release tag until those credentials are configured; the hardened
  workflows intentionally fail instead of producing untrusted installers.
- Native push delivery still needs the approved EAS owner/project link,
  platform credentials, and a signed internal build. Apple distribution also
  waits on the owner's developer enrollment. Those external actions are not
  authorized or complete.
- Before deploying the mobile Worker endpoints, apply migrations 0030 and 0031
  through the protected migration workflow, then perform signed-device push,
  profile upload, organization switching, chat, Bridge control, and
  multi-operator rundown tests.
- Existing web, Desktop `0.1.0`, Desktop `0.1.1`, and Bridge `0.1.7` clients
  remain compatible with the current production protocol. Older Desktop builds
  do not have the new native updater, notification, or local-device controls.
