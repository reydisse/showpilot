# ShowPilot development handoff

Updated: 2026-08-27 (Africa/Accra)

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
- The launch candidate adds `0030_multitenant_push_subscriptions.sql`,
  `0031_expo_push_receipts.sql`, and `0032_checklist_entry_uniqueness.sql`.
  None is applied to production yet.
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
  browser states, real artifact and byte-range responses, and 1440x900,
  390x844, and 320x700 layouts without overflow or console errors. The narrow
  navigation now keeps both actions on one 44px row instead of wrapping the
  primary CTA, and the feature icon styles use one consolidated outline system.
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
- Native schedule notifications now preserve their exact service date and
  assignment through the notification parser, Expo Router destination, native
  query, and tenant-scoped Worker API. The selected assignment is resolved only
  for full schedule operators or its assignee, and its day takes precedence
  over the ordinary bounded schedule range. The native Schedule brings that
  show to the top and highlights the selected assignment. Invalid dates and IDs
  are discarded at the notification boundary and rejected again at the API.
- Native cold starts now wait for active-organization loading before redirecting
  from Schedule, Chat, Incidents, Devices, individual Device controls, or the
  tab shell. Rendered 390x844 QA cold-opened a notification for a December 24,
  2028 assignment outside the default window and retained the exact URL, show,
  and highlighted assignment. Direct cold opens of Production Chat, Incidents,
  and Devices also retained their destinations; Chat loaded its persisted
  history. The temporary show and assignment were deleted afterward and local
  D1 queries confirmed both IDs were gone. The mobile verifier now locks the
  organization-loading and exact-schedule-routing source contracts.
- Authentication and transactional email delivery no longer write recipient
  addresses, subjects, verification/reset URLs, reset tokens, or raw Resend
  response bodies to application logs or propagated errors. Provider failures
  retain only the HTTP status and request ID needed for operations. Three
  privacy tests cover success, provider rejection, and missing configuration;
  the production-build boundary verifier rejects ordinary auth/email logging
  and raw provider-body reads so the leak cannot silently return.
- D1 rate limiting now admits a request with one conditional `INSERT ...
  SELECT` instead of a racy count-then-insert pair. Concurrent requests cannot
  all observe the same pre-limit count, and an expired-row cleanup failure no
  longer reverses a blocked decision. The deliberate storage-outage fail-open
  policy remains unchanged because Cloudflare WAF is the durable production
  layer. Five tests cover admission, rejection, cleanup failure, storage
  outage, and trusted client-IP extraction. An isolated real local D1 run with
  a five-request cap accepted IDs 1–5 and rejected ID 6.
- Temporary access-grant notifications now open the exact feature granted
  instead of the Team page, which some recipients cannot access. Every
  capability destination is a closed TypeScript union and a tested internal
  notification route. Web and Desktop open the exact organization-scoped tool;
  native maps exact Schedule, Incident, and Device grants to those screens and
  sends the remaining web-only controls to Shows or Operations. Revocation
  alerts intentionally have no action because the destination is no longer
  authorized. Rendered QA opened a Graphics access alert at
  `/showpilot-qa-workspace/streaming/graphics`; the temporary notification was
  deleted afterward and local D1 confirmed no matching record remained.
- The RBAC registry no longer advertises the never-implemented
  `cuesheet:push_to_checklist` permission. Rundown-to-checklist generation stays
  in the Checklist page under its real `checklist:access` permission. The four
  unused standalone CueSheet server functions were also removed; they duplicated
  the rebuilt rundown-backed cue sheet and allowed ordinary organization access
  to reach legacy writes. The old database table remains intact for recovery
  until its production data is audited. The production build now fails if
  either the legacy exports or a `PLANNED` permission returns.
- Removing a checklist item from one service now deletes only that
  organization-scoped entry. The previous action deleted the reusable template,
  which cascaded into every service that used it. The confirmation dialog now
  states the real service-only scope, and the build rejects restoration of the
  global template-delete endpoint. Rendered QA created two service entries that
  shared one template, removed the August entry through the UI, and confirmed
  both visually and in D1 that the September entry and template survived. All
  temporary QA rows were deleted afterward.
