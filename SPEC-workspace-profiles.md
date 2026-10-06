# SHOWPILOT-WORKSPACE-PROFILES-SPEC.md
## De-church ShowPilot: workspace types at onboarding

**Branch:** `feature/workspace-profiles`
**Verified against:** `main` @ `49df4df` (2026-10-05)
**Builds on:** `SHOWPILOT-ONBOARDING-SPEC.md` (5-scene wizard — shipped), the existing `terminology-profile` setting in `src/lib/org-terminology.ts`

---

## 0. Why, and the one rule

Beta feedback: ShowPilot reads as church-only. The engine is neutral — the church feel is **copy, seeded templates, and which nav items are front and centre**.

**The rule:** one product, one codebase. All type-specific behaviour lives in `packages/shared/src/workspace/` (data and resolvers) and `apps/web/src/lib/workspace/` (templates, archetypes, persistence) as plain data. If you write `if (type === "theatre")` anywhere else, stop and move it into config.

### Non-goals (push back if they creep in)
- **Film / video production type** — different workflow (call sheets, shot lists). Not this release.
- Full i18n. This is a terminology map, not translation.
- Renaming code identifiers, routes, DB columns or API fields (`serviceDate`, `ServiceAssignment`, `service-phase.ts`, `/show`, etc. all stay).
- Permission / RBAC changes. Module gating is UX layered **on top of** permissions, never instead of them.
- Plan limits or pricing per type.
- `src/lib/device-modules/` — hands off, including its copy.
- Editing custom term overrides on mobile (web Settings only; mobile reads and displays them).

---

## 1. What already exists (verified — build on it, don't duplicate)

| Thing | Where | Implication |
|---|---|---|
| Terminology profile `general \| church` | `src/lib/org-terminology.ts`, stored in `app_setting` key `terminology-profile`, default `general` | **Extend this.** Don't build a parallel system. |
| Terminology readers | `schedule.ts`, `crew-schedule.ts`, `email.ts`, `routes/$slug/schedule.tsx`, `routes/crew/schedule/$token.tsx`, `mobile-api.server.ts` | All must read the new resolver. |
| Terminology toggle in Schedule provider settings | web `schedule.tsx`, mobile `schedule-sheets.tsx` | Becomes read-only + link to Settings → Workspace on web. Mobile keeps working (§7). |
| Mobile API contract | `apps/mobile/src/lib/mobile-api.ts:271` — `z.enum(["general","church"])` **strict** | **Shipped mobile clients will crash parsing any new value.** Legacy field must keep emitting only `general`/`church`. |
| Onboarding wizard | `routes/_auth/setup.tsx`, `lib/onboarding.ts`, `lib/onboarding-flow.ts`, `lib/templates.ts` | Insert a new scene; make Scene 2 archetypes and Scene 3 templates type-aware. |
| Onboarding checkpoints | `app_setting` keys via `upsertOrgSetting` | Store workspace data the same way. **No schema migration needed.** |
| Nav | `components/layout/Sidebar.tsx` — `NavItem` array with `permission` + `canOpen()` | Add an optional `module` field and filter on it alongside permissions. |
| Static roles incl. `td`/`cd`/`pd` | `permissions.ts` `ASSIGNABLE_ROLES` | Untouched. |
| Church copy | ~210 candidate string literals across ~50 files (grep in §6) | The real work. |
| Shared package | `packages/shared` (`@showpilot/shared`), already imported by web and mobile, guarded by `shared-export-contract.test.ts` | Pure workspace config lives here so web and mobile can't drift. |
| Mobile app | `apps/mobile`, Expo 54 / expo-router. Features gated by permission in `app/(app)/operations.tsx`. Bootstrap from `/api/mobile/v1/bootstrap`. Orgs created directly via `authClient.organization.create` in `app/organizations.tsx`, which bypasses the web wizard. **OTA updates are disabled** (`app.json` `updates.enabled: false`, runtimeVersion = appVersion). | Mobile changes need a store build, and old binaries will stay in the field. Server must stay backward compatible indefinitely. Mobile-created orgs need their own type picker. |

---

## 2. Storage — `app_setting` keys, no migration

Follows the existing `terminology-profile` and onboarding-checkpoint pattern. No Prisma schema change, no numbered migration.

