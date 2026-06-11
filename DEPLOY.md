# Deploying ShowPilot

ShowPilot's product app (`apps/web`) deploys to Cloudflare Workers and serves
https://showpilot.tech and https://admin.showpilot.tech. Bindings (D1
`showpilot-db`, R2 `showpilot-storage`, five Durable Object relays) are
defined in `apps/web/wrangler.jsonc` — that file is the source of truth.

**Golden rules** (from CLAUDE.md): commit before deploying; never deploy with
unapplied D1 migrations; after every production deploy, smoke-test the auth
path (login → org page).

---

## How deploys happen

**Automatic (the normal path).** Push to `main` → the CI workflow
(`.github/workflows/ci.yml`) runs typechecks and tests → on success, the
Deploy workflow (`.github/workflows/deploy.yml`) checks for unapplied D1
migrations and then runs `wrangler deploy` for `apps/web`. The deploy **fails
loudly without deploying** if any migration file is not recorded as applied
(see [D1 migrations](#d1-migrations)). PRs and feature branches never deploy.

**Manual (fallback).** From the repo root, with `wrangler login` done (or
`CLOUDFLARE_API_TOKEN` exported):

```sh
git checkout main && git pull
pnpm install --frozen-lockfile
pnpm --filter @showpilot/web db:generate     # required: generated client is gitignored
pnpm --filter @showpilot/web exec tsc --noEmit
pnpm --filter @showpilot/web test
pnpm --filter @showpilot/web deploy          # = vite build && wrangler deploy
```

To roll back a bad deploy: Cloudflare dashboard → Workers & Pages →
`showpilot` → Deployments → roll back to the previous version (or
`pnpm exec wrangler rollback` from `apps/web`).

---

## Required production secrets

All secrets live in the Workers environment — **no fallback values; missing
secrets throw at first use**. Set each one from `apps/web`:

```sh
cd apps/web
pnpm exec wrangler secret put <NAME>    # paste the value at the prompt
```

Verify what's set with `pnpm exec wrangler secret list`. Local-dev
equivalents go in `apps/web/.dev.vars` (gitignored — never commit values).

| Secret | Used by | Where the value comes from |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Session/cookie signing (`src/lib/auth.ts`) | Generate: `openssl rand -base64 32`. Rotating it invalidates **all active sessions**. |
| `KIOSK_SECRET` | HMAC signing of kiosk tokens (`src/lib/kiosk.ts`) | Generate: `openssl rand -base64 32`. Rotating it invalidates all outstanding kiosk tokens. |
| `RESEND_API_KEY` | Transactional email (`src/lib/email.ts`) | Resend dashboard → API Keys; use a production key for the showpilot.tech sending domain. |
| `STRIPE_SECRET_KEY` | Stripe API client (`src/lib/billing.ts`) | Stripe dashboard (live mode) → Developers → API keys → secret key (`sk_live_…`). |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification (`src/routes/api/stripe/webhook.ts`) | Signing secret (`whsec_…`) of the live webhook endpoint — see [Stripe setup](#stripe-live-mode-setup). |
| `STRIPE_PRICE_STARTER` | Checkout price ID (`src/lib/billing.ts`) | Live price ID (`price_…`) of the Starter product. |
| `STRIPE_PRICE_PRO` | Checkout price ID (`src/lib/billing.ts`) | Live price ID of the Pro product. |
| `STRIPE_PRICE_FOUNDING` | Checkout price ID (`src/lib/billing.ts`) | Live price ID of the Founding Member product. |

Also required for Cloudflare Stream features (live inputs and Stream Connect
simulcast, `src/lib/stream*.ts`) — these throw at first use if missing:

| Secret | Where the value comes from |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages overview (right sidebar). |
| `CLOUDFLARE_STREAM_API_TOKEN` | API token with **Stream: Edit** permission for the account. |

> **Rename in progress:** the Stream token used to be called
> `CLOUDFLARE_API_TOKEN`, which collided with the GitHub Actions deploy
> token of the same name. The code prefers `CLOUDFLARE_STREAM_API_TOKEN`
> and falls back to the legacy name. To finish the rotation, **after** the
> renamed code is deployed:
>
> ```sh
> cd apps/web
> pnpm exec wrangler secret put CLOUDFLARE_STREAM_API_TOKEN   # same token value
> pnpm exec wrangler secret delete CLOUDFLARE_API_TOKEN
> ```
>
> Do **not** delete the old secret before deploying — the currently
> deployed code only reads the legacy name. Once the old secret is gone,
> the fallback in `src/lib/stream.ts` / `stream-destinations.ts` can be
> removed.

Optional: `BETTER_AUTH_URL` — the app defaults to `https://showpilot.tech`
when unset (`src/lib/auth.ts`, `src/lib/billing.ts`); only set it for a
non-production host.

---

## Stripe live-mode setup

One-time setup, done in the Stripe dashboard in **live mode** (repeat in test
mode for `.dev.vars` values):

1. **Products & prices.** Product catalog → create three products, each with
   a recurring monthly price: **Starter**, **Pro**, **Founding Member**. Copy
   each live price ID (`price_…`) into the matching secret:
   `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FOUNDING`.
2. **Webhook endpoint.** Developers → Webhooks → Add endpoint:
   - URL: `https://showpilot.tech/api/stripe/webhook`
   - Events: `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted`
     (the only events the handler processes — see
     `src/routes/api/stripe/webhook.ts`).
   - Copy the endpoint's signing secret (`whsec_…`) into
     `STRIPE_WEBHOOK_SECRET`.
3. **Customer portal.** Settings → Billing → Customer portal → enable it
   (the in-app billing section links orgs to the portal for plan changes and
   cancellation).
4. **Verify** with the post-deploy smoke test: a test-mode checkout must flip
   the org's plan via the webhook within seconds.

---

## D1 migrations

Migrations are **hand-written sequential SQL files** in
`apps/web/prisma/migrations/` named `000N_name.sql` (currently through
`0007_billing.sql`). They deliberately do **not** use wrangler's
migrations-directory convention — never run `wrangler d1 migrations apply`.
Nothing applies them automatically; the deploy workflow only *checks* and
blocks.

(The timestamped directories in the same folder are legacy Prisma-dev
artifacts; the numbered files are the convention. After editing
`schema.prisma`, run `pnpm db:generate`.)

### Applying a migration to production

From `apps/web`:

```sh
# 1. Apply the file against the remote (production) database:
pnpm exec wrangler d1 execute showpilot-db --remote --file=prisma/migrations/000N_name.sql

# 2. Record it in the manifest the deploy gate checks:
#    append the filename on its own line to
#    apps/web/prisma/migrations/applied-remote.txt

# 3. Commit and push. The deploy workflow re-runs and passes.
```

For local development use `--local` instead of `--remote`.

### Current state

All migrations through `0007_billing.sql` were applied to production and
verified (via read-only `sqlite_master` / `pragma_table_info` queries) on
2026-06-10. The manifest is up to date.

---

## GitHub Actions setup

Repository secrets (Settings → Secrets and variables → Actions):

| Repo secret | How to create |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template, scoped to this account. (Deploy-only: the workflow never touches D1, so no D1 permission is needed. Distinct from the runtime Stream token `CLOUDFLARE_STREAM_API_TOKEN` — same dashboard, different permissions and different place.) |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview → right sidebar → Account ID. |

Workflow summary:

- **`ci.yml`** — PRs and pushes to `main`. Order is load-bearing:
  install → `db:generate` → typecheck → test. The generated Prisma client is
  gitignored, so skipping the generate step makes `tsc --noEmit` fail with
  ~61 cascading errors. The bridge typecheck is temporarily non-blocking
  (pre-existing `@types/ws` error — see the comment in the workflow).
- **`deploy.yml`** — runs only after CI succeeds on a push to `main`. Fails
  before deploying if any numbered migration file is missing from
  `applied-remote.txt`, printing the exact `wrangler d1 execute` commands to
  run.

---

## Post-deploy smoke tests

Run after **every** production deploy, in this order:

1. **Auth path (always, non-negotiable):** log in → org page loads.
2. **Signup:** create a new account → verification email arrives (Resend) →
   verify → land in the app.
3. **Onboarding:** setup wizard completes → seeded rundown visible on the
   show page. *(Applies once Phase 3 onboarding ships — Phase 4 was built
   ahead of Phase 3.)*
4. **Billing:** run a checkout (Stripe test mode pre-launch; post-launch use
   a live card and refund) → webhook flips the org's plan → settings billing
   section shows the new plan.
5. **Portal cancellation:** cancel via the Stripe customer portal → plan
   reverts to free.
6. **Kiosk:** generate a kiosk token → kiosk URL loads the stage display.
7. **Realtime:** open a rundown in two browsers → edits propagate < 300 ms.

If the auth path fails, roll back immediately (see
[How deploys happen](#how-deploys-happen)), then debug.