- Adding a checklist item is now one server-owned operation. New templates and
  their first service entry use an atomic native D1 batch because Prisma's D1
  transaction adapter does not provide atomicity. Stable template identities,
  `INSERT OR IGNORE`, and migration `0032_checklist_entry_uniqueness.sql` make
  retries and concurrent operators converge on one entry per show. The old
  split template/entry endpoints are removed and blocked by the production
  verifier. A read-only production preflight found zero duplicate groups and
  zero orphan templates. A fresh local database applied all 32 migrations
  twice, the unique index rejected a real duplicate insert, and two signed-in
  browser sessions adding the same item concurrently produced one template and
  one August entry. Reusing it in September kept one template and produced one
  entry per show. All temporary QA rows were deleted afterward.
- The launch audit now enforces least-privilege access at the server boundary
  for Assets, Audio, crew management, report exports, native and external chat,
  rundown reads, OnTime, lower-third library resets, and ProPresenter control.
  Check-in operators now receive a read-only crew roster while organization
  member administrators retain add/edit/delete controls. Reactions now enforce
  the permission for their actual content type, and chat notification links use
  the organization slug resolved by the server instead of client-supplied
  routing data. Member-visible organization settings are explicitly
  allowlisted so integration credentials and API keys cannot leak through the
  shared settings reader. ProPresenter proxy requests use the saved
  organization target instead of a client-supplied host, and unused legacy
  notification, lower-third, and OnTime endpoints were removed. A real
  Workers-runtime D1 integration test now proves that memberships, temporary
  grants, and member-visible settings stay tenant-scoped. Rendered QA confirmed
  a Production Manager receives read-only Assets UI while a Tech Manager can
  open the management dialog; the local QA account was restored to Owner.
- Native operational feeds now use bounded `FlatList` rendering for Shows,
  Inbox, Schedule, Incidents, Devices, and live rundown items. The 100 ms live
  timer repaint is isolated in its own panel instead of rerendering every
  rundown row ten times per second. Pull-to-refresh, keyboard insets, empty and
  error states, and the existing interaction controls remain intact. The mobile
  verifier locks these performance contracts. A fresh all-platform export and
  Expo Doctor 18/18 passed after the change. The current private-LAN SDK 54
  test pair also passed auth preflight, credential sign-in, and session
  creation; Expo Go is available at `exp://10.128.57.247:8083` while that local
  QA server remains running.
- Current verification passes 72 web unit-test files and 616 unit tests, five
  interactive-control boundary tests, plus one Workers-runtime D1 integration
  test; web and mobile TypeScript, the production web build, Wrangler type
  generation checks, a
  strict Worker dry-run, Desktop/Bridge readiness, all-platform Expo export,
  Expo Doctor 18/18, and native lint. The web main bundle is 493,898 bytes raw
  and 155,431 bytes gzip. The iOS and Android Hermes bundles are 5,903,771 and
  5,904,394 bytes in that audit, respectively, below the enforced 6.5 MB
  ceiling; the latest native figures are recorded below.
- A release-artifact Lighthouse audit of the authentication entry point scores
  99 performance and 100 accessibility, best practices, and SEO. FCP, LCP,
  speed index, and interactive are 0.8 seconds; blocking time and layout shift
  are zero; the local Worker document response is 50 ms; and the transfer is
  298 KiB. The audit found and fixed a missing main landmark, an 18px password
  visibility target, and a missing global description. Static build contracts
  now lock the landmark, 40px target, and description. Rendered 390px light
  and dark QA has no overflow or browser errors.
- A field-data Core Web Vitals trace is still outstanding because the current
  agent environment does not expose the Chrome DevTools MCP required by the
  performance-audit workflow. The built-artifact Lighthouse lab audit,
  production web bundle budgets, and browser smoke tests pass, but they are not
  substitutes for real-user field data.
