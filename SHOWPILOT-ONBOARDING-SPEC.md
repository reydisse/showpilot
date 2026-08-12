# SHOWPILOT-ONBOARDING-SPEC.md
## "First show in 5 minutes" — cinematic onboarding
*Supersedes Task 3.1 in SHOWPILOT-LAUNCH-SPEC.md. Tasks 3.2–3.4 (empty states, email verification, CSV import) are unchanged. Execute after Phase 2 (billing) — the wizard sets the 14-day trial per Task 2.6.*

---

## DESIGN INTENT (read before coding)

ShowPilot's users run live shows. Onboarding should feel like a **pre-show countdown going to air**, not a SaaS form. Tone: broadcast-dark, confident, kinetic but fast.

**Motion rules (hard constraints):**
- Every animation ≤ 400ms, ease-out. Stagger delays ≤ 60ms per item.
- Everything skippable: any click/keypress mid-animation jumps to the end state.
- Respect `prefers-reduced-motion`: all transitions collapse to instant.
- No animation may block input. Forms are interactive immediately.
- Use CSS transitions/keyframes + Tailwind utilities; no animation library unless one is already in the repo (check `package.json` first — if framer-motion is absent, do NOT add it; this is achievable with CSS).

**Route:** keep `/_auth/setup` as the route; rebuild the component. Wizard state in React (single `useState` step machine); persist progress server-side only at the points noted, so refresh mid-wizard resumes at the right step (derive resume step from what already exists: org? → role? → members?).

---

## PRE-TASK — RBAC expansion: director roles (do before Scene 5 work)
**The hierarchy rule: all Directors have admin-level access; Managers are scoped.**

The full lead roster for invites: **Technical Director, Creative Director, Production Director** (directors) + **Production Manager, Technical Manager, Stage Manager** (managers) + Admin, Member.

Add three new roles to `src/lib/permissions.ts`, following the existing pattern exactly:
- **`td` (Technical Director), `cd` (Creative Director), `pd` (Production Director):** all three get the **same permission set as `admin`** — i.e. `ALL_PERMISSIONS` minus `org:delete`. Define them by reusing the admin filter expression, not by copying a hand-typed list, so a future permission added to ALL_PERMISSIONS flows to all four automatically.
- Why distinct roles instead of just using `admin`: the title appears on the team page, board, and invitations — "Creative Director" means something "Admin" doesn't. And the sets can diverge later without a migration.
- Managers (`pm`, `tm`, `sm`) keep their existing scoped permission sets — unchanged.
- Add all three to `ROLE_META` (labels: "Technical Director", "Creative Director", "Production Director"; tier: "admin"; one-line descriptions) and to `ASSIGNABLE_ROLES`; update `normalizeRole`.
- Register the new roles wherever the Better Auth access-control plugin registers the existing five.
- **Future (do NOT build now):** `audio` (Audio Engineer) and `streamop` (Stream Op) come later as scoped operator roles when operator app access ships; the dynamic Scene 5 dropdown picks them up automatically with zero onboarding changes.
- Tests: each director role passes every permission check `admin` passes except `org:delete`; manager scoping unchanged (regression check on `tm` and `pm`).

## THE FLOW — 5 scenes

### Scene 1 — "Get your show on the air" (org creation)
- Full-viewport broadcast-dark stage. Top corner: live timecode clock (reuse logic/patterns from the existing timer route, display-only HH:MM:SS local clock).
- Headline: **"Let's get your first show on the air."** Single input: organization name.
- Slug auto-generates beneath the input, styled like a lower third sliding in (translate-y + fade, 300ms) — updates live as they type, debounced server uniqueness check with inline availability indicator (subtle green dot / red with suggestion, e.g. `faithfire-2`).
- Validation: existing `orgSlugSchema`; name via `labelSchema`.
- CTA: **"Build my show →"**. On submit: create org via existing Better Auth org-plugin flow + set `trialEndsAt = now + 14 days` (Task 2.6). Server-persisted checkpoint #1.

### Scene 2 — Role (one question, big targets)
**CRITICAL — RBAC decoupling:** The wizard runner created the org, so Better Auth's org plugin makes them `owner` with full permissions. The role question MUST NOT change their RBAC role. It is personalization + analytics only. (A volunteer who sets up the org is still the owner.)

