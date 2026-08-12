# SHOWPILOT-COMPANION-SPEC.md
## Companion control surface — full button set (Stream Deck via Generic HTTP)
*Branch: `feature/companion` off main (after `feature/fixes-1` merges, since both touch lower thirds / cloud_enabled — rebase on the merged main). Same ground rules: per-task commits, tsc + vitest green per task, zod on every write path, reuse before rebuild. This supersedes Task B of SHOWPILOT-FIXES-SPEC.md — do Tasks A and C there separately/first.*

---

## ARCHITECTURE (decided, verified against code)
ShowPilot exposes a thin authenticated control API; Bitfocus Companion's **Generic HTTP module** calls it from Stream Deck buttons. No custom Companion module. Auth mirrors the existing kiosk-token system exactly: org-scoped `cmp_` bearer tokens, HMAC via `kiosk-token.ts` primitives, separate `COMPANION_SECRET` (fail-closed; `wrangler secret put COMPANION_SECRET`, document in DEPLOY.md). All control writes must broadcast through the same relays the UI uses (`RundownRelay`, LT relay) so a button press updates every operator screen live.

**Code facts established during spec authoring (build on these, don't re-derive):**
- Transport transitions live CLIENT-side in `apps/web/src/hooks/useRundown.ts` (`start(itemId)`, `pause()`, `stop()`, `next()`), persisting via `saveRundownTimer` / `saveRundownItems`. There is `next()` but NO `previous()` and NO time-adjust.
- `setProPresenterStageDisplay({ orgId, enabled })` (rundown.ts) already toggles the ProPresenter-lyrics-on-timer feature via an AppSetting — this IS buttons 7/8.
- `triggerLowerThird` / `clearLowerThird` (lowerthirds.ts) exist; gated by `cloud_enabled`.
- `stream.ts` manages Cloudflare live INPUTS (create/delete/status). The Multi-Platform page (`streaming/platforms.tsx`) has working **Go Live** (`connectDestinationsToInput`) and **Stop All** (`disconnectAllDestinations`) for simulcast destinations — buttons 10 wires these directly.
- Kiosk (`kiosk.ts`) views are display-only (`timer`/`overlay`/`board`); no blank/show command exists yet.

---

## TASK COMP-1 — Token auth + setup page
- `cmp_` tokens: create/list/revoke server fns gated `settings:api_keys` (same permission kiosk tokens use), HMAC-signed under `COMPANION_SECRET`, records stored like kiosk tokens. Reuse `kiosk-token.ts`; do not reimplement crypto.
- Settings → a "Companion / Stream Deck" tab: generate token (shown once), display org base URL, and copy-paste Generic HTTP button examples for each action below. This page is what makes it usable without docs.
- Tests: verify/expire/wrong-secret rejection; cross-org token rejected; permission gating on token management.

## TASK COMP-2 — Extract transport to a shared pure module (no behavior change)
Extract the four transitions from `useRundown.ts` into `apps/web/src/lib/rundown-transport.ts` as pure functions `(items, timer, arg?) => { items, timer }`: `start(itemId)`, `pause()`, `stop()`, `next()` — replicating current logic byte-for-byte. Refactor `useRundown.ts` to consume it. **Add two new transitions** in the same module:
- `previous()` — mirror of `next()`: find current index, `start()` the previous item; at index 0, stay/no-op (don't wrap).
- `adjustTime(deltaSeconds)` — shift the running timer by ±N without changing play state: adjust `startedAt` (or `elapsed` if paused) so the displayed remaining time moves by delta; clamp so elapsed never goes negative. Works in both play and pause.
Wire `previous` and `adjustTime` into the rundown UI too (small buttons: ◀ prev, −1m / +1m) — they're useful beyond Companion. Existing show/rundown tests must stay green; add unit tests for all six transitions.

## TASK COMP-3 — Control endpoints (the real-backend buttons)
Under `/api/v1/companion/*`: verify `cmp_` bearer → resolve orgId → load current state → apply pure transition → persist via existing fns → broadcast. Compact JSON responses. zod + rate-limit every endpoint.
- `POST /timer/start` (itemId optional → resumes/continues current) — **button 1**
- `POST /timer/stop` — **button 2**
- `POST /rundown/next` — **button 3**
- `POST /rundown/previous` — **button 4**
- `POST /timer/add` (body: `seconds`, default 60) → `adjustTime(+)` — **button 5**
- `POST /timer/subtract` (body: `seconds`, default 60) → `adjustTime(-)` — **button 6**
- `POST /propresenter/lyrics` (body: `enabled: bool`) → `setProPresenterStageDisplay` — **buttons 7 (on) / 8 (off)**
- `POST /lower-third/trigger` (templateId/content), `POST /lower-third/clear` — **button 11** (respect `cloud_enabled`; if off, 403 with a clear message)
- `GET /state` → timer + active item + nextItem + LT state + lyrics-enabled flag, for Companion button feedback
- Tests: each endpoint applies the right transition with the right orgId; cross-org isolation; relay broadcast asserted; lower-third endpoints blocked when `cloud_enabled = 0`.

## TASK COMP-4 — Kiosk show/blank (button 9, new capability)
Add a per-org kiosk display command the kiosk client honors: a `kiosk_blanked` AppSetting (bool) plus a bump to the existing kiosk read API so displays poll/receive it (kiosks already poll read-only endpoints — extend that, don't add a socket). When blanked, kiosk shows a black/branded slate; when restored, returns to its view.
- `POST /api/v1/companion/kiosk/blank` (body: `blanked: bool`) — **button 9 (toggle on/off)**.
- UI: a "Blank displays" toggle on the kiosk settings page too.
- Tests: blank state persists, kiosk read API reflects it, companion endpoint gated by token.

## TASK COMP-5 — Stream go-live (button 10) — backend EXISTS, just wire it
**Confirmed in code:** the Multi-Platform page (`streaming/platforms.tsx`) already has working Go Live / Stop All:
- Go Live → `connectDestinationsToInput({ orgId, liveInputId })` — connects configured simulcast destinations (YouTube/Facebook/Twitch/RTMP) to the org's live input via Cloudflare Stream Connect. (`inputs[0].id` is the active live input.)
- Stop All → `disconnectAllDestinations({ orgId })`.
These are real server functions — no new Cloudflare capability needed; the earlier "no start-broadcast API" caveat does NOT apply because this connects *simulcast outputs*, which Cloudflare does expose.
- `POST /api/v1/companion/stream/go-live` → resolve the org's live input (mirror the page's `inputs[0]` selection; if zero inputs, 409 with "No live input configured"), call `connectDestinationsToInput`, return per-destination success/failure JSON. — **button 10**
- `POST /api/v1/companion/stream/stop` → `disconnectAllDestinations`.
- `GET /state` should include connected-destination count so a Stream Deck button can show live status (the page already computes `liveOutputs` from connection statuses — reuse that logic).
- Tests: go-live calls connect with the right orgId + input and surfaces partial failures; stop disconnects all; cross-org token isolated; no-input case returns the clear 409.

**Note:** match the page's real behavior — YouTube etc. must be set to "Go Live" on the platform's own end first; ShowPilot connecting the destination doesn't start the platform's broadcast. The endpoint just triggers the same connect the button does; no extra logic.

## SETUP PAGE must list all 11 actions with ready-to-paste Generic HTTP examples (method, URL, headers, body), grouped: Transport (1–6), ProPresenter lyrics (7–8), Kiosk (9), Stream (10), Lower thirds (11).

## OUT OF SCOPE
Custom Bitfocus module · device/bridge LAN control · making encoders start/stop (out of SP's reach) · any onboarding/billing/RBAC change.

## ACCEPTANCE
- [ ] All 11 buttons callable via `cmp_` token from a Generic HTTP request, each doing the real thing (button 10 = the existing Multi-Platform Go Live / Stop)
- [ ] Transport extraction is no-behavior-change; previous + add/subtract time also in the UI; all six transitions unit-tested
- [ ] Cross-org isolation on every endpoint; LT + lyrics respect their gates; all writes broadcast via relay
- [ ] Setup page generates a token and prints copy-paste Stream Deck examples for every action
- [ ] tsc clean, full suite green