- A repeated read-only production audit on 2026-08-27 found that
  `www.showpilot.tech` still serves the Worker version created on 2026-06-12
  without the download center. `/downloads`, `/downloads/manifest.json`, and
  both updater endpoints currently return the old landing HTML instead of
  their release responses, and the production release smoke fails on all five
  required download markers. The `showpilot-downloads` R2 bucket still does
  not exist. Do not create the bucket or deploy this branch without fresh
  authorization. After approval, create the private bucket first; the pipeline
  will then deploy and prove the new `www` surface. Signed/notarized installers
  and reviewed store listings remain separate publication gates before their
  buttons can activate.
- GitHub currently has the updater private-key secret but not the required
  Apple signing/notarization or Windows code-signing secrets. Do not create a
  native release tag until those credentials are configured; the hardened
  workflows intentionally fail instead of producing untrusted installers.
- Native push delivery still needs the approved EAS owner/project link,
  platform credentials, and a signed internal build. Apple distribution also
  waits on the owner's developer enrollment. Those external actions are not
  authorized or complete.
- Native simulator tooling had retained a stale workspace under
  `/private/tmp/showpilot-react-native-mobile`. The repository now owns
  `.xcodebuildmcp/config.yaml` with a relative path to the active checkout's
  `apps/mobile/ios/ShowPilot.xcworkspace`, the `ShowPilot` scheme, bundle ID,
  and a portable iPhone 17 Pro selector. The latest CLI resolved that config
  and found the correct scheme. CocoaPods are installed locally in the active
  worktree; those generated files stay ignored. No simulator was booted on
  2026-08-27. A clean generic-simulator Release build reached Xcode's
  destination check but could not compile because Xcode 26.6 selected the iOS
  26.5 SDK while this Mac only has the iOS 26.3 simulator runtime. Xcode
  explicitly requires the iOS 26.5 platform from Settings > Components; that
  multi-gigabyte download still needs owner authorization before iOS runtime
  automation can proceed.
- A real Android Gradle 8.14.3/JDK 21 build now proves both Debug and Release
  compile against SDK 36. Release lint and Hermes bundling pass. Artifact
  inspection found and removed the unused `SYSTEM_ALERT_WINDOW` permission via
  Expo `android.blockedPermissions`; the mobile verifier now locks that rule.
  The rebuilt release manifest also excludes camera, microphone, broad storage,
  development-launcher entries, cleartext networking, and debug flags. Its JS
  bundle contains `https://showpilot.tech` and no private-LAN API host. The
  React Native runtime retains its generic Metro fallback string
  (`http://localhost:8081`), but the application API target is the production
  origin. The exact `:app:bundleRelease` task used for Google Play also passes:
  its 76,513,919-byte AAB has SHA-256
  `bd0ff5b700e0e53f7818ad5783facbf9141e61eb0bcf07686faa839668d7223c`,
  and `jarsigner` verifies every entry. The local APK and AAB are intentionally
  debug-signed and are not distributable; EAS must inject the approved remote
  release keystore before review or upload.
  Mobile verification remains green with Expo Doctor 18/18 and iOS/Android
  Hermes bundles of 5,907,724 and 5,908,357 bytes on the latest pass.
- Real Android native runtime QA also passes on an Android 14 arm64 emulator
  using the repository's SDK 54 development client and the local Workers API.
  The QA account signed in; Home, Shows, Operate, Inbox, Profile, and Settings
  rendered; Settings scrolled completely; light/dark selection and the session
  survived a force-stop and relaunch. A real browser added a rundown item and
  started its timer while the native show detail was open: the item, live state,
  and countdown arrived immediately over the relay. Native Pause and `+30 sec`
  then appeared on the web as `Paused` at `0:11`, proving commands synchronize
  in both directions and time can extend beyond the assigned duration. The test
  stopped the rundown and deleted the item through the web UI; Android received
  that deletion live and returned to zero items with Start disabled. The earlier
  one-item list/detail discrepancy was an out-of-band local QA fixture written
  after a deliberate relay clear, not a failure of the normal product path.