| Key | Value | Missing means |
|---|---|---|
| `workspace-type` | `church \| live_events \| school \| theatre \| custom` | Fall back (see resolution below) |
| `workspace-modules` | JSON array of module ids | **All modules enabled** (= today's behaviour) |
| `workspace-custom` | JSON `{ label: string, terms: { event?, events?, item?, items? } }` | No custom label/overrides |
| `terminology-profile` | legacy `general \| church` | Kept in sync on every write (see below) |

### Type resolution (single function, `resolveWorkspaceType(settings)`)
1. `workspace-type` if present and valid
2. else legacy `terminology-profile`: `church` → `church`, `general` → `live_events`
3. else → `church`

> ⚠️ **Behaviour change to sign off on:** today an org with **no** `terminology-profile` key sees "show" wording in Schedule (default `general`). Under step 3 it becomes "service". Every current beta org is a church, so this is the right default for them — but confirm before merge. New orgs always get an explicit `workspace-type` from onboarding, so the fallback only affects legacy orgs.

### Legacy key sync
Every write of `workspace-type` also writes `terminology-profile` = `church` if type is `church`, else `general`. This keeps anything still reading the old key — including shipped mobile clients — correct. Remove the sync after the mobile app adopts `workspaceType` (follow-up, not this spec).

---

## 3. Config — split between `packages/shared` and `apps/web/src/lib/workspace/`

Pure data and resolvers go in the shared package, so web and mobile use one source of truth:

```
packages/shared/src/workspace/
  types.ts        WorkspaceType, ModuleId, TermKey, zod schemas (WORKSPACE_TYPES, MODULE_IDS)
  modules.ts      module registry + per-type defaults + CORE_MODULES
  surfaces.ts     MODULE_SURFACES — web sidebar paths + mobile screens per module (§7.2)
  terms.ts        term map per type (supersedes org-terminology.ts internals)
  resolve.ts      resolveWorkspaceType, resolveModules, resolveTerms, legacyTerminologyProfile
  index.ts        re-exported from packages/shared/src/index.ts
```

`packages/shared` has **no zod dependency** — don't add one. Export plain `as const` arrays, types and type guards (`isWorkspaceType`, `isModuleId`); each app builds its own zod schemas from those arrays. Add every new export to `shared-export-contract.test.ts`.

Web-only pieces stay in the app:

```
apps/web/src/lib/workspace/
  templates.ts    onboarding templates grouped by type (moved from lib/templates.ts)
  archetypes.ts   Scene 2 archetype labels per type
  profile.server.ts  core read/write logic, used by BOTH server fns and mobile API handlers
  profile.ts      server fns (§5), thin wrappers over profile.server.ts
  index.ts
```

Keep `src/lib/org-terminology.ts` as a thin compat shim that re-exports from `@showpilot/shared` so existing imports and `org-terminology.test.ts` keep passing; migrate call sites in this PR, then delete the shim in a follow-up.

### 3.1 Modules — mapped to the real sidebar

Every `NavItem` in `Sidebar.tsx` gets a `module: ModuleId`. Core modules can't be turned off.

| Module id | Sidebar items | Core | church | live_events | school | theatre |
|---|---|---|---|---|---|---|
| `show` | Show | ✅ | ✅ | ✅ | ✅ | ✅ |
| `rundown` | Rundown | ✅ | ✅ | ✅ | ✅ | ✅ |
| `team` | Team | ✅ | ✅ | ✅ | ✅ | ✅ |
| `schedule` | Schedule | | ✅ | ✅ | ✅ | ✅ |
| `board` | Show Board, Crew Check-in | | ✅ | ✅ | ✅ | ✅ |
| `chat` | Chat | | ✅ | ✅ | ✅ | ✅ |
| `production` | Cue Sheets, Checklist, Incidents, Assets | | ✅ | ✅ | ✅ | ✅ |
| `timecode` | Timecode | | ✅ | ✅ | ❌ | ✅ |
| `songs` | Songs | | ✅ | ❌ | ❌ | ❌ |
| `streaming` | Stream, Multi-Platform | | ✅ | ✅ | ✅ | ❌ |
| `lower_thirds` | Lower Thirds | | ✅ | ✅ | ✅ | ❌ |
| `dashboards` | Prod Manager, Reports & Notes, Tech Manager, Audio, Devices | | ✅ | ✅ | ✅ | ✅ |

`custom` defaults to everything on; the user unticks in onboarding.

Rules:
- Settings and Admin are never modules.
- Integrations (ProPresenter, OnTime, Companion) are **not** modules — Settings always lists every integration. The bridge-first architecture is unchanged.
- `resolveModules(stored)` always re-adds core and drops unknown ids, so a stale value can never hide Show/Rundown/Team.

### 3.2 Terms

Extend the existing `orgTerms()` shape — keep every existing key with the same meaning so current call sites don't change behaviour, and add the rest. Type the map as `Record<WorkspaceType, Record<TermKey, string>>` so a missing key is a compile error.

| Key | church | live_events | school | theatre | custom default |
|---|---|---|---|---|---|
| `event` *(existing)* | service | show | event | performance | show |
| `eventTitle` *(existing)* | Service | Show | Event | Performance | Show |
| `eventPlural` | Services | Shows | Events | Performances | Shows |
| `eventName` *(existing)* | Service name | Show name | Event name | Performance name | Show name |
| `participate` *(existing)* | serve | work this show | work this event | work this performance | work this show |
| `scheduled` *(existing)* | You've been scheduled to serve | You've been assigned | You've been assigned | You've been called | You've been assigned |
| `checkinCta` | Scan to Serve | Scan to Check In | Scan to Check In | Scan to Sign In | Scan to Check In |
| `section` | Set | Block | Block | Act | Block |
| `item` | Element | Segment | Segment | Cue | Segment |
| `itemPlural` | Elements | Segments | Segments | Cues | Segments |
| `presenter` | Speaker | Presenter | Presenter | Performer | Presenter |
| `presenterExample` | Pastor James | Jordan Lee, CEO | Principal Adams | Lead — Maria | Jordan Lee |
| `sectionExample` | Worship Set | Keynote Block | Awards Block | Act 1 | Main Block |
| `eventNameExample` | Sunday Morning | Product Launch Keynote | Spring Assembly | Opening Night | Main Show |

- `custom` may override `event`/`eventTitle`/`eventPlural` and `item`/`itemPlural` only, via `workspace-custom.terms`. Validate: trimmed, 1–24 chars, plain text. Derive lowercase/uppercase variants from the override rather than asking for five fields.
- Labels only. Never written to the DB, never sent as API enum values.

### 3.3 Templates (Scene 3) — per type

Move `ONBOARDING_TEMPLATES` into `workspace/templates.ts` keyed by type. Keep the existing `OnboardingTemplate` shape, `runTemplateSeed`, `templateBadge`, and `templateRuntimeSec` — only the data grows. Widen `OnboardingTemplateId` to the full union. **Existing ids (`sunday`, `youth`, `special`, `blank`) must keep working** because `seededTemplate` is persisted per org.

- **church:** Sunday Service · Youth Night · Special Event · Start Blank — *unchanged*
- **live_events:**
  - *Corporate Keynote* — Doors & walk-in 15:00 · Opening video 2:00 · Host welcome 3:00 · Keynote 30:00 · Panel 25:00 · Q&A 10:00 · Sponsor thank-you 2:00 · Close & walkout 5:00
  - *Concert* — Doors 30:00 · Support act 30:00 · Changeover 20:00 · Headliner 75:00 · Encore 10:00 · House lights 5:00
  - *Special Event* (shared with church) · *Start Blank*
- **school:**
  - *Assembly* — Walk-in 5:00 · Welcome & announcements 5:00 · Anthem / opening 3:00 · Student performance 8:00 · Guest speaker 15:00 · Awards 10:00 · Closing remarks 3:00
  - *Graduation* — Processional 10:00 · Welcome 5:00 · Address 15:00 · Valedictorian 8:00 · Diplomas 45:00 · Recessional 8:00
  - *Start Blank*
- **theatre:**
  - *Two-Act Performance* — House open 30:00 · Pre-show announcement 2:00 · Act 1 55:00 · Intermission 15:00 · Act 2 50:00 · Curtain call 5:00 · House lights 5:00
  - *Rehearsal* — Warm-up 20:00 · Notes 15:00 · Run 90:00 · Notes 20:00
  - *Start Blank*
- **custom:** Special Event · Start Blank

Each non-blank template gets 3–5 checklist items in the existing categories. Church-only checklist items ("ProPresenter loaded") stay in church templates only. Scene 3 renders whatever the current type's list is; the card count varies and the layout must handle 2–4 cards.

### 3.4 Archetypes (Scene 2)

Keep the six archetype **ids** — `pastor` and `cd` are persisted in membership metadata, so don't rename them. Make labels and descriptions type-aware:

| id | church | live_events | school | theatre | custom |
|---|---|---|---|---|---|
| `cd` | Creative / Worship Dir. | Creative Director | Creative / Media Lead | Director / Designer | Creative Director |
| `pastor` | Pastor / Staff | Client / Producer | Teacher / Staff | Producer / Company Mgr | Leadership / Staff |

`td`, `pm`, `sm`, `op` are already neutral. Landing routes stay as-is, **except**: if an archetype's landing route belongs to a module that's disabled for the chosen type (e.g. `cd` → `/streaming/graphics` in theatre), fall back to `/show`.

---

## 4. Onboarding — new Scene 1b "What are you running?"

Inserted between Scene 1 (org created) and Scene 2 (role). Same design rules as the onboarding spec: broadcast-dark, ≤400 ms motion, skippable, reduced-motion clean, one tap advances, works one-handed on a phone.

- Headline: **"What are you running?"**
- Five large cards (lucide icon + name + one line), one tap selects and advances:
  - **Church** — Services, worship, weekend production
  - **Live Events** — Conferences, concerts, corporate shows
  - **School** — Assemblies, graduations, campus media
  - **Theatre** — Performances and cue-driven shows
  - **Custom** — Pick your own features and names
- Footnote: "You can change this anytime in Settings."
- **Custom** doesn't auto-advance; it expands inline with a name field ("What do you call your productions?" → `label`), optional term fields (one for the event noun, one for the item noun, with neutral placeholders), and a module checklist with core items locked on. Then a **Continue** button.
- From this scene on, every wizard string uses the selected type's terms immediately (resolve client-side from the selection; don't wait for the server write).

