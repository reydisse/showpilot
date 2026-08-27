# ShowPilot Mobile

The native iOS and Android client for ShowPilot. It uses one Expo React Native codebase and connects to the same Better Auth organization, RBAC rules, D1 data, Durable Object rundown relay, and notification pipeline as the web and desktop products.

## Native coverage

- Email/password authentication, verification recovery, first-workspace
  creation, and organization switching
- Recoverable network errors plus foreground/reconnect refresh
- Platform-correct authenticated HTTP and WebSocket transport on native and Expo web
- Command center, upcoming shows, and permission-aware live rundown controls
- Multi-operator timer synchronization with reconnect and queued commands
- Crew schedule, custom call times, and assignment accept/decline responses
- Venue-timezone service labels for remote operators
- Production and planning chat rooms plus direct-message routing
- Incident reporting plus permission-checked ATEM and X32/WING control through the venue Bridge
- Scrollable, refreshable inbox with exact unread badges and destination-aware
  notification routing across workspaces
- Profile name, profile photo, workspace, and sign-out
- Persisted system/light/dark appearance plus device notification permission,
  password recovery, legal, and connection diagnostics in native settings
- One shared foreground bootstrap poll, virtualized memoized chat rows, and
  reconnect/focus refresh without duplicate per-tab timers

Native-only notification and haptic modules are not evaluated by the web
target. Browser authentication uses credentialed cookies, while iOS and Android
keep session cookies in SecureStore and attach them to native requests.

The app is an Expo managed project. `ios/`, `android/`, build output, generated
assets, and local signing material are intentionally ignored and must be
regenerated from `app.json` and the package manifest. SDK 54-compatible
`expo-dev-client` and `expo-updates` modules are committed so internal builds
can exercise native push and production builds can receive only compatible
`appVersion` updates.

## Local development

From the repository root:

```bash
pnpm install
pnpm --filter @showpilot/mobile start
```

The production API defaults to `https://showpilot.tech`. Set `EXPO_PUBLIC_SHOWPILOT_URL` to use another backend.

## Verification

```bash
pnpm --filter @showpilot/mobile verify
```

That command checks native screen/API contracts, TypeScript, lint,
iOS/Android/web bundles, native bundle-size ceilings, and Expo Doctor. Mobile
icons must use direct `lucide-react-native/icons/*` imports; the verifier rejects
the package barrel because it pulls the complete icon catalog into Metro. Both
Hermes bundles must remain at or below 6.5 MB unless a reviewed feature and a
new artifact measurement justify changing that budget. For local native
compilation, use Android Studio's bundled JDK for Gradle and install the iOS
platform version required by the active Xcode release. On macOS, keep Android
worktrees outside `/tmp`: its `/private/tmp` alias can give Android Gradle Plugin
prefab metadata two paths for the same Worklets artifact and break a clean
Reanimated link.

The normal verifier allows the intentionally unlinked local state. The signed-
release gate requires the approved Expo owner, EAS project ID and matching
update URL, then authenticates with Expo to validate both workflow schemas:

```bash
pnpm --filter @showpilot/mobile verify:release
```

Device hosts, ports, and credentials remain in the organization database. The native app receives an allowlisted action contract only; the Worker resolves trusted settings and dispatches each confirmed command to the venue Bridge.

An Android Gradle `release` build created from the generated local project uses the development debug key and is suitable only for internal sideload testing. Store distribution must use EAS or another protected production keystore.

Native push tokens require an EAS project ID and platform credentials. Link the
project with EAS before creating signed test builds; do not put signing
credentials or notification keys in this repository. The multitenant push-
subscription migration must be applied before deploying the mobile Worker
endpoints.

## Signed-build launch gate

Complete these steps only from the reviewed release branch and only after the relevant account and production approvals are available:

1. From `apps/mobile`, authenticate the approved Expo account with
   `pnpm dlx eas-cli@22.4.0 login`, then run
   `pnpm dlx eas-cli@22.4.0 init`. Link the existing ShowPilot project if one
   exists; do not create a duplicate. Commit the resulting `owner` and
   `extra.eas.projectId` only after checking the account and project name.
2. Run `pnpm dlx eas-cli@22.4.0 update:configure`. The committed update URL
   must be exactly `https://u.expo.dev/<projectId>`; the runtime policy remains
   `appVersion` and the build channels remain development, preview, and
   production.
3. In each EAS environment, set the non-secret
   `EXPO_PUBLIC_SHOWPILOT_URL=https://showpilot.tech`. Configure APNs, FCM v1,
   iOS distribution, and Android production-keystore credentials through EAS.
4. Initialize EAS remote build numbers from any existing store versions, then
   run `pnpm dlx eas-cli@22.4.0 workflow:run
   .eas/workflows/create-internal-builds.yml --wait`. This workflow is manual
   and produces signed preview builds for both platforms.
5. Apply migrations `0030_multitenant_push_subscriptions.sql` through
   `0034_better_auth_account_issuer.sql`, in order, through the protected
   production migration workflow before deploying the matching Worker and
   authentication endpoints.
6. On signed physical devices, verify sign-in, workspace switching, profile-
   photo upload, push receipt delivery, notification routing, chat history,
   schedule-response expiry, Bridge controls, and simultaneous rundown/timer
   operation.
7. Run `pnpm --filter @showpilot/mobile verify:release`, then run the manual
   `.eas/workflows/create-production-builds.yml` workflow. Build numbers are
   managed remotely and auto-incremented; the user-facing version remains in
   `app.json`.
8. Review the signed `.aab` and iOS archive before any store submission. The
   production workflow deliberately builds only; it never submits or publishes
   automatically.

The committed store icon is an opaque 1024x1024 PNG. The Android adaptive
foreground is maintained separately with transparency. Camera, microphone,
draw-over-other-apps, and legacy broad-storage permissions are explicitly
blocked. Profile photos use the platform system picker, which selects one image
without requesting gallery-wide access.