- Follow-up Android product QA proves display-name and profile-photo saving,
  sign-out/sign-in, workspace selection, and persistent native chat. A test
  message rehydrated after a full force-stop and relaunch, then a web operator
  deleted it and Android received the deletion live. The QA display name and
  original avatar were restored afterward. This run exposed a root navigation
  race: if Android's photo editor reclaimed the app while a session check was
  temporarily unreachable, a valid stored cookie could be sent to Sign In.
  The root navigator now owns authenticated route protection, waits during
  session resolution, and shows a retryable connection state instead of
  treating network failure as logout. A forced emulator network outage proved
  the recovery screen, and restoring the network plus Retry returned directly
  to the authenticated Home screen. The verifier locks these route guards and
  recovery UI; authenticated and unauthenticated navigation both passed on the
  native runtime.
- Schedule invitations now reach the matching signed-in organization member's
  durable inbox and best-effort push channel independently of email. Recipient
  lookup is tenant-scoped and case-normalized; explicit reminders replace the
  prior actionable invite with a stable event ID, reset it unread, and cannot
  spam duplicates on retries. Reassignment removes the prior assignee's stale
  invite, while deleting an assignment atomically removes its notification.
  Real web-to-Android QA created a future service with a custom 3:30 PM call,
  resent its invitation while local email was unconfigured, and observed the
  native unread badge, assignment-specific Inbox card, service/date/call-time
  copy, read transition, and deep link to the highlighted September 30
  assignment. A second resend retained exactly one row with the same ID and
  reset it unread. The assignment, notification, show, and temporary crew
  record were then removed through the real UI, local D1 confirmed all four
  were gone, and a cold native relaunch returned to zero unread alerts.
- The complete local release gate was rerun at `ff94d23`: native release
  contracts and all seven verifier tests pass; Bridge TypeScript and all 29
  engine tests pass; Desktop and Bridge Rust formatting plus all 18 native
  tests pass; the landing Worker passes type generation, TypeScript, 22 tests,
  build, dry-run deploy, and a fresh local release smoke; and the mobile
  verifier passes all exports, 18/18 Expo Doctor checks, lint, TypeScript, API
  contracts, route guards, and bundle budgets. The production landing smoke
  still fails because the reviewed download Worker has not been deployed.
  `verify:release` still stops at the intentionally missing approved EAS
  project ID; EAS is logged out and `owner`, `extra.eas.projectId`, and the
  update URL remain unset.
- Crew edit, remove, and search-clear icon buttons now expose explicit names
  and tooltips instead of appearing as blank controls to assistive technology.
  Rendered QA originally exposed the two anonymous actions; component tests
  now lock all three accessible names for future icon changes.
- A repository-wide TypeScript AST check now rejects unnamed native icon
  buttons during every production web build. The first complete scan found and
  fixed close, clear, previous/next, delete, edit, organization switcher,
  boolean toggle, photo, copy, stream-key visibility, lower-third position,
  and loading-state controls across twenty web files. Four direct checker tests
  distinguish guaranteed dynamic fallback text from labels that can disappear.
  Rendered QA exposed `Copy overlay URL` and `Close guest crew invite` by those
  names in the browser accessibility tree. The full web test suite, TypeScript,
  and production build pass after the audit.
- The same tested AST tool now scans React Native `Pressable`,
  `TouchableHighlight`, and `TouchableOpacity` controls during the ordinary
  mobile release gate. It accepts visible `Text` content or an explicit native
  accessibility label and rejects icon-only actions with neither. The complete
  current mobile source passes. A fresh SDK 54 verification exported iOS,
  Android, and web, passed native TypeScript and lint, reported Expo Doctor
  18/18, and measured 5,907,725-byte iOS and 5,908,354-byte Android Hermes
  bundles against the 6.5 MB ceiling.
