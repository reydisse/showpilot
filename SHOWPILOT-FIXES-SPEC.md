# SHOWPILOT-FIXES-SPEC.md
## Post-launch fix pack — lower thirds toggle, Companion control API, carried-over launch items
*Branch: `feature/fixes-1` off main. Same ground rules as prior specs: per-task commits, tsc + vitest green after each, zod on every new write path, reuse before rebuild. Ship as one PR unless a task grows large enough to warrant its own.*

---

## TASK A — Lower thirds: real toggle + feature-gated ≠ forbidden

**Context:** `organization.cloud_enabled` (0/1) gates all `lowerthird:*` permissions in `apps/web/src/middleware/withPermission.ts` (`isCloudEnabled`). Today it defaults to 0 and there's no UI to change it, so every org silently bounces to /board when opening lower thirds — indistinguishable from a permission denial. Found in production; all four existing orgs had it off.

- **A1 — Default ON for new orgs:** set `cloud_enabled` default to 1 in the schema (new migration, additive) and in org creation. Existing orgs stay as-is (owner flips via the new toggle). Note: this rides the Durable Object LT relay; if cost-gating is wanted later, gate via existing plan-limits — but default ON for now (beta wow factor > cost).
- **A2 — Settings toggle:** in settings → lower thirds config (or streaming settings), add an owner/admin-only switch bound to `cloud_enabled` via a new validated server fn `setCloudEnabled({ orgId, enabled })` (reuse the `settings:*` permission + session pattern from existing settings fns). Broadcast-dark switch, optimistic update, clear label: "Cloud lower thirds — enables browser-triggered lower thirds and the Template Studio."
- **A3 — Feature-gated must not impersonate permission-denied:** in the middleware, when a `lowerthird:*` check fails *only* because `cloud_enabled = 0` (role actually has the permission), return a distinct reason (`feature_disabled`) rather than the generic forbidden. In `route-permissions.ts` `withPermission`, route `feature_disabled` to a new explainer page `/$slug/streaming/lower-thirds-disabled` — "Cloud lower thirds aren't enabled for this organization," with an Enable button (owner/admin only, calls setCloudEnabled) and a link to settings. Never a silent /board redirect for a feature flag.
- **Tests:** role-has-permission + flag-off → feature_disabled (not forbidden); role-lacks-permission → forbidden regardless of flag; toggle flips the column and is owner/admin-gated.

## TASK B — Companion control API
**Moved to its own document: SHOWPILOT-COMPANION-SPEC.md** (it grew to 11 buttons across transport, ProPresenter lyrics, kiosk, and stream — too large to bundle here). Execute SHOWPILOT-FIXES-SPEC (A + C) first; Companion rebases on the merged main afterward.

## TASK C — Embedded checkout publishable key (carried over)
- Add `VITE_STRIPE_PUBLISHABLE_KEY` as a GitHub Actions **variable** and to `deploy.yml`'s deploy step env (`${{ vars.VITE_STRIPE_PUBLISHABLE_KEY }}`), like the planned PostHog vars. Document in DEPLOY.md's switch-flip checklist (test `pk_test_...` now, `pk_live_...` at launch). Without it the code already falls back to hosted checkout — this just lights up the in-app modal. No app code change expected beyond confirming the var is read.

## CARRIED-OVER, NON-CODE (tracked here so they're not lost — founder/ops, NOT for Claude Code)
- Pair the Faithfire bridge before recording the demo video (devices layer needs the on-prem bridge for LAN hardware).
- Founder + legal review of `/terms` and `/privacy` (flagged TEMPLATE in source) before public launch.
- Switch-flip week: PostHog key, Stripe live keys + publishable var, `publicLaunchDate`.

## OUT OF SCOPE
Custom Bitfocus Companion module (Generic HTTP only) · device-control layer / bridge work · ProPresenter changes · any onboarding/RBAC/billing logic changes beyond what's above.

## ACCEPTANCE
- [ ] Lower thirds: owner toggle works; new orgs default ON; flag-off shows the explainer (never silent /board); tests green
- [ ] Companion: token auth + all endpoints proxy existing fns, broadcast via relay, cross-org isolated; setup page generates a usable token; tests green
- [ ] VITE_STRIPE_PUBLISHABLE_KEY wired in CI; in-app checkout modal embeds instead of redirecting
- [ ] tsc clean, full suite green
