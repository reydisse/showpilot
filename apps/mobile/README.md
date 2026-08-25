# ShowPilot Mobile

The native iOS and Android client for ShowPilot. It uses one Expo React Native codebase and connects to the same Better Auth organization, RBAC rules, D1 data, Durable Object rundown relay, and notification pipeline as the web and desktop products.

## Native coverage

- Email/password authentication and organization switching
- Command center, upcoming shows, and permission-aware live rundown controls
- Multi-operator timer synchronization with reconnect and queued commands
- Crew schedule, custom call times, and assignment accept/decline responses
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