- App-store account deletion is implemented end to end without risking tenant
  data. Web and native Settings link to the public `/delete-account` resource;
  signed-out users return there after login, and Better Auth sends a 24-hour
  confirmation link before deletion. A final server-owned policy blocks the
  last owner of any workspace and links them to Team management to transfer
  ownership first. Confirmed deletion removes auth data, avatar storage,
  personal push registrations and notifications, incident comments,
  reactions, native chat messages and files, chat votes and reactions, and
  device chat-read state. It preserves workspace-issued invitations and
  capability grants by assigning their audit ownership to a remaining owner.
  Migration `0033_chat_user_room_index.sql` records every authenticated native
  chat room so deletion can find direct-message Durable Objects even after a
  user leaves a workspace. The internal deletion endpoint requires the Worker
  auth secret and cannot be invoked through the ordinary chat proxy. Direct
  policy and chat-scrubbing tests pass, and rendered QA proved the real QA
  account is blocked as the last owner without sending a deletion email or
  mutating the account. A fresh temporary D1 applied all 33 migrations, then a
  second run proved the complete sequence is idempotent.
- Public `/support` and `/account-deleted` resources now provide the store
  support URL and deletion completion state. The privacy policy and native
  Settings link to the direct deletion resource. Founder/legal review of the
  privacy-policy template, legal entity, province, and retention periods is
  still an external publication gate.
- `apps/mobile/store.config.json` now holds versioned Apple metadata for the
  en-US listing: reviewed field lengths, Business/Productivity categories,
  least-restrictive age-rating answers, public support/privacy/deletion URLs,
  and manual release after approval. The adjacent `store/` package contains
  Google Play copy, exact iPhone/iPad/Android screenshot dimensions and a
  six-shot capture story, the privacy/Data Safety worksheet, and a publication
  gate checklist. The ordinary mobile verifier now fails on over-length store
  copy, missing public resources, broken privacy choices, automatic release,
  or missing store documents. Copyright owner, review contact, production demo
  credentials, final privacy declarations, accessibility labels, and signed
  screenshots remain owner/account-controlled gates and are intentionally not
  fabricated or committed.
- The current full web gate passes 81 test files and 687 unit tests, five
  control-boundary tests, one Workers-runtime test, TypeScript, and the
  production build. The main client bundle is 497,800 bytes raw and 156,429
  bytes gzip. The mobile gate passes TypeScript, lint, all-platform export,
  Expo Doctor 18/18, and release contracts; iOS and Android Hermes bundles are
  6,184,980 and 6,185,735 bytes. EAS linkage and signed-device push remain
  external gates.
- Native Checklist is now a complete mobile vertical slice. The Worker exposes
  tenant- and show-scoped reads, atomic idempotent adds, authenticated
  completion attribution, service-only removal, department retagging, and
  server-regenerated smart rundown suggestions. The responsive native screen
  includes dated service navigation, grouped progress, add and retag controls,
  optimistic completion, pull-to-refresh, review-before-apply smart generation,
  view-only RBAC, accessible controls, and notification deep links. Seven
  focused API tests cover scoping, server-derived service dates, completion,
  retag/removal semantics, duplicate convergence, invented smart suggestions,
  and write denial. No migration is required.
- `apps/mobile/parity.config.json` is the machine-checked definition of primary
  web-to-native product parity. The mobile verifier derives all 20 source
  surfaces from the production web Sidebar and rejects missing, reordered, or
  unsupported inventory claims. At this checkpoint Checklist, Check-in, and
  Team, and Incidents are complete; Show, Schedule, Rundown, Chat, and Devices
  are partial; the remaining 11 primary surfaces are explicitly recorded as
  missing. Profile, Settings, authentication, organization selection, and Inbox
  are supporting mobile surfaces outside that primary-nav inventory. Do not describe the React Native
  product as full web parity until the manifest is green with all 20 complete.
- The new Checklist screen has passed static, contract, TypeScript, lint, export,
  bundle-budget, and full server tests. Rendered iOS Checklist QA has not yet
  run: every installed iOS 26.3 simulator was shut down on 2026-08-27, and the
  simulator workflow correctly did not boot one without owner direction. Treat
  physical-device and rendered simulator verification as an outstanding gate.