### Server + resume
- New checkpoint server fn `saveWorkspaceType` (§5) — owner-only, same guard as `markOnboardingStarted`.
- `getOnboardingProgress` returns `workspaceType: string | null` (only the explicit `workspace-type` key — not the legacy fallback, otherwise every resumed wizard would skip this scene).
- `OnboardingResumeInput` gains `hasWorkspaceType`. `deriveResumeScene`: `hasOrg && started && !hasWorkspaceType` → Scene **"1b"**, checked before the `hasRole` branch. Widen the scene union accordingly.
- `seedOrgTemplate` validates the template id against **the org's resolved type's** template list (reject a theatre template for a church org).
- PostHog: add `workspace_type_selected` (props: `type`, `moduleCount`) between `org_created` and `role_selected`. Never send the custom label text.
- First Session Checklist item copy ("open the kiosk/board view" etc.) runs through terms.

---

## 5. Server functions — `workspace/profile.ts`

House pattern exactly: `createServerFn({ method })` → `.inputValidator((d: unknown) => parseOrThrow(schema, d))` → `.handler()`, **permission check on the first line of the handler**, every query filtered by `orgId`, writes via `upsertOrgSetting`. Fail closed: unknown type or module id → validation error, no partial write. Wrap multi-key writes in one `prisma.$transaction([...])` like `schedule.ts` does.

