# SHOWPILOT-LAUNCH-SPEC.md
## Implementation handoff — Claude Code execution document
*Authored by Claude (CTO review session, June 9, 2026) for Claude Code. Verified against repo snapshot `588d4136`.*

---

## HOW TO USE THIS DOCUMENT

You are Claude Code, working in the ShowPilot monorepo. This spec was produced from a full review of the codebase. Execute phases **in order** — Phase 1 is security-critical and blocks everything else. Within a phase, tasks are ordered by dependency.

**Ground rules (override anything stale in CLAUDE.md until Task 1.4 fixes it):**
- The stack is: TanStack Start + React 19 on Cloudflare Workers, **D1 via Prisma** (`apps/web/src/lib/db.ts`), **Better Auth** with org plugin (`apps/web/src/lib/auth.ts`), Durable Objects, R2, Resend. CLAUDE.md's references to Firestore/Firebase/Cloudflare Pages are **wrong** — ignore them.
- Branch: `git checkout -b feature/launch-readiness`. Commit per task with the task ID in the message (e.g. `feat(1.1): kiosk secret to env`).
- Additive where possible; surgical when modifying. Never weaken orgId scoping — every Prisma query touching org data must filter by orgId, matching the existing pattern in `src/lib/data.ts`.
- After each task, run: `pnpm --filter @showpilot/web test` and `pnpm --filter @showpilot/web exec tsc --noEmit`. Fix what you break before moving on.
- Match existing code style: server functions via `createServerFn`, shadcn/radix components from `src/components/ui/`, Tailwind v4, lucide icons, the broadcast-dark aesthetic.

---

# PHASE 1 — SECURITY HARDENING (do first, ~1 day)

### Task 1.1 — Kiosk secret to env, fail-closed
**File:** `apps/web/src/lib/kiosk.ts` (line ~82)

Current: `const KIOSK_SECRET = "showpilot-kiosk-secret-v1"; // TODO: move to env var`

Required:
```ts
import { env } from "cloudflare:workers";

function getKioskSecret(): string {
  const secret = (env as Record<string, unknown>).KIOSK_SECRET as string | undefined;
  if (!secret) throw new Error("KIOSK_SECRET is not configured");
  return secret;
}
```
- Replace every use of the constant with `getKioskSecret()` (sign + verify paths).
- Update `apps/web/worker-configuration.d.ts` to declare `KIOSK_SECRET: string`.
- Add to README/deploy notes: `wrangler secret put KIOSK_SECRET` (operator runs this manually; generate with `openssl rand -base64 32`).
- **Do not** add a fallback value. Fail closed.

### Task 1.2 — Remove Better Auth secret fallback
**File:** `apps/web/src/lib/auth.ts`, inside `getAuth()`

Current: `const secret = (cfEnv.BETTER_AUTH_SECRET as string) || "showpilot-better-auth-secret";`