- Native Check-in now matches the authenticated web operator workflow with
  member-ID lookup, searchable roster browsing, live in/out counts, photos,
  explicit check-in/check-out confirmation, pull-to-refresh, 15-second
  convergence polling, RBAC navigation, and direct notification routing. Its
  server write accepts the desired final status instead of toggling stale client
  state, so concurrent operators and safe retries converge. Every query and
  update is organization-scoped. Five API tests prove tenant isolation,
  idempotent retry behavior, foreign-member rejection, required target state,
  and permission enforcement. No migration is required. Rendered device QA is
  still outstanding alongside the Checklist screen.
- Native Team is now complete across three role-aware surfaces. Organization
  membership supports email invitations, shareable invite links, pending-invite
  cancellation, base-role changes, and member removal. Every Better Auth command
  carries the organization ID explicitly; the web role update now does too, so
  neither platform can silently fall back to a different session-active tenant.
  The production crew roster supports search, badge IDs, names, roles including
  custom roles, assignment emails, compressed photos, checked-in visibility,
  and tenant-scoped add/edit/remove. The access screen lets Owners and Admins
  issue weekly or ongoing capability bundles while the on-duty Tech Manager can
  issue and revoke only grants in the current venue duty week. Grant creation is
  one conditional D1 insert and revoke is one conditional D1 update, so
  simultaneous operators cannot create a duplicate active grant or duplicate
  its notification. Bootstrap reuses its resolved role and venue date when
  calculating authority. Nineteen focused Team transport tests plus the shared
  service and authority tests cover tenancy, RBAC, normalization, concurrency,
  and the no-extra-query contract. The parity manifest now records Team as the
  third complete primary surface; six are partial and 11 remain missing. No
  migration is required.
- Native Incidents now supports reporting, editing, deletion, self-claim,
  responder assignment and unassignment, acknowledgement by the assigned
  operator, resolution attribution, live/open/resolved filtering, and searchable
  history. The responder picker is derived from same-organization base roles and
  active temporary incident grants; the server remains the authority. Assignment
  notifies the selected responder directly. Commands use tenant-scoped optimistic
  updates, repeated commands are idempotent, and stale concurrent changes return
  a conflict instead of overwriting another operator. Threaded updates and
  replies, five reaction types, direct participant notifications, and resolution
  notes now share the web data. Comment request IDs and explicit desired reaction
  state make network retries converge without duplicate content or alerts. A
  separate full-history screen searches every record with status, severity,
  category, assignee, date-range, sort, and paginated filters. Twenty-six
  request-level tests cover tenant isolation, effective responder access,
  permissions, idempotency, concurrent writes, discussion scoping, filters,
  edits, deletion, and notification suppression. Incidents is now the fourth
  complete primary native surface; five are partial and 11 remain missing.
  No migration is required. The exported route and authentication boundary were
  rendered locally at a 390x844 viewport without console errors; the protected
  Incident screens correctly redirected to sign-in because no reusable local QA
  credentials were available. Authenticated rendered-device QA remains open.
- The native `accessAuthority` bootstrap field is intentionally optional at the
  client boundary. A new app can still use the current production Worker before
  the Team endpoint deploys, while old app builds ignore the additive field
  after deployment. The mobile verifier locks this rolling-release contract.
- Before deploying this launch candidate, apply migrations 0030 through 0033
  in order through the protected migration workflow. Then perform signed-device
  push, profile upload, organization switching, chat, Bridge control, and
  multi-operator rundown tests.
- The production migration procedure now captures a D1 Time Travel bookmark,
  runs migration-specific read-only preflights and postconditions, and records
  a filename only after its schema objects exist. A reusable manifest check
  rejects skipped, duplicated, unknown, or out-of-order entries and is the
  deploy gate. On 2026-08-27, production had zero endpoint/organization push
  duplicates, zero checklist duplicates, and no foreign-key violations. Of the
  six audited schema objects, only the old `push_subscription_endpoint_key` was
  present. All audit queries wrote zero rows. Rerun them immediately before an
  authorized migration; never trigger the destructive Time Travel restore
  without a separate owner decision because it discards later writes.
- Existing web, Desktop `0.1.0`, Desktop `0.1.1`, and Bridge `0.1.7` clients
  remain compatible with the current production protocol. Older Desktop builds
  do not have the new native updater, notification, or local-device controls.
