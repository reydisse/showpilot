# ShowPilot Mobile

The native iOS and Android client for ShowPilot. It uses one Expo React Native codebase and connects to the same Better Auth organization, RBAC rules, D1 data, Durable Object rundown relay, and notification pipeline as the web and desktop products.

## Native coverage

- Email/password authentication and organization switching
- Recoverable network errors plus foreground/reconnect refresh
- Command center, upcoming shows, and permission-aware live rundown controls
- Multi-operator timer synchronization with reconnect and queued commands
- Crew schedule, custom call times, and assignment accept/decline responses
- Venue-timezone service labels for remote operators
- Production and planning chat rooms plus direct-message routing
- Incident reporting plus permission-checked ATEM and X32/WING control through the venue Bridge
- Scrollable inbox with destination-aware notification and push navigation
- Profile name, profile photo, workspace, sign-out, and push settings

The app is an Expo managed project. `ios/`, `android/`, build output, generated assets, and local signing material are intentionally ignored and must be regenerated from `app.json` and the package manifest.

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

That command checks native screen/API contracts, TypeScript, lint, iOS/Android/web bundles, and Expo Doctor. For local native compilation, use Android Studio's bundled JDK for Gradle and install the iOS platform version required by the active Xcode release.

Device hosts, ports, and credentials remain in the organization database. The native app receives an allowlisted action contract only; the Worker resolves trusted settings and dispatches each confirmed command to the venue Bridge.

An Android Gradle `release` build created from the generated local project uses the development debug key and is suitable only for internal sideload testing. Store distribution must use EAS or another protected production keystore.

Native push tokens require an EAS project ID and platform credentials. Link the project with EAS before creating signed test builds; do not put signing credentials or notification keys in this repository. The multitenant push-subscription migration must be applied before deploying the mobile Worker endpoints.

## Signed-build launch gate

Complete these steps only from the reviewed release branch and only after the relevant account and production approvals are available:

1. Link `tech.showpilot.mobile` to the correct ShowPilot EAS project so `extra.eas.projectId` is written to the app config.
2. Configure APNs and FCM v1 credentials in EAS, then create an internal development build for each platform.
3. Apply migrations `0030_multitenant_push_subscriptions.sql` and `0031_expo_push_receipts.sql` through the protected production migration workflow before deploying the matching Worker endpoints.
4. On signed physical devices, verify sign-in, workspace switching, profile-photo upload, push receipt delivery, notification routing, chat history, schedule-response expiry, Bridge controls, and simultaneous rundown/timer operation.
5. Create production builds with the `production` EAS profile. Build numbers are managed remotely and auto-incremented; the user-facing version remains in `app.json`.

The committed store icon is an opaque 1024x1024 PNG. The Android adaptive foreground is maintained separately with transparency. Camera and microphone permissions are explicitly blocked because profile photos are selected from the media library rather than captured or recorded inside ShowPilot.