| Fn | Who | Does |
|---|---|---|
| `getWorkspaceProfile({ orgId })` | any member | Returns `{ type, label, modules, terms, isExplicit }` fully resolved |
| `saveWorkspaceType({ orgId, type, custom?, modules? })` | owner (onboarding) | Writes `workspace-type` + legacy sync; for `custom`, writes `workspace-custom` and `workspace-modules`; for presets, writes that type's default modules |
| `setWorkspaceType({ orgId, type, resetModules })` | owner/admin (settings) | Changes type + legacy sync; touches modules **only** if `resetModules` |
| `setWorkspaceModules({ orgId, modules })` | owner/admin | Validate ids, force-include core |
| `setWorkspaceCustom({ orgId, label, terms })` | owner/admin | Only valid when type is `custom` |

Use whichever permission the existing Settings org-details form uses for owner/admin checks (`assertOrgPermission` in `settings.ts` / `app-permissions.ts`) — don't invent a new permission.

**Replace** the terminology write in `schedule.ts` `saveScheduleProvider` (the `terminology-profile` upsert) — see §7.

---

## 6. Client

### 6.1 Loading
- Resolve the profile in the `$slug` layout route loader (wherever org + membership are loaded) so it's available on SSR — no flash of church copy, no spinner.
- `WorkspaceProvider` + hooks: `useWorkspace()`, `useTerms()`, `useModuleEnabled(id)`.
- After any Settings mutation, invalidate the loader so nav and copy update immediately.

