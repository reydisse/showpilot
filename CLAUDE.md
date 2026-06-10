# ShowPilot — Claude Code Project Guide

ShowPilot is a cloud-native live production management platform for
churches and live event teams. This is a **live, deployed product**
(https://showpilot.tech) — every change must keep production working.

─────────────────────────────────────────
GROUND RULES
─────────────────────────────────────────

1. Work on a feature branch, never directly on `main`.
2. Additive where possible, surgical when modifying. Never weaken
   orgId scoping — every query touching org data filters by orgId.
3. After meaningful changes run:
   - `pnpm --filter @showpilot/web test`
   - `pnpm --filter @showpilot/web exec tsc --noEmit`
4. Commit before deploying. After deploying, smoke-test the auth path
   (login → org page) in production.
5. All secrets come from the Workers env (`wrangler secret put`,
   `.dev.vars` locally). No fallback values — fail closed.

─────────────────────────────────────────
TECH STACK (source of truth: STACK.md)
─────────────────────────────────────────

- Frontend:    React 19 + TanStack Start/Router (SSR on Workers)
- Backend:     Cloudflare Workers — server functions via
               `createServerFn` in `apps/web/src/lib/*.ts`
- Database:    Cloudflare D1 (SQLite) via **Prisma**
               (`apps/web/prisma/schema.prisma`, 27 models;
               client created per-request in `src/lib/db.ts`)
- Auth:        **Better Auth** + organization plugin
               (`src/lib/auth.ts`) — email/password, invitations,
               dynamic access control, cookies via
               `tanstackStartCookies()`. Use `getAuth()` at runtime;
               the static `auth` export is CLI-only.
- Realtime:    Durable Objects (`src/durable-objects/`):
               ChatRelay, RundownRelay, LowerThirdsRelay,
               TimecodeRelay, BridgeRelay — one instance per org,
               WebSocket rooms, SQLite persistence.
- Storage:     R2 bucket via `STORAGE` binding (logos, assets)
- Email:       Resend REST API (`src/lib/email.ts`)
- Video:       Cloudflare Stream (live inputs + Stream Connect
               simulcast) in `src/lib/stream*.ts`
- Styling:     Tailwind v4 + shadcn/radix components in
               `src/components/ui/`, lucide icons
- Tests:       Vitest (`pnpm --filter @showpilot/web test`)
- Deploy:      `wrangler deploy` (config: `apps/web/wrangler.jsonc`)

There is **no Firestore, no Firebase, no Cloudflare Pages** — older
docs that mention them are wrong.

Monorepo layout (`pnpm` workspaces):

- `apps/web`     — the product (everything above)
- `apps/bridge`  — local Node bridge for ProPresenter/devices
- `apps/gateway` — edge gateway worker
- `apps/landing` — marketing site

─────────────────────────────────────────
MULTI-TENANCY
─────────────────────────────────────────

Every org-scoped table carries `orgId` (Better Auth tables use
`organizationId`). Server functions must:

1. Validate input with zod via `parseOrThrow`
   (`src/lib/validation.ts`) before any DB call.
2. Verify the caller's membership/permission for that org —
   see the `getOrgMemberRole` / `assertOrgPermission` pattern in
   `src/lib/settings.ts` and `src/lib/app-permissions.ts`.
   Functions that receive only a row id must resolve the row's
   orgId first, then assert access against it.

Durable Object rooms and kiosk tokens are scoped per org. Kiosk
tokens are HMAC-signed (Web Crypto) with the `KIOSK_SECRET` env
secret (`src/lib/kiosk.ts`).

─────────────────────────────────────────
PRODUCT PHILOSOPHY
─────────────────────────────────────────

“Bring your own stack — ShowPilot connects to it.
No stack? ShowPilot IS the stack — and it’s better.”

ShowPilot is an integration layer first, native fallback second.
Every feature checks whether the org has an external tool configured
(OnTime, ProPresenter, Slack, Mattermost, …). If yes, SP bridges to
it. If no, SP’s native feature activates — and the native feature
must be functionally equivalent to or better than the external tool
it replaces.

Adapter resolution (see `getActiveAdapters` in `src/lib/settings.ts`):

1. Check org settings for configured integration
2. If configured and healthy → use integration adapter
3. If not configured or unhealthy → fall back to native silently
4. Show connection status in settings only, never in operator UI

The UI/UX benchmark for native features is OnTime (getontime.dev).
Match its operational depth and reliability in SP’s own
broadcast-dark design language — don’t clone its UI.

This is a production tool used by real operators during live
services. Clarity over beauty, speed over cleverness, zero ambiguity
under pressure.

─────────────────────────────────────────
GLOBAL UI/UX RULES
─────────────────────────────────────────

1. BROADCAST FIRST — no spinners blocking critical actions, no
   confirmation modals for non-destructive actions, no mystery states.
2. STATE IS ALWAYS VISIBLE — live / next / idle clear at a glance.
   Color + iconography + typography together; never color alone.
3. OPTIMISTIC UI — update instantly, confirm or revert via WebSocket.
4. DARK THEME — operators work in dark booths. Dark background,
   high contrast, accent color for live/active states.
5. KEYBOARD SHORTCUTS for critical actions; `?` opens the help overlay.
6. MULTI-DEVICE — MacBook primary, iPad secondary, Windows laptop.
   Responsive and touch-friendly without sacrificing desktop density.
7. WEBSOCKET RESILIENCE — reconnect with backoff, subtle status
   indicator, queue outgoing messages during disconnect, never lose
   operator actions silently.
8. INTEGRATION TRANSPARENCY — operator UI never exposes which adapter
   is active or its error states. Settings shows status.
9. NATIVE = BETTER — native fallbacks are not consolation prizes.
10. All destructive actions require explicit confirmation (danger
    zone actions require typing the org name).

─────────────────────────────────────────
CONVENTIONS
─────────────────────────────────────────

- Server functions: `createServerFn({ method })` +
  `.inputValidator((data: unknown) => parseOrThrow(schema, data))` +
  `.handler()`. Auth/permission assertion is the first line of the
  handler.
- D1 migrations are hand-written SQL files in
  `apps/web/prisma/migrations/` (numbered `000N_name.sql`), applied
  with `wrangler d1 execute`/`pnpm db:migrate:*`. Run
  `pnpm db:generate` after schema changes.
- New routes are files under `apps/web/src/routes/` (TanStack file
  routing; `routeTree.gen.ts` is generated — never hand-edit).
- The device-module layer (`src/lib/device-modules/`) is stable and
  well-tested — do not refactor it incidentally.
- Latency target: operator action → all clients < 300ms. Must work
  on 5Mbps church internet.
