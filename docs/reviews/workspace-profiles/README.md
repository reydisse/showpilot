# Workspace profiles review

Implemented from `SPEC-workspace-profiles.md` on `feature/workspace-profiles`.

## Behavior

- Five workspace types share one vocabulary, module registry, route map, and resolver across web and mobile.
- Onboarding saves an explicit type before role and template selection. Custom workspaces can choose names and features; Setup Later uses neutral custom defaults with every feature available.
- Settings supports type changes, optional preset resets, protected core features, and custom names. Members can view it; owners/admins can edit. No content is deleted.
- Existing installed mobile apps still receive only `general` or `church`. Old `general` provider saves preserve non-church types and never change modules.
- New mobile clients use the cached bootstrap profile, hide disabled tools and Chats, and show an Enable/Ask an admin screen for disabled deep links.
- All workspace writes use the same validated command implementation. Reserved workspace keys cannot bypass it through generic settings. D1 batches and Prisma transactions keep type and legacy wording synchronized.
- Platform administration can filter organizations by type using one settings query. Landing copy includes live events, schools, theatres, and churches; pricing is unchanged.

## Verification

- Web unit tests, migration/client-boundary checks, and Worker/D1 integration tests pass.
- Web, mobile, and shared TypeScript checks pass.
- Production web build passes client/server import protection and bundle budgets.
- Mobile verification exports iOS, Android, and web, checks Hermes budgets and polling boundaries, and runs Expo Doctor.
- Landing verification includes tests, typecheck, build, and deployment dry-run.
- Local browser review used a new isolated test account and workspace. All five web picker → role → template paths were checked at 1440 px and 390 px. The custom template was seeded and the wizard completed.
- Settings was checked with an owner and a member. The member saw disabled controls and no mutation actions. Owner role was restored after the check.
- The rendered Expo web client was checked against the local API: Theatre defaults hide Stream/Multi-platform/Lower Thirds; disabling Chat removes its shortcut and tab; direct Chat navigation renders ModuleOffView; Enable restores access. Mobile changes appear on web after reload.
- Physical iOS device testing, production smoke checks, realtime timing measurement, and a new TestFlight submission belong to the release step below. Mobile screenshots in this review are the Expo web renderer, not an iPhone simulator.

## Merge sign-off and release

Section 2 of the supplied spec says **“confirm before merge”** for the fallback: an organization with neither an explicit workspace type nor a legacy terminology setting will now resolve to Church, so Schedule calls its events “services” instead of “shows.” This is implemented and covered by tests; approval remains outstanding.

After sign-off: merge, wait for CI and the server deployment, smoke-test login and existing organizations first, then the five new types, feature toggles, token-based displays/overlays, the installed mobile binary, and realtime propagation. Deploy the landing copy separately. Only then bump the mobile version/build, run the store build, perform the native checks from §11, and submit to TestFlight. OTA remains disabled; older binaries continue to work and show all features.

Lower-third verse/sermon templates are not currently filtered by workspace type. They remain available as the spec explicitly permits; the default presenter/event preview data is type-aware. Device modules, permissions/plan tables, schema, migrations, and pricing were not changed.

The pre-existing landing concept changes, dependency changes, and lockfile edits are excluded from this branch’s commits.

## Screenshots

| Flow | Desktop | Phone width |
|---|---|---|
| Church templates | [Desktop](screenshots/church-templates-desktop.png) | [Phone](screenshots/church-templates-phone.png) |
| Live Events templates | [Desktop](screenshots/live_events-templates-desktop.png) | [Phone](screenshots/live_events-templates-phone.png) |
| School templates | [Desktop](screenshots/school-templates-desktop.png) | [Phone](screenshots/school-templates-phone.png) |
| Theatre templates | [Desktop](screenshots/theatre-templates-desktop.png) | [Phone](screenshots/theatre-templates-phone.png) |
| Custom templates | [Desktop](screenshots/custom-templates-desktop.png) | [Phone](screenshots/custom-templates-phone.png) |
| Custom settings | [Desktop](screenshots/settings-custom-desktop.png) | [Phone](screenshots/settings-custom-phone.png) |

[Custom picker](screenshots/custom-picker-phone.png) · [Theatre sidebar](screenshots/theatre-sidebar.png) · [Read-only settings](screenshots/settings-read-only.png) · [Disabled module](screenshots/module-off.png) · [Mobile settings](screenshots/mobile-settings.png) · [Mobile operations](screenshots/mobile-theatre-operations.png) · [Mobile disabled destination](screenshots/mobile-module-off.png)

[Complete before → after copy tables](copy-review.md)