### 6.2 Sidebar and route gating
- `NavItem` gains `module: ModuleId`. `canOpen(item)` becomes `moduleEnabled(item.module) && <existing permission check>`. Section dividers (Production / Streaming / Dashboards) hide when every item in them is hidden.
- Direct URL to a disabled module: in-app empty state — "*{Module} is turned off for this workspace.*" — with an **Enable** button for owner/admin and "Ask an admin to turn it on" for others. No 404, no redirect.
- **Gating is UX, not security.** No module checks in server functions. Kiosk tokens, Companion tokens, `/overlay`, `/timer`, `/checkin/{slug}` and `/crew/schedule/{token}` must keep working regardless of module state — a booth mid-service must never go dark because someone toggled a setting.

### 6.3 Settings → Workspace (new section in `routes/$slug/settings.tsx`)
- Current type, with "Change type". The confirmation says plainly: *names change, nothing is deleted*. Checkbox "Also reset features to {type} defaults" (unchecked by default).
- Module toggles (core locked on, with a one-line explainer).
- Custom label + term overrides when type is `custom`.
- Read-only for non-admins.

### 6.4 Copy sweep — the real work
Candidate strings (run from `apps/web`):

```sh
grep -rnoiE "[\"'>\`][^\"'<{\`]*\b(services?|sunday|worship|sermon|pastor|church(es)?|congregation|sanctuary|ministry|serve|serving|youth)\b[^\"'<\`]*[\"'<\`]" src --include=*.tsx --include=*.ts \
  | grep -v __tests__ | grep -viE "service-?(date|assign|worker|_)|serviceDate|ServiceAssign|import |from \""
```

At `49df4df` this returns ~210 hits across ~50 files. The heaviest files are `pm-dashboard-derive.ts` (19), `pm-widgets.tsx` (12), `rundown.tsx` (11), `templates.ts` (11), `schedule.tsx` (10), `seed-timecode-demo.ts` (10), `crew-schedule.ts` (9), `tm-dashboard-derive.ts` (8) and `mobile-api.server.ts` (8).

For each hit, choose one:
- **Term** — user-facing label naming the event, section, item, presenter, or check-in → `terms.*`. This includes rundown placeholders such as `"e.g. Worship Set"` and `"e.g. Pastor James"`, which become `sectionExample` and `presenterExample`.
- **Neutralize** — generic copy that doesn't need a term, e.g. `"make Sunday exist"` becomes `"make your next {event} exist"`, and `"Covering rundown for Sunday service"` becomes `"Covering rundown for this weekend's {event}"`.
- **Leave** — church template data, ProPresenter-specific copy, `terms.tsx`/`privacy.tsx` legal text (review only), anything in `device-modules/`.
- **Ignore** — code identifiers, `serviceDate`, `service-phase`, and "service" meaning a backend or Worker service.

Specific calls:
- `types/index.ts` positions `"Media Pastor"`, `"Lead Pastor"` and `"Executive Pastor"` stay as recognised position strings for `getDepartment()`. Add neutral equivalents ("Executive Producer", "Show Director") so non-church crews map to Leadership too. Don't remove anything.
- `seed-timecode-demo.ts` gets a neutral live-events variant, and the demo picks the variant by type.
- `lt-templates.tsx` sermon or verse templates stay, but only for church. Check whether lower-third templates are filtered anywhere; if not, leave them and note it in the PR.
- `pm-dashboard-derive.ts` and `tm-dashboard-derive.ts` are pure derive functions, so pass `terms` in as an argument rather than calling hooks.

**The PR description must include a before → after table of every changed string.**

### 6.5 Email
`email.ts` already takes an `OrgTerminologyProfile`. Change it to take resolved `terms`, so invites and schedule emails use the full type vocabulary. Every caller resolves the org's profile first.

---

## 7. Mobile