- **"What's your role on the team?"** — 2×3 card grid, lucide icons, one tap advances (no Next button):
  - **Technical Director** (headset) — runs the booth
  - **Production Manager** (clipboard) — plans and coordinates
  - **Stage Manager** (timer) — calls the show
  - **Creative / Worship Director** (palette) — owns the content
  - **Pastor / Staff** (building) — oversees everything
  - **Operator / Volunteer** (sliders) — runs a position
- Storage: write the archetype string to the creator's org membership metadata as `onboardingRole` (display + analytics only). Do not touch the Better Auth `role` field.
- Landing-route mapping (stored in membership metadata, used at end of Scene 5): TD → `/{slug}/show` · PM → `/{slug}/dashboard/prod-manager` · SM → `/{slug}/rundown` · Creative → `/{slug}/streaming/graphics` · Pastor → `/{slug}/dashboard/prod-manager` · Operator → `/{slug}/show`.
- These six archetypes are intentionally broader than the RBAC system. The real RBAC roles today are exactly `ASSIGNABLE_ROLES` from `permissions.ts`: `admin`, `pm`, `tm`, `sm`, `member` (labels/descriptions in `ROLE_META`). Roles like audio engineer, stream tech, camera op do not exist yet — they are a planned RBAC expansion. The onboarding flow must not invent them; when they land in `ROLE_PERMISSIONS`, Scene 5 picks them up automatically (see below).
- Server-persisted checkpoint #2.

### Scene 3 — Template selection (show posters, not radio buttons)
- **"Pick your first show."** Four cards styled like show key-art: **Sunday Service**, **Youth Night**, **Special Event**, **Start Blank**. Dark gradient cards, big title, runtime badge (e.g. "~75 MIN · 9 ITEMS").
- Hover/focus (and tap on mobile): card expands a mini rundown preview — the template's items animate in as compact rows (stagger ≤ 60ms), with a summed total duration. This preview is static data rendered client-side from the same template definitions used to seed (single source of truth).
- Template definitions live in `src/lib/templates.ts` as plain data (id, name, items[{title, durationSec, type}], checklist[], cueRows[]):
  - **Sunday Service:** Pre-service loop 15:00 · Walk-in 5:00 · Opener 4:30 · Welcome 2:00 · Worship set 18:00 · Announcements 3:00 · Message 35:00 · Response/Worship 6:00 · Outro 3:00. Checklist: camera checks, audio line check, ProPresenter loaded, stream key verified, comms check. 2 sample cue rows.
  - **Youth Night:** Doors/music 10:00 · Hype opener 5:00 · Game segment 10:00 · Worship 12:00 · Message 20:00 · Hang time 15:00. Lighter checklist.
  - **Special Event:** Walk-in 10:00 · Welcome 3:00 · Segment A 15:00 · Segment B 15:00 · Intermission 10:00 · Segment C 15:00 · Close 5:00.
  - **Start Blank:** seeds nothing; skips Scene 4's build animation to a brief "stage is yours" beat.
- Selecting a card → server fn `seedOrgTemplate({ orgId, template })` reusing creation logic from `rundown.ts`/`data.ts` (no duplicated insert code; wrap in a transaction if the existing helpers allow).

### Scene 4 — THE HERO MOMENT: the rundown builds itself
- While seeding runs, transition to a stylized rundown stage. As the server confirms, render the seeded items cascading in one by one (stagger ~50ms, slide-up + fade ≤ 300ms each), footer total duration counting up to the final runtime, then the show clock "arming" (clock face flickers on, goes steady).
- Implementation honesty: the cascade animates the already-confirmed data client-side — do NOT fake progressive server writes. If seeding takes > 1.5s, show the items that exist and finish gracefully.
- End state: **"Your show is built."** CTA: **"Get your team in →"**. Entire scene skippable per motion rules.

### Scene 5 — Build your team + GO LIVE
**Two distinct populations — never conflate them:**
1. **Crew (operators)** → `CrewMember` records (see `prisma/schema.prisma`): name + position (e.g. "Camera 2", "A1"). They populate the **show board** and check in via the board's existing "Scan to Serve" QR (`/checkin/{slug}`). They have **no account and no app access**. This is by design; app access for operator roles (audio, stream tech, etc.) is a planned RBAC expansion, not an onboarding concern.
2. **App members (leads)** → Better Auth invitations with real RBAC roles. They log in.