Required: if `BETTER_AUTH_SECRET` is missing, `throw new Error("BETTER_AUTH_SECRET is not configured")`. No fallback. Leave the static CLI-only `auth` export untouched (it's for schema generation, never runtime).

### Task 1.3 — Zod validation on all write-path server functions
- `pnpm --filter @showpilot/web add zod`
- Create `apps/web/src/lib/validation.ts` exporting shared schemas: `orgSlugSchema` (lowercase, `/^[a-z0-9-]{3,40}$/`), `emailSchema`, `idSchema` (non-empty string, max 64), plus a `parseOrThrow(schema, data)` helper that throws a 400-style error with the first issue message.
- Sweep every `createServerFn` with `method: "POST"` across `src/lib/*.ts` (notably: `rundown.ts`, `kiosk.ts`, `rbac.ts`, `settings.ts`, `graphics.ts`, `stream-destinations.ts`, `lowerthirds.ts`, `superadmin.ts`, `chat.ts`, `data.ts`) and validate `.data` before any DB call. Use TanStack Start's `.validator()` if the installed version supports it; otherwise validate at the top of `.handler()`.
- Also validate `POST /api/waitlist` body (`apps/web/src/routes/api/waitlist/index.ts`): email required + valid, name ≤ 100 chars, role ≤ 50 chars.
- Priority order within this task: kiosk token creation → org/invitation flows → waitlist → rundown/show mutations → the rest.

### Task 1.4 — Rewrite root CLAUDE.md
Rewrite `CLAUDE.md` so its TECH STACK, MULTI-TENANCY, and DATA sections describe reality: D1 + Prisma (`prisma/schema.prisma`, 25 models), Better Auth + org plugin + dynamic access control, Durable Objects (ChatRelay, RundownRelay, LowerThirdsRelay, TimecodeRelay, BridgeRelay), R2 `STORAGE`, Resend email, TanStack Start server functions. Keep the philosophy/UX sections ("integration layer first, native fallback second", OnTime as benchmark, broadcast-dark, clarity under pressure) — those are correct and good. Source of truth for stack details: `STACK.md` (accurate).

### Task 1.5 — Rate limiting
- Code-level minimum: enable Better Auth's built-in `rateLimit` option in `getAuth()` (window 60s, max 10 for auth endpoints).
- Waitlist: track per-IP submissions; simplest Workers-native approach is a small DO or a D1 insert-and-count over the last hour — cap at 5/hour/IP, return 429. Keep it minimal; Cloudflare WAF rules will layer on top (manual step, note it in deploy docs).
- Tighten waitlist CORS: allow origin `https://showpilot.tech` (landing page origin) instead of `*`.

### Task 1.6 — Tenancy & token test suite
Create `apps/web/src/lib/__tests__/security.test.ts` (vitest, follow existing patterns in `src/lib/__tests__/timecode.test.ts`):
1. `verifyToken` rejects a token signed with a different secret.
2. `verifyToken` rejects a structurally invalid token (2 parts, garbage b64).
3. `verifyToken` rejects an expired payload (if `exp` is honored — check `kiosk.ts`; if expiry isn't enforced on verify, **add it** and test it).
4. Validation schemas reject: bad slug, bad email, oversized strings.
5. Unit-test `parseOrThrow` error shape.
(True cross-org DB isolation tests need a D1 test harness — if `@cloudflare/vitest-pool-workers` isn't configured, skip DB-level tests and leave a `// FOLLOW-UP` comment rather than building the harness now.)

---

# PHASE 2 — BILLING (Stripe) (~3–4 days)

### Task 2.1 — Schema migration
Add to `model Organization` in `prisma/schema.prisma`:
```prisma
plan                 String    @default("free") // "free" | "starter" | "pro"
stripeCustomerId     String?   @unique
stripeSubscriptionId String?
subscriptionStatus   String?   // mirrors Stripe status
trialEndsAt          DateTime?
foundingMember       Boolean   @default(false)
betaTester           Boolean   @default(false) // see Task 2.7
```
Create `prisma/migrations/0005_billing.sql` by hand (match the existing hand-written migration style of 0002–0004: `ALTER TABLE organization ADD COLUMN ...`). Run `pnpm db:generate`. Apply locally via wrangler d1 execute against the new file.

### Task 2.2 — Stripe integration layer
- `pnpm --filter @showpilot/web add stripe`
- New file `apps/web/src/lib/billing.ts`:
  - `getStripe()` — instantiate with `STRIPE_SECRET_KEY` from `cloudflare:workers` env (fail closed like 1.1). Use `Stripe` with `httpClient: Stripe.createFetchHttpClient()` — Workers has no Node http.
  - Server fn `createCheckoutSession({ orgId, plan })`: owner/admin only (reuse session + role check pattern from `src/lib/settings.ts` or `superadmin.ts`); creates/reuses Stripe customer (store `stripeCustomerId`); Checkout session in subscription mode; price IDs from env: `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FOUNDING`; `client_reference_id = orgId`; success/cancel URLs back to `/{slug}/settings?billing=success|cancelled`.
  - Server fn `createPortalSession({ orgId })`: owner/admin only; Stripe billing portal; return URL to settings.
- Env declarations in `worker-configuration.d.ts`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FOUNDING`.

### Task 2.3 — Webhook route
New file `apps/web/src/routes/api/stripe/webhook.ts` (follow the file-route server-handler pattern from `api/waitlist/index.ts`):
- POST only. Verify signature with `stripe.webhooks.constructEventAsync` (async variant — required on Workers).
- Handle: `checkout.session.completed` → set plan (map price ID → plan; founding price sets `plan: "pro"` + `foundingMember: true`), store subscription ID, status; `customer.subscription.updated` → sync status + plan; `customer.subscription.deleted` → revert org to `plan: "free"`.
- Look up org by `client_reference_id` first, fall back to `stripeCustomerId`. Return 200 fast; log unhandled event types.

### Task 2.4 — Plan gating
- New file `apps/web/src/lib/plan-limits.ts`:
```ts
export const PLAN_LIMITS = {
  free:    { members: 5,   devices: 2,  shows: 3,    integrations: false, kiosk: false },
  starter: { members: 25,  devices: 10, shows: 50,   integrations: true,  kiosk: true },
  pro:     { members: 100, devices: 999, shows: 999, integrations: true,  kiosk: true },
} as const;
```
  (Numbers are launch defaults — keep them in this one file so they're trivially tunable.)
- `requirePlanFeature(orgId, feature)` and `checkPlanLimit(orgId, resource, currentCount)` helpers; enforce server-side in: member invitation flow, device creation, show/rundown creation, kiosk token creation, integration save in settings.
- Treat an active trial (`trialEndsAt > now`) as `pro`.
- UI: where a limit blocks an action, show an upgrade prompt (reuse `confirm-dialog.tsx` styling) linking to settings → billing.

### Task 2.5 — Billing UI in settings
Extend `src/routes/$slug/settings.tsx` with a Billing section (owner/admin only, gate via existing `app-permissions.ts` patterns): current plan badge, trial countdown if active, three plan cards (Starter $39 / Pro $79 / Founding $25 — founding card only while org `createdAt` is before public-launch flag in `AppSetting`), buttons → `createCheckoutSession`; "Manage billing" → portal session. Match broadcast-dark styling.

### Task 2.6 — Trial on signup
In the org-creation flow (Better Auth org plugin hook in `auth.ts`, or post-create in `setup.tsx`'s server path): set `trialEndsAt = now + 14 days`. No card required. On expiry orgs naturally evaluate as `free` via the gating helper — no cron needed.

---

### Task 2.7 — Beta tester comp access (free until public launch)
Beta churches get full Pro access at no cost until public launch — **without** creating any Stripe objects. No subscriptions, no $0 invoices, no coupons.

- **Schema** (fold into the 0005_billing.sql migration from Task 2.1): add `betaTester Boolean @default(false)` to `model Organization`.
- **Global launch date:** store `publicLaunchDate` (ISO string) in the existing `AppSetting` model as a platform-level setting. Add a helper `getPublicLaunchDate()` in `billing.ts` (null = not yet set = beta access stays open).
- **Plan evaluation** (in the Task 2.4 gating helpers): effective plan resolves in this order:
  1. `org.betaTester === true` AND (`publicLaunchDate` unset OR `now < publicLaunchDate`) → `pro`
  2. `org.trialEndsAt > now` → `pro`
  3. otherwise → `org.plan`
  Implement as a single `getEffectivePlan(org)` function in `plan-limits.ts` so the precedence lives in exactly one place. All gating calls go through it.
- **Superadmin controls** (`src/lib/superadmin.ts` + `src/routes/superadmin.tsx`, follow existing `requireSuperAdmin()` pattern): toggle `betaTester` per org; set/update `publicLaunchDate`; org list shows effective plan + beta badge.
- **UI:** beta orgs see a small "Beta — free until launch" badge in the settings Billing section instead of plan cards. Once `publicLaunchDate` is set, show the date and a founding-rate ($25/mo, `STRIPE_PRICE_FOUNDING`) checkout CTA so beta orgs can convert early.
- **Conversion behavior at launch:** no cron needed — the moment `now >= publicLaunchDate`, `getEffectivePlan` stops honoring the beta flag and the org evaluates as `free` (limits enforce, upgrade prompts appear). Data is never locked or deleted.
- **Tests:** unit-test `getEffectivePlan` precedence: beta before launch → pro; beta after launch → free; beta + active trial after launch → pro until trial end; paid plan always wins over expired beta.
- **Acceptance:** flipping `betaTester` on grants Pro features instantly; setting `publicLaunchDate` in the past downgrades all non-paying beta orgs with no deploy or migration.

---

# PHASE 3 — ONBOARDING & ACTIVATION (~3 days)

### Task 3.1 — Setup wizard
Rebuild `src/routes/_auth/setup.tsx` as a 3-step wizard (keep route path):
1. **Org** — name + auto-slug (existing logic), validate slug uniqueness server-side with a clear inline error.
2. **Template** — cards: *Sunday Service*, *Youth Night*, *Special Event*, *Start Blank*. Selecting one seeds via a new server fn `seedOrgTemplate({ orgId, template })` in a new `src/lib/templates.ts`: a rundown (8–12 realistic items with durations — e.g. Pre-service loop 15:00, Walk-in 5:00, Opener 4:30, Welcome 2:00, Worship set 18:00, Message 35:00, Response 6:00, Outro 3:00), one checklist template (camera checks, audio line check, ProPresenter loaded, stream key verified, comms check), and 2 sample cue sheet rows. Reuse creation logic from `src/lib/rundown.ts` / `data.ts` — do not duplicate insert code.
3. **Invite** — up to 3 email + role rows using the existing Better Auth invitation flow; skippable.
Finish → navigate to `/{slug}/show`.

### Task 3.2 — Empty states
Audit every route under `src/routes/$slug/` (rundown, show, board, team, checkin, production/*, streaming/*, dashboard/*). Any list/dashboard that can render empty gets a shared `<EmptyState icon title description action />` component (new, in `src/components/ui/empty-state.tsx`) with a primary action (create first X / seed sample / link to settings). No blank screens anywhere.

### Task 3.3 — Email verification
Enable Better Auth `emailVerification` in `getAuth()`: send via existing `sendEmail` + a new `verificationEmail()` template in `email.ts` (match the dark wrapper style). `requireEmailVerification: true` for org creation but allow login pre-verification with a banner prompt. Add a `/verify-email` confirmation landing under `_auth`.

### Task 3.4 — CSV import (people)
New settings section + server fn `importMembersCsv`: accept pasted CSV or file upload (≤ 500 rows), columns `name,email,role` (tolerate Planning Center export headers — map `First Name`+`Last Name` → name). Parse server-side (hand-rolled split is fine for v1 — validate per-row with zod), create `CrewMember` rows, dedupe on email, return summary `{ imported, skipped, errors[] }` rendered in the UI. Respect plan member limits from 2.4.

---

# PHASE 4 — CI/CD & DEPLOY PIPELINE (~half day)

### Task 4.1 — GitHub Actions
`.github/workflows/ci.yml`: on PR + push to main → pnpm install (cache), `tsc --noEmit` per workspace with a tsconfig, `vitest run` for web + bridge.
`.github/workflows/deploy.yml`: on push to main, after CI → `wrangler deploy` for `apps/web` using `CLOUDFLARE_API_TOKEN` secret. Add a migration step that applies any unapplied SQL files (document the manual `wrangler d1 migrations` alternative if the hand-written migration layout doesn't fit wrangler's migrations dir convention — in that case, print the pending files and require manual apply rather than guessing).

### Task 4.2 — Deploy documentation
`DEPLOY.md` at repo root: full list of required secrets (`BETTER_AUTH_SECRET`, `KIOSK_SECRET`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price IDs), how to set each (`wrangler secret put`), Stripe product/price/webhook setup steps, D1 migration procedure, and the post-deploy smoke test list (signup → setup wizard → seeded rundown visible → checkout test-mode → webhook flips plan → kiosk token works).

---

## ACCEPTANCE CHECKLIST (the definition of "done")
- [ ] Repo contains zero secret values; missing secrets throw at first use, never fall back
- [ ] Every POST server function validates input with zod before touching Prisma
- [ ] A new user can sign up → verify email → wizard → land on a populated show page in < 10 min
- [ ] An org can check out (Stripe test mode), webhook updates plan, limits enforce server-side, portal cancellation reverts to free
- [ ] Trial orgs behave as pro until `trialEndsAt`, then as free, with no cron
- [ ] Beta orgs evaluate as pro until `publicLaunchDate`, then as free — controlled entirely from superadmin, no deploy needed
- [ ] CI blocks merge on type or test failure; main deploys automatically
- [ ] `pnpm --filter @showpilot/web test` fully green, including new security tests

## OUT OF SCOPE — do not build now
EasyWorship adapter · Planning Center API (CSV only) · FreeCom/OpenClaw integration · SMS notifications · mobile PWA rework · any refactor of the device-module layer (it's the crown jewel — leave it alone).

*If anything in the live repo has drifted from snapshot `588d4136` (file moved, API changed), adapt to current reality and note the deviation in the commit message rather than forcing this spec literally.*
