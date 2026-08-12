# SHOWPILOT-LAUNCH-PHASE-SPEC.md
## Phase 5 — Landing, embedded checkout, legal/ops
*Final build phase. Branch: `feature/launch-phase` off main (after the onboarding merge, PR #3). Same ground rules as SHOWPILOT-LAUNCH-SPEC.md: per-task commits, tsc + vitest green after each task, zod on every new write path, reuse before rebuild.*

---

## TASK 5.0 — Settings stub audit + organization deletion (do first)

**5.0a — Dead-button audit:** sweep all settings sections and modals for UI actions with no backing server function or TODO-stubbed handlers (the Delete Organization button in DangerSection is the known case — its confirm flow calls nothing). Produce the list in the commit message, then fix or remove each: no dead buttons may survive this phase.

**5.0b — Real organization deletion (the most dangerous function in the app — treat it accordingly):**
- Owner-only (`org:delete` permission), name-typed confirmation (UI already exists), and require fresh session re-validation server-side.
- Order of operations: (1) cancel any Stripe subscription via API first (skip gracefully if none), (2) delete all child rows across every model referencing the org — derive the table list from `prisma/schema.prisma`, do not hand-maintain it; audit FK `onDelete` behavior and delete in dependency order inside a transaction, (3) delete R2 objects under the org's prefix, (4) delete Better Auth memberships/invitations and the organization, (5) revoke the acting session and redirect to an "organization deleted" confirmation.
- Idempotent and resumable: a partial failure must be safely re-runnable.
- **Tests are mandatory and blocking:** cross-org isolation (deleting org A touches zero rows of org B — seed both, assert counts), Stripe-cancel-first ordering, permission denial for every non-owner role including the new directors, and idempotent re-run.
- Also build the standalone dry-run script (`scripts/delete-org.ts`, dry-run prints per-table row counts) sharing the same core deletion module — used for manual cleanup (there is at least one test org in production awaiting it).

**5.0c — Role must resolve from the route's org, not the session's active org (CRITICAL — wrong permissions for any multi-org user):**
- **Bug:** `$slug.tsx` beforeLoad resolves the user's role via `getActiveMemberRole()`, which reads `session.activeOrganizationId` — not the org in the URL. Browsing any org other than the session-active one silently falls back to `let role = "member"`. Symptom: an owner who creates a second org (e.g. a test org) loses owner permissions on their real org — member-visible pages still work while guarded routes (e.g. `lowerthird:view`) bounce to /board.
- **Fix:** in `$slug.tsx` beforeLoad, resolve the membership role for the slug's org directly (`member.findFirst({ organizationId: <orgId from slug>, userId })`). Remove the silent `"member"` fallback entirely: a non-member is redirected away from the org; a lookup *error* surfaces as an error — never a quiet privilege downgrade. As a side effect, sync `session.activeOrganizationId` to the visited org so other Better Auth flows stay consistent. Audit all other callers of `getActiveMemberRole()` for the same wrong-org assumption.
- **Regression tests (blocking):** owner of org A who just created org B retains owner role when browsing A; non-member of A resolves no role and is redirected; role resolution is per-URL-org, never per-session-active-org.
- **Then expose the hidden Template Studio:** add a "Template Studio" button on `streaming/graphics` (visible only with `lowerthird:configure`) linking to `streaming/lt-preview`, and a back-link from lt-preview to graphics. Rename nothing; the route's existing `lowerthird:view` guard stays.

**Sequencing note: ship Task 5.0 (a+b+c) as its own PR before starting 5.1** — 5.0c is a live permissions bug affecting any beta user who belongs to or creates more than one org.

## TASK 5.1 — Landing page (apps/landing)

**First: inspect `apps/landing` as it exists** — framework, deploy target, current content — and adapt. Do not assume; if it's a stub, rebuild within its existing framework choice unless it's abandoned tech, in which case propose (in the commit message) the lightest path consistent with the monorepo (prefer a static/lightweight approach on Cloudflare; this is a marketing page, not an app).

**Positioning (this copy direction is decided — implement, don't reinvent):**
- Hero: ShowPilot is the production OS for church and live-event teams — rundowns, crew, comms, device control, one place. Tagline direction: "Run your show, not your software."
- **Sell the replaced stack, not a feature list.** A comparison section: what a team currently juggles (run-of-show docs/spreadsheets, separate timer app, intercom rentals, device control scripts, paper checklists) vs. one ShowPilot subscription. Anchor: "less than renting one intercom beltpack for a weekend."
- **Flat per-org pricing is a headline, not a footnote:** "Unlimited operators. No per-seat pricing, ever." (Volunteers churn; per-seat pricing scares churches.)
- Broadcast-dark aesthetic consistent with the app and onboarding (timecode/tally visual language, the brand the wizard establishes).
- Sections: hero with product visual → replaced-stack comparison → feature trio (Rundowns & show clock / Crew & check-in / Device control & integrations) → pricing → founding-member CTA → FAQ (incl. "Do volunteers need accounts?" → no, crew check in via QR) → footer with legal links.

**Pricing section:**
- Three cards: Starter $39/mo · Pro $79/mo (highlighted) · note annual "2 months free" as coming-soon if annual prices aren't created in Stripe yet.
- **Founding member banner:** $25/mo locked for life, limited to launch window. CTA → signup → checkout with `STRIPE_PRICE_FOUNDING`.
- Pricing data lives in one constants file; do not hardcode prices in JSX in multiple places.

**Conversion path:** every CTA → app signup (`showpilot.tech` auth) → email verification → onboarding wizard → (trial active) → billing upsell handled in-app. The landing page itself never collects payment directly; checkout happens in the app post-signup (see 5.2). Add UTM passthrough on CTA links so PostHog (when enabled) can attribute.

**Acceptance:** Lighthouse ≥ 90 performance/SEO on mobile; OG/meta tags + social card; sitemap + robots.txt; all copy spell-checked; deploys via the existing pipeline or a documented equivalent.

## TASK 5.2 — Embedded checkout (apps/web)

Convert the existing hosted Stripe Checkout to **Embedded Checkout** so payment stays on showpilot.tech:
- `createCheckoutSession` in `src/lib/billing.ts`: add `ui_mode: "embedded"`, replace `success_url`/`cancel_url` with `return_url` (back to `/{slug}/settings?billing=success`), return the session `client_secret`.
- Client: add `@stripe/stripe-js` + `@stripe/react-stripe-js`; new route or modal at billing settings hosting `<EmbeddedCheckoutProvider>` + `<EmbeddedCheckout>`; loading + error states styled broadcast-dark.
- New build-time public var `VITE_STRIPE_PUBLISHABLE_KEY` (document in DEPLOY.md: set as GitHub Actions **variable** and in deploy.yml env, like the PostHog vars; also `.dev.vars.example` / `.env.local` note for local).
- **Webhook unchanged. Plan-gating unchanged. Customer Portal stays hosted (redirect)** — Stripe does not support embedding the portal; do not attempt.
- Keep the hosted-checkout code path behind a small flag or graceful fallback if the publishable key is missing, so a missing var degrades to the current working flow instead of breaking checkout.
- Tests: unit-test the session-mode selection and the fallback decision.

## TASK 5.3 — Legal & ops pages

- **Terms of Service + Privacy Policy** as static pages, linked from landing footer and app signup ("By creating an account you agree to…" with links).
  - Privacy must reflect reality and PIPEDA awareness: Canadian company; data stored on Cloudflare (D1/R2); subprocessors: Cloudflare, Stripe (payments), Resend (email), PostHog (analytics, when enabled); church member/crew data is personal information — describe what's collected (names, emails, roles, check-in timestamps), why, retention, deletion on request, contact email.
  - Mark both documents with a clear "template — requires founder/legal review before public launch" banner comment in the source, and write them conservatively. Do not invent certifications or claims (no "SOC 2", no "GDPR certified").
- **Support + status:** `support@showpilot.tech` referenced consistently (footer, app help, emails). Add an UptimeRobot/Better Stack-ready health endpoint `GET /api/health` (returns 200 + version/commit SHA) if one doesn't exist; document status-page setup as a manual step in DEPLOY.md.
- **Transactional email polish:** verification + invitation emails get a consistent footer (company line, support address, unsubscribe note where applicable).

## TASK 5.4 — Pre-launch checklist in DEPLOY.md

Append a "Public launch — switch flips" section: set `VITE_POSTHOG_KEY`/`VITE_POSTHOG_HOST` + `VITE_STRIPE_PUBLISHABLE_KEY` (GitHub Actions variables + deploy.yml env) → create live-mode Stripe products/prices/webhook + swap the five secrets to live values → run one real checkout + refund → set `publicLaunchDate` in superadmin → announce. Each with exact commands/URLs.

## OUT OF SCOPE
Annual billing prices (note as follow-up) · blog/CMS · EasyWorship or Planning Center API · any change to onboarding, RBAC, or device modules · paid ads tooling.

## ACCEPTANCE (phase-level)
- [ ] Zero dead buttons anywhere in settings; org deletion works end-to-end with all 5.0b tests green
- [ ] Role resolves from the URL's org on every route; multi-org regression tests green; Template Studio reachable from graphics
- [ ] Landing live with founding CTA → signup → wizard → embedded checkout, end to end on production
- [ ] Checkout never leaves showpilot.tech (except hosted portal for subscription management)
- [ ] Terms/Privacy linked at signup and footer, flagged for founder review
- [ ] /api/health returns 200 + SHA; DEPLOY.md has the launch-switch checklist
- [ ] tsc clean, full suite green, Lighthouse targets met