- **"Build your team."** Two side-by-side panels (stack on mobile), both skippable:
  - **Panel A — "Add your crew" (SHOW BOARD eyebrow):** up to ~4 quick rows of name + position, creating `CrewMember` records via the existing crew creation logic in `data.ts`. Position is free text; as the user types, render the inferred department as a small colored chip beneath the row using the existing `getDepartment()` + `DEPARTMENTS` from `src/types/index.ts` (Leadership/Production/Camera/Audio/Visuals/Lighting/Streaming/Technical/Other, with their existing colors) — sliding in like a lower third (≤ 300ms). This is pure reuse: do not duplicate the taxonomy or add a department field; grouping stays inferred. Footer note with QR icon: "On show day, your board shows a Scan to Serve code — crew check in from their phones." Do NOT render an invite QR here; the check-in QR lives on the board where it belongs.
  - **Panel B — "Invite your leads" (APP ACCESS eyebrow):** up to 3 email + role selects, using the existing Better Auth invitation flow. The role dropdown is built dynamically from `ASSIGNABLE_ROLES` + `ROLE_META` (after the pre-task: Technical Director, Creative Director, Production Director, Production Manager, Technical Manager, Stage Manager, Admin, Member) — never a hardcoded list, so future roles (Audio Engineer, Stream Op) appear automatically when added to `permissions.ts`. Default selection: `member`. Show each role's `ROLE_META.description` as helper text.
- Copy must make the distinction self-explanatory in one line per panel (crew: "no account, no login"; leads: "people who log in").
- Below, the finale: a single oversized circular **GO LIVE** button — broadcast red, subtle idle pulse (2s loop, opacity only — runs ≤ 3 cycles then settles, and never under reduced-motion).
- Press → brief "ON AIR" flash (≤ 400ms) → navigate to the role-based landing route. On the show page, show a dismissible **First Session Checklist** card: rename a rundown item · connect a device · invite a teammate · open the kiosk/board view. Persist dismissal + per-item completion in org/user metadata (simplest existing storage — check how UI prefs are stored today before adding anything).

---

## ANALYTICS (PostHog — funnel must map 1:1 to scenes)
Fire: `onboarding_started`, `org_created`, `role_selected` (prop: role), `template_selected` (prop: template), `seed_completed`, `crew_added` (prop: count), `invite_sent` (prop: count), `went_live`, `first_session_checklist_completed`.
Use the existing PostHog client setup (check how it's initialized in the repo; follow that pattern).

## EDGE CASES
- User already belongs to an org → skip wizard entirely (existing behavior — preserve it).
- Invited users joining an existing org must NEVER see this wizard — it's for org creators only.
- Refresh mid-wizard → resume at the correct scene (derive from server state; no localStorage — repo rule).
- Slug collision on submit despite live check → inline error, stay on Scene 1.
- Seeding failure → toast with retry; never strand the user; org without seed is valid (they land on empty states from Task 3.2).
- Mobile: the whole flow must work one-handed on a phone — cards stack, QR scene is actually MORE important on mobile.

## TESTS
- `templates.ts`: every template's items sum to the advertised runtime; seed function creates expected counts; idempotency guard (re-running seed for an org that already has the template doesn't duplicate).
- Role archetype storage test: selecting any archetype never mutates the Better Auth `role` field (creator remains `owner`); `onboardingRole` metadata + landing route persist correctly.
- Invite role dropdown test: options derive from `ASSIGNABLE_ROLES`/`ROLE_META` (adding a role to permissions.ts surfaces it with zero onboarding changes).
- Wizard step-resume derivation unit test (org exists/role set/etc. → correct scene).

## ACCEPTANCE
- [ ] New org creator goes signup → GO LIVE in under 5 minutes with zero documentation
- [ ] Populated show page at the end — no blank screens anywhere in the flow
- [ ] All motion ≤ 400ms, fully skippable, reduced-motion clean
- [ ] PostHog funnel shows all 7 events in sequence for a test run
- [ ] Lighthouse: wizard route stays interactive < 2s on mid-range mobile