Two halves: the **server** must stay compatible with binaries already installed (OTA is off, so they'll be around for months), and the **app** adopts workspace profiles fully in its next store build.

### 7.1 Server — backward compatibility (`apps/web/src/lib/mobile-api.server.ts`)

Shipped clients parse `terminologyProfile` with `z.enum(["general","church"])` (`apps/mobile/src/lib/mobile-api.ts:271`). Any other value fails the parse and crashes the schedule screen. Verified: the mobile schemas don't use `.strict()`, so **adding** fields is safe; changing existing ones is not.

- **Never change an existing response field's type or allowed values.** `terminologyProfile` keeps emitting only `"church"` or `"general"`, via `legacyTerminologyProfile(type)` from shared.
- **Bootstrap** (`GET /api/mobile/v1/bootstrap`) adds an optional top-level field:
  ```ts
  workspace: {
    type: WorkspaceType;
    label: string | null;      // custom label, else null
    modules: ModuleId[];       // fully resolved, core always present
    terms: Record<TermKey, string>; // fully resolved incl. custom overrides
    isExplicit: boolean;       // false when resolved from a fallback
  }
  ```
  Resolved server-side with the same `profile.server.ts` the web uses. Old clients ignore it.
- **Schedule** (`GET /api/mobile/v1/schedule`) adds `workspaceType` alongside the legacy `terminologyProfile`.
- **Legacy provider save** (`POST /api/mobile/v1/schedule/provider`) makes `terminologyProfile` **optional**: missing means leave the type alone (new clients), while `"general" | "church"` from old clients is still accepted. `"church"` sets the type to `church`. `"general"` sets it to `live_events` **only if** the current type is `church`; otherwise the type is left alone, so an old client can't flip a theatre org. This path never touches modules. New clients stop sending the field (7.2).
- **New endpoints**, registered in the same router block as the others and following the existing handler pattern (`requireOrgAccess`-style guard first, then `readJson`, then validation, then `json()`):

  | Method + path | Who | Body | Calls |
  |---|---|---|---|
  | `POST /api/mobile/v1/workspace/type` | owner/admin | `{ orgId, type, resetModules }` | `setWorkspaceType` logic |
  | `POST /api/mobile/v1/workspace/modules` | owner/admin | `{ orgId, modules }` | `setWorkspaceModules` logic |
  | `POST /api/mobile/v1/workspace/initial` | owner only, org must have **no** explicit `workspace-type` | `{ orgId, type, label? }` | `saveWorkspaceType` logic, preset modules (custom → all modules) |

  Each returns the fresh resolved `workspace` object so the app can update without a second fetch. Use the same permission as the web Settings section — no new permissions. Validate against `WORKSPACE_TYPES` / `MODULE_IDS`, fail closed.
- Web `schedule.tsx`: remove the terminology radio from the provider sheet and replace it with "Wording follows your workspace type — change in Settings → Workspace" plus a link.

### 7.2 App (`apps/mobile`)

**Schemas — `src/lib/mobile-api.ts`**
- Add `workspaceSchema` built from the shared constants and put it on the bootstrap as `workspace: workspaceSchema.optional()`.
- Make every server-owned enum lenient from now on. Change `terminologyProfile` to `z.string().catch("general")` and give `workspace.type` a `.catch("church")`; filter unknown module ids out instead of failing. The lesson from this spec is that the next server-side enum addition shouldn't need a coordinated app release.
- Add client fns `saveMobileWorkspaceType`, `saveMobileWorkspaceModules` and `saveMobileInitialWorkspace` next to the existing `saveMobileScheduleProvider`.

**State — new `src/providers/workspace-provider.tsx`**
- Read `workspace` from the bootstrap query that's already loaded. No extra request.
- If the field is missing (shouldn't happen once the server ships first, but stay defensive), build it client-side with the shared resolvers: legacy `terminologyProfile` for the type, all modules, and that type's terms.
- Expose `useWorkspace()`, `useTerms()` and `useModuleEnabled(id)`, matching the web hook names.
- After any workspace mutation, update the bootstrap cache from the response (`queryClient.setQueryData`). Don't refetch everything.

**Gating — `src/app/(app)/operations.tsx` and deep links**
- Each `FeatureLink` shows when **module enabled AND existing permission check**. Mapping, which mirrors the web sidebar:

  | Module | Mobile screens |
  |---|---|
  | `show` (core) | Live Show, `show/*`, Shows tab |
  | `rundown` (core) | rundown sheets |
  | `team` (core) | Organization members, Crew roster, Team access |
  | `schedule` | Schedule |
  | `board` | Show Board, Crew check-in |
  | `chat` | Production chat, Chats tab |
  | `production` | Cue sheets, Pre-show checklist, Incidents, Incidents history, Assets |
  | `timecode` | Timecode |
  | `streaming` | Stream health, Multi-platform |
  | `lower_thirds` | Lower thirds |
  | `dashboards` | Prod Manager, Reports & notes, Tech Manager, Audio, Devices, `device/*` |

  Put this map in **shared** (`MODULE_SURFACES` keyed by module, with `web` and `mobile` route lists), so the two clients can't disagree.
- **Chats tab:** hide it via `href: null` when `chat` is disabled, the same way `profile` is hidden today.
- **Deep links and notifications** (`notification-route.ts`, `notification-destination.ts`): if the target screen's module is disabled, open a shared `ModuleOffView` instead. It reads "{Module} is turned off for this workspace." Owners and admins get an **Enable** button that calls `saveMobileWorkspaceModules`; everyone else sees "Ask an admin to turn it on." Never crash, and never silently drop the user on Home.
- As on web, gating is UX only. Don't gate any API call on the client.

**Creating a workspace on mobile — `src/app/organizations.tsx`**
- Orgs created here skip the web wizard. Today they'd fall back to `church`.
- After `authClient.organization.create` succeeds, show a **"What are you running?"** step on the same screen: five large tappable cards with the same names, icons and one-liners as web Scene 1b, at least 44 pt tap targets, one-handed. **Custom** expands a single label field. Module picking and term overrides for custom are web-only and default to all modules on.
- Selection calls `saveMobileInitialWorkspace`. If the call fails, keep the org and show a retry. Never strand the user; the org still works on the fallback.
- On the "Create your first workspace" screen, change the placeholders `"Faithfire Church"` / `"faithfire-church"` to neutral examples (`"Northside Productions"` / `"northside-productions"`).

**Settings — `src/app/settings.tsx`**
- Add a **Workspace** section showing the type (and custom label).
- Owners and admins can change the type, with the same confirmation copy as web: *names change, nothing is deleted*, plus an unticked "Also reset features to {type} defaults". They can also toggle modules, with core modules locked.
- Members see it read-only.
- Custom term editing shows "Edit names on the web" with a link to `/{slug}/settings`.

**Schedule provider sheet — `src/components/schedule-sheets.tsx`**
- Remove the "Shows and assignments / Services and serving" radio (line ~338). Replace it with read-only text: "Wording follows your workspace type ({type label}). Change it in Settings → Workspace."
- Stop sending `terminologyProfile` from `saveMobileScheduleProvider` (the server treats a missing value as "leave the type alone" — see 7.1).

**Copy sweep — mobile**
Run the §6.4 grep in `apps/mobile/src`. At `49df4df` it returns **56 hits**. The same classification applies (Term / Neutralize / Leave / Ignore). Known ones:
- Placeholders `"Sunday Morning"`, `"Sunday Morning Service"`, `"Evening service"`, `"Sunday morning standard"` → type-appropriate examples from a new `eventNameExample` term (church keeps "Sunday Morning").
- Labels like `"Service title"`, `"Service date"`, `"Show or service name"`, `"Enter a service title."`, `SERVICE DATE`, `SERVICE PICKER`, `"next service"`, `"No upcoming service"` → `terms.eventTitle` and related terms.
- `"Scan to serve"` (`show-board.tsx`) → `terms.checkinCta`. `"Add the people who serve…"` → `terms.participate`.
- `"Advance to sermon"` (`timecode.tsx`) → neutral, e.g. "Advance to next segment".
- `"Covering rundown for Sunday service"` (`team.tsx`) uses the same neutral copy as web.
- **Leave** `"Terms of Service"` and the legal `"Service"` labels in `settings.tsx` and `sign-up.tsx`.
- The `schedule.tsx` and `schedule-sheets.tsx` `"service"`/`"services"` branches currently switch on `terminologyProfile`. Replace those branches with `terms.*` so all five types work, not just two.

**Release**
- Server ships first (§11). Old binaries keep working on the legacy field. They just won't hide modules or use the new terms.
- Then bump the app version in `app.json` and do an EAS store build. With `runtimeVersion: appVersion` and OTA off, this is a normal release.
- Don't force-upgrade old clients for this. Note in the release notes that older versions show all features.
- The legacy `terminologyProfile` sync (§2) stays until analytics show old-binary usage has dropped off. That removal is a separate change.

---

## 8. Superadmin

On the orgs list in `routes/superadmin.tsx`, add a **Type** column and filter, computed from `resolveWorkspaceType`. Use one `app_setting` query for the visible orgs, not one query per org. Keep it read-only.

## 9. Landing (`apps/landing`, separate manual deploy)

Do one copy pass on `src/index.template.html`. The hero and feature sections should speak to "live production teams", with churches named as one audience among several. Keep the church proof and testimonials, because church is still the launch beachhead. Leave `src/pricing.mjs` untouched.

---

## 10. Tests (Vitest)

Run `pnpm --filter @showpilot/web test`, `pnpm --filter @showpilot/web exec tsc --noEmit`, `pnpm --filter @showpilot/shared typecheck` and `pnpm --filter @showpilot/mobile typecheck`. The mobile app has no test runner, so its logic is covered through the shared package and the web-side mobile API tests.

- `resolve.ts` should cover all three branches of type resolution, including legacy `general` → `live_events` and missing → `church`. `resolveModules` should re-add core, drop unknown ids, and treat a missing key as all modules. `resolveTerms` should return every key for every type, and custom overrides should apply only to the allowed keys and be validated.
- Templates: every template's items sum to the advertised runtime, and every type has at least one non-blank template plus Start Blank. The existing `templates.test.ts` must keep passing unchanged for the church ids. `seedOrgTemplate` must reject a template from another type.
- `onboarding-flow`: `deriveResumeScene` returns `1b` when `hasWorkspaceType` is false, and every existing case is unchanged. Archetype landing falls back to `/show` when the target module is disabled.
- Permissions: a `member` calling any `set*` function is forbidden. Owner and admin are allowed. Only the owner can call `saveWorkspaceType`.
- orgId scoping: every new function rejects an org the caller doesn't belong to. Write these as unit tests against the permission assertion, since cross-org D1 tests are still stubbed repo-wide (a standing risk this spec doesn't fix).
- Legacy sync: writing any type keeps `terminology-profile` correct. The mobile provider-save mapping matches §7, including that a theatre org is not flipped.
- The existing `org-terminology.test.ts` and `mobile-schedule-management.test.ts` pass with no edits, or with additions only.
- Sidebar: a disabled module hides its items and empty sections. A disabled route renders the empty state, not a 404.
- Shared: `shared-export-contract.test.ts` covers the new workspace exports. `MODULE_SURFACES` lists every web sidebar path exactly once (assert against the `Sidebar.tsx` nav array) and every module id.
- Mobile API, in the existing `mobile-*.test.ts` style:
  - bootstrap includes a resolved `workspace` for explicit, legacy-only and no-key orgs;
  - `terminologyProfile` is only ever `"general"` or `"church"` for all five types — **this is the regression test that protects shipped binaries**;
  - the provider save with the field missing leaves the type unchanged;
  - `/workspace/type` and `/workspace/modules` enforce owner/admin and reject unknown values;
  - `/workspace/initial` is owner-only and refuses when an explicit type already exists.

---

## 11. Rollout

1. There's no migration. Code handles a missing key on every path.
2. Open the PR with the copy before → after table, screenshots of all five onboarding paths (dark theme, MacBook and phone widths), the Settings → Workspace section, and the theatre sidebar.
3. Merge to `main`. CI deploys.
4. Run the smoke tests in this order:
   1. **Auth path.** Roll back immediately if it fails.
   2. Faithfire and an existing beta org look the same as before. The Schedule wording change from §2 is the only allowed difference, and only if signed off.
   3. A new signup through each of the five types lands on the right templates, labels and sidebar.
   4. Toggle a module off and on in Settings.
   5. A kiosk token still loads the stage display, and `/overlay` still renders, with every optional module off.
   6. The current shipped mobile app opens the Schedule screen for a theatre org without error.
   7. Realtime propagation stays under 300 ms.
5. Do the landing copy pass and deploy it separately.
6. **Mobile build** (only after the server is live and smoke-tested):
   1. In a dev build, check Operations and tabs for a theatre org: Stream, Multi-platform, Lower thirds and Songs are hidden.
   2. Create a workspace on mobile and pick each type; the type sticks and the wording updates.
   3. Change the type and toggle modules in mobile Settings; web reflects it on next load, and the reverse holds too.
   4. Tap a push notification that targets a disabled module; `ModuleOffView` appears and doesn't crash.
   5. Bump the version, run the EAS build, and submit.

## 12. Acceptance

- [ ] Existing orgs see no visible change, apart from the signed-off Schedule wording for orgs that had no key.
- [ ] Onboarding offers five types. Templates, archetype labels, terms and modules all follow the chosen type.
- [ ] No church-specific copy appears in a non-church workspace, outside of integration screens and legal pages.
- [ ] Type, modules and custom terms can be changed in Settings with no data loss.
- [ ] Shipped mobile clients keep working (legacy `terminologyProfile` stays two-valued, guarded by a test).
- [ ] The new mobile build follows the workspace type: gated Operations and tabs, type-aware wording, a type picker when creating a workspace from mobile, and a Workspace section in Settings.
- [ ] Web and mobile read modules, terms and surfaces from `@showpilot/shared` only.
- [ ] No type branching exists outside `packages/shared/src/workspace/` and `apps/web/src/lib/workspace/`.
- [ ] Nothing changes in permissions, plan limits, `device-modules/`, the Prisma schema or migrations.
- [ ] Tests and typecheck are green.
