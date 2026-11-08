# Deploying ShowPilot

ShowPilot's product app (`apps/web`) deploys to Cloudflare Workers and serves
https://app.showpilot.tech and https://admin.showpilot.tech. The old
https://showpilot.tech origin remains attached for installed Desktop/Bridge
clients, companion windows, existing links and webhook endpoints. Its browser
homepage redirects to the marketing page at https://www.showpilot.tech;
Desktop's `ShowPilotDesktop/` user agent keeps loading the application there.
Bindings (D1
`showpilot-db`, R2 `showpilot-storage`, six Durable Object relays) are
defined in `apps/web/wrangler.jsonc` — that file is the source of truth.

**Golden rules** (from CLAUDE.md): commit before deploying; never deploy with
unapplied D1 migrations; after every production deploy, smoke-test the auth
path (login → org page).

---

## How deploys happen

CI includes web and Bridge tests, Desktop offline controls, shared/mobile
TypeScript checks, and the web production build with client-boundary and bundle
budgets. Prisma generation runs before typechecks. These checks require no
deployment credentials. The retired gateway has no remaining CI target.

**Automatic (the normal path).** Push to `main` → the CI workflow
(`.github/workflows/ci.yml`) runs typechecks, tests, builds, and Worker dry-runs
→ on success, the Deploy workflow (`.github/workflows/deploy.yml`) checks for
unapplied D1 migrations and the required private downloads bucket, then deploys
`apps/web` and `apps/landing`. The deploy **fails loudly without deploying** if
either precondition is missing. PRs and feature branches never deploy.

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
Check data compatibility first. Once kiosk or Companion token hashes have been
stored, the rollback build must support digest lookup. Earlier builds that look
up plaintext tokens will reject those credentials; use a compatible build or a
forward fix instead of restoring plaintext credentials.

---

## Landing page (apps/landing → www.showpilot.tech)

The marketing page is a zero-dependency static site served by its own Worker
(`showpilot-landing`) on the custom domain `www.showpilot.tech`. The Worker
also streams approved Desktop and Bridge artifacts from the private
`showpilot-downloads` R2 bucket; GitHub release links are not used because the
repository is private. It deploys automatically after CI succeeds on `main`.
For a manual fallback:

```sh
cd apps/landing
pnpm deploy          # = node build.mjs && wrangler deploy
```

Notes:
- Before the first download-enabled deploy, create the bucket with
  `pnpm exec wrangler r2 bucket create showpilot-downloads`. Upload verified
  artifacts and write `manifests/releases.json` last; see
  `apps/landing/RELEASES.md`. Do not upload an unsigned or unverified build.
- iOS and Android buttons are driven by the same manifest but link only to
  allowlisted official App Store and Google Play listings. Keep them absent
  until the store listing and reviewed production build are public.
- `build.mjs` interpolates prices/links from `src/pricing.mjs` into
  `src/index.template.html` and writes `dist/` (gitignored). **All prices
  live in `src/pricing.mjs`** — keep them in sync with the Stripe prices
  and the app's plan cards when they change.
- First deploy: the `www.showpilot.tech` custom domain is created
  automatically from `wrangler.jsonc` (the zone must be on the same
  Cloudflare account).
- The social card is `static/og.png`, regenerated from `og-source.svg`
  with `npx @resvg/resvg-js-cli og-source.svg static/og.png`.
- Landing CTAs deep-link to `https://app.showpilot.tech/login?signup=1` and
  forward `utm_*` params for attribution.
- Run `pnpm verify` before deploying, then run
  `pnpm smoke -- https://www.showpilot.tech` afterward. The download buttons
  remain disabled when the public release manifest is absent, so an incomplete
  upload cannot become a 404.

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
| `COMPANION_SECRET` | HMAC signing of `cmp_` Companion/Stream Deck control tokens (`src/lib/companion.ts`) | Generate: `openssl rand -base64 32`. Distinct from `KIOSK_SECRET` — these authorize live control writes. Rotating it invalidates all outstanding companion tokens. |
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

Required: `BETTER_AUTH_URL=https://app.showpilot.tech`. Auth, billing returns
and invitation emails use this configured origin. Set it with
`wrangler secret put BETTER_AUTH_URL` from `apps/web`. Keep `BETTER_AUTH_SECRET`
unchanged during a domain move. Browser cookies remain scoped to their host,
so users may need to sign in once on the new app domain.

When introducing the app domain, deploy its custom-domain route first, confirm
HTTPS and `/api/auth/ok`, then update `BETTER_AUTH_URL` and deploy the landing
CTA change. Keep legacy API, WebSocket, Stripe and Slack webhook URLs working;
do not transfer the apex custom domain to the static landing Worker.

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
`apps/web/prisma/migrations/` named `000N_name.sql`. They deliberately do **not** use wrangler's
migrations-directory convention — never run `wrangler d1 migrations apply`.
Nothing applies them automatically; the deploy workflow only *checks* and
blocks.

(The timestamped directories in the same folder are legacy Prisma-dev
artifacts; the numbered files are the convention. After editing
`schema.prisma`, run `pnpm db:generate`.)

### Device timing

Apply `0051_device_latency.sql` before deploying the Worker that reads
`device.latencyMs`, then regenerate the Prisma client during the build. Existing
devices default to zero latency. The column accepts whole milliseconds from
0 through 60000; the server and device editor enforce the same range.

Timecode captures enabled devices' latency when a source starts or automation
is enabled. Native MTC/LTC initially uses the snapshot captured when the show
room is prepared, before accepting any feeds.
The snapshot survives relay eviction, and feed evaluation makes no D1 timing
queries during playback. Device edits apply at the next start/enable boundary.
Cue lead and captured latency add together; dispatch cannot precede frame zero.
The timeline keeps the nominal cue time and shows the compensated dispatch time.
Use `node apps/web/scripts/smoke-timecode-latency.mjs` after building to check the
device editor, D1 value, relay timing, and narrow layouts with disposable data.

Operator, song-preview, and confidence clocks interpolate only between frames
already reported by the relay, with at most 100 ms of display buffering. Cue
capture and automation continue to use the authoritative frame. Disconnects,
stops, seeks, and format changes snap to that frame; an expired feed cannot keep
the display advancing. Public clock snapshots include frame count and format,
but no cue payloads or control fields. `signal.lastFeedAt` identifies the sample;
later lyrics/status broadcasts must not refresh it.
Run `node apps/web/scripts/smoke-timecode-presentation.mjs` to verify operator and
confidence rendering against a real 10 Hz local relay. Its foreground-emulation
mode isolates rendering from OS focus changes; `smoke-timecode-clock.mjs` checks
the source in a genuinely hidden tab separately.

The internal generator resumes its held frame by default. To choose an offset,
stop the source, select **Start at a specific timecode**, enter the SMPTE position,
and confirm. The relay validates the reviewed show, frame rate, and held position
again after device preparation. A late Stop, seek, or reformat cancels that start.
The browser waits for the exact confirmed frame before feeding, including at
drop-frame boundaries. Large moves retain automation's jump-review hold, and
fired cues stay fired. The old browser-only millisecond start path is removed.
`node apps/web/scripts/smoke-timecode-start-position.mjs` checks this flow in the
built app, including exact first frames and Pause/Stop resume behavior.

### Kiosk and Companion token storage

The token digest release keeps the existing `token` columns and stores a
`sha256:` digest in them. It does not need a SQL schema change or new signing
secrets. New credentials are returned only by the creation response. Listing
and revoking credentials return metadata only; copy a new token before leaving
Settings or dismissing it.

Previously issued tokens remain valid. Authentication converts a matching old
row with an organization-scoped compare-and-set update. The scheduled Worker
also converts up to 100 rows per token table on each run, including expired and
revoked tokens, so unused credentials do not remain in plaintext. Revocation,
expiry, token IDs and device configuration are preserved. Re-running this
backfill is safe.

After deployment, verify that both counts reach zero. This read-only query
prints counts, never token values. Run it from `apps/web`:

```sh
pnpm exec wrangler d1 execute showpilot-db --remote --command "SELECT 'kiosk' AS kind, COUNT(*) AS remaining FROM kiosk_token WHERE token NOT LIKE 'sha256:%' UNION ALL SELECT 'companion', COUNT(*) FROM companion_token WHERE token NOT LIKE 'sha256:%';"
```

Do not restore a pre-digest Worker after this conversion. The hash cannot be
converted back to the issued token. Keep a compatible rollback build, and test
an existing kiosk display and Companion control with the saved device tokens.

### Bridge connection audit protocol

The Worker and bundled native Bridge require device-policy protocol 3. The
native Bridge waits for a socket-bound receipt before a command opens or
reopens TCP, OSC, UDP or direct HTTP control. Wake-on-LAN requests a receipt
for each transient broadcast socket. The relay records the authenticated
operator or automation execution from the original command, never attribution
or destinations supplied in the receipt request. Existing connections continue
without this extra round trip. Automatic local ProPresenter connections also
wait for an installation-attributed audit receipt, without sending passwords.
An audit failure, denial or missing receipt prevents the connection.

Release the Worker and both Desktop/Bridge bundles together during a planned
maintenance window. Older native agents receive HTTP 426, and restored older
sockets close with 4406. The policy-3 agent also cannot connect to a policy-1 or policy-2
Worker. Do not perform this transition mid-show. Keep a matching Worker/native
pair for rollback, subject to the storage compatibility restrictions below.
This protocol adds no signing secret or database migration.

Connection settings now travel only in an encrypted envelope. Each native
WebSocket connection generates an ephemeral RSA-OAEP/SHA-256 key pair and sends
its public key in the authenticated upgrade header. The private key stays in
native memory. The Worker encrypts the entire settings object with a fresh
AES-256-GCM key, wraps that key for the selected recipient, and authenticates
the organization, installation, protocol, target, nonce and expiry. The native
process rejects plaintext settings, altered bindings, expired messages and
replay. Envelopes expire after 30 seconds; keep the native host clock accurate.
Only the public key is kept in the relay socket attachment for hibernation.
Neither plaintext settings nor encrypted envelopes are broadcast to operators.
This transport uses no new Worker secret and does not replace TLS.

Device JSON encryption, masked device read/add/update responses and private
ProPresenter delivery and native configuration-file migration are described
below. Transport encryption alone does not complete the rollout.

After building the web application and native sidecar, rehearse the actual
browser-to-Worker-to-native-to-device path against disposable local data:

```sh
node apps/web/scripts/smoke-bridge-command-connections.mjs apps/bridge-desktop/src-tauri/binaries/showpilot-bridge-aarch64-apple-darwin
```

Use the corresponding compiled executable path on other platforms. The check
opens a local TCP fixture, verifies operator attribution and connection reuse,
drops the socket, verifies a second attributed connection, then removes the
approval and checks that subsequent traffic is blocked. It also intercepts
the real native relay connection, proves an HTTP token is absent from wire
messages while the device receives the correct Authorization header, and
checks that replaying the settings envelope is rejected.

### Editable organization settings boundary

Generic Settings reads and writes accept only the 36 fields in
`apps/web/src/lib/editable-settings.ts`. Internal `app_setting` records, including
live rundown state, graphics selection, webhook history and operation receipts,
are excluded. Workspace and schedule-provider configuration continue through
their dedicated commands. Existing field permissions, credential encryption and
masked responses still apply.

This closes a reproduced bypass where a technical manager could overwrite
internal records through `updateOrgSetting`. The credential editor rejects
those keys too. The unused unconditional bulk-update and arbitrary-key delete
RPCs have been removed. No data migration or new secret is required. Existing internal rows remain available to their owning server code.
Future Settings fields must be added to the registry with an explicit permission.

Run `node apps/web/scripts/smoke-settings-boundary.mjs` after building to exercise
the compiled RPCs with real authentication and disposable D1 data. Deployment
and production verification are still pending.

### Settings save acknowledgement and recovery

General Settings writes now carry the last confirmed value and a UUID request
ID. The server checks current permissions and atomically records the result with
the conditional setting write. A retry checks that same receipt and reports the
current value; it cannot overwrite a later edit. Conflicts require the operator
to choose the saved value or apply their edit against the reviewed value.

Keep `setting-write:*` records for the lifetime of the organization. Deleting a
receipt would allow an old request to be interpreted as a new operation. These
internal records are excluded from editable Settings reads and writes. The
unused bulk-update and arbitrary-key delete RPCs have no remaining callers.
Old Settings tabs must reload after deployment because unconditional payloads
are rejected. Deploy the web client and Worker together.

Each field has a ten-second confirmation deadline, its own persistent error and
timestamp, and an exact-request Retry. A newer edit waits until the uncertain
write is resolved. ProPresenter Apply & test waits for confirmed setting saves.
Confidence layout Apply uses the same protocol while preserving newer preview
edits. Leaving an unsaved Settings page or closing a dirty confidence editor
requires confirmation. The separate encrypted credential editor still uses its
existing API and is not covered by this autosave recovery change.

Run `node apps/web/scripts/smoke-settings-autosave.mjs` after building. It uses
real authentication, two fixture operators, compiled RPCs, disposable D1 and
Chrome to check lost responses, concurrent edits, conflict review, navigation,
ProPresenter test blocking and confidence preview recovery. It also checks
320px, 768px and 1440px widths, then inspects persisted values and receipts.

If Wrangler's local ProxyWorker exits with `Network connection lost`, run the
same script with `SHOWPILOT_SMOKE_RUNTIME=miniflare`. This opt-in fixture backend
runs the same compiled Worker and local bindings through Wrangler's installed
Miniflare/workerd without its development proxy. It uses the same disposable
persistence as the D1 seed and inspection commands. It does not fix or hide a
production Worker error, restart a failed process, or change authentication.
The default fixture backend remains Wrangler. Both backends are local only.

Local validation passed 1,891 unit tests, 695 Worker tests, typecheck and the
production build. The direct-runtime browser rehearsal passed with 19 browser
write attempts and exactly 18 total unique operation receipts, including fixture
and second-operator writes. No browser errors occurred with an en-GB browser
locale and America/Toronto timezone. The organization Created date now uses an
explicit locale and UTC, fixing a reproduced server/client hydration mismatch.
Deployment and production verification remain pending.

### Public check-in identity and attendance recovery

Public `/checkin/:slug` no longer reads or restores a member ID from local
storage. It removes the legacy saved ID when the page opens. Every visit requires
a fresh member-ID lookup followed by an explicit name and attendance
confirmation. Completed identity screens clear after 15 seconds; an abandoned
confirmation clears after 60 seconds. Done and Not me clear the current identity
immediately. A missing organization renders an explanation instead of redirecting
to sign-in or Show Flow.

Lookup and attendance writes have ten-second confirmation deadlines. Errors and
timestamps persist with Retry, and a late response cannot replace the recovery
screen. Leaving or starting over with an uncertain write requires confirmation.
The existing public member-ID model and address/member rate limits remain in
place; this change does not introduce a PIN or an authenticated kiosk session.

Attendance writes now require a request ID and a revision from the fresh lookup.
The revision covers the crew record identity, attendance and check-in/out times.
D1 atomically records the outcome and conditionally changes attendance. Replaying
a committed request returns its receipt and current attendance without repeating
the change. Stale lookups and replaced crew records are rejected. Keep
`public-attendance:*` receipts for the lifetime of the organization so an old
request cannot become a new operation. Generic Settings cannot edit these keys.
No schema migration or new secret is required. Old open check-in pages must
reload after the client/Worker deployment because unconditional writes are rejected.
Signed-in crew attendance uses the recovery flow below. Mobile attendance keeps
its existing API contract.

Run `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-public-checkin.mjs`
after building. It creates disposable crew members and uses a browser without an
auth cookie. The rehearsal checks legacy-storage privacy, explicit identity
confirmation, lookup timeout/retry, a committed but lost check-in response,
subsequent check-out, exact Retry, the next person's entry, discard cancellation,
automatic identity clearing and missing/malformed organization links. It then inspects D1 for
three unique receipts, correct final attendance and an unchanged second org.

Local verification passed 1,899 unit tests, 706 Worker tests, typecheck, production
build and the anonymous browser rehearsal. No browser errors occurred. Recovery
controls passed at 320/768/1440px, and the actual 320px error and success screenshots
were inspected. Deployment and production verification remain pending.

### Automation and updater test coverage

The CI web-build and shared/mobile typecheck steps passed on GitHub run
[42332695395](https://github.com/reydisse/showpilot/actions/runs/42332695395).
Desktop offline and Bridge updater checks remain enabled. The parser follow-up
also passed both CI jobs on run
[42333037314](https://github.com/reydisse/showpilot/actions/runs/42333037314).

`timecode-device-command-contracts.test.ts` runs literal wire-command goldens
through `resolveTimecodeDeviceAction` with a fake D1. It covers ATEM, both DMX
transports, Home Assistant, PJLink, VISCA, TCP and a registered test-only WoL profile, including
legacy payloads, scoped bindings and rejected parameters. It does not claim a
built-in WoL product profile. Home Assistant's resolver golden uses the validated
discovery response; the relay and browser tests below cover actual discovery and
service dispatch.

Internal clock tests cover both ticker and elapsed-sample deduplication. Reconnect
tests require an explicit new Start, fresh master permission and confirmed relay
state before starting the local source. Desktop updater tests live with the
hosted desktop runtime in the web suite; they cover check-only, no-update,
explicit install, failure cleanup and restart behavior alongside Bridge's updater
suite. Tauri is mocked, so these are not certificate or installation tests.

Final local verification passed 1,956 unit tests, 718 Worker tests, nine Bridge
desktop tests and web typecheck. These changes add tests only; production code is
unchanged from the parser build. Hardware, remaining command coverage and the
broader Phase 2 gate remain open. No deployment was performed.

### Home Assistant timecode actions

The cue editor lists enabled Home Assistant devices by name. Selecting one reads
its current supported actions through the selected venue Bridge. Connect the
device in Devices first; discovery does not open connections or return device
configuration. Failed or malformed discovery keeps Save disabled and offers
Refresh actions. Changing selection discards old replies immediately.

Each cue execution discovers again before sending the service command. Removed
entities fail visibly. Connection credentials use the existing encrypted Bridge
envelope; discovery and service dispatch stay pinned to one installation. The
automation kill switch, controller authority and execution deadline remain in
force across discovery. Discovery has an eight-second deadline; a late reply
cannot send a service. A rejected service never counts as acknowledged.

Deploy the matching web client and Worker together. There is no migration or
Bridge protocol change. Existing current-protocol Bridges support these HTTP
commands. No deployment or native release has been performed for this change.

After web and Bridge builds, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-homeassistant-cues.mjs
```

This rehearsal uses real local authentication, D1, relays, the compiled Bridge
and a local HTTP simulator. It passed malformed discovery/Refresh, saved cue
execution, fresh rejection after an entity disappears, explicit Retry and two
authenticated service calls. Discovery replies contained no token, target URL or
private entity attributes; D1 held an encrypted credential. Recovery controls
passed at 320/768/1440px with no browser errors, and the 320px screenshot was
inspected. This is simulator evidence, not physical Home Assistant validation.

Final local verification passed 1,961 unit tests and 728 Worker tests, web
typecheck, production build and Bridge build. Ten Home Assistant Worker tests
cover real encrypted connection/discovery/service, permissions, malformed and
missing entities, service rejection, timeout/late reply, kill switch and Bridge
handoff. The command-golden requirement is verified; the remaining Phase 2
requirements and hardware acceptance are still open.

### Relay failure tests

The isolated Worker test configuration binds both lower-thirds and cue-sheet
fault wrappers. Successful requests still use the production relays, authority
checks, sockets and persistent revision state. Test-only endpoints are exported
only from `src/test/worker-entry.ts`, never from the deployed Worker.

The timecode execution suite verifies actual lower-third dispatch and injected
503 failures for Show and Clear, including the redacted failed display state.
The cue-sheet regression keeps an injected broadcast outage across relay eviction,
checks that it publishes no event and advances no revision, restores delivery,
and then rejects a revoked member through the production permission check.

With both wrappers bound, the full web suite passed 1,961 unit tests and 729
Worker tests; web typecheck passed. This follow-up changes only tests and their
configuration. The production build and browser verification above remain valid.

### Coverage gate

Run `pnpm --filter @showpilot/web test:coverage` for the same web checks as CI:
migration and client boundaries, coverage-gate regressions, then all unit and
Worker tests with Istanbul instrumentation. The installed Cloudflare test plugin
requires Istanbul because its Worker runtime does not expose V8 coverage.
See the [Vitest coverage guide](https://vitest.dev/guide/coverage.html).

`coverage.config.ts` selects timecode helpers/sources, every Durable Object and
device modules. Both pools use the same selection and produce separate maps.
`scripts/check-coverage.mjs` merges execution counters before measuring each
group, so a line exercised by both pools is counted once. The checker compares
each pool against the source-file inventory and rejects empty or incomplete
reports. Tests and declarations are excluded; the TypeScript compiler identifies
the three type-only files with no executable output.

Initial local measurements across 38 executable files were:

| Group | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Timecode | 92.44% | 90.57% | 91.56% | 95.09% |
| Relays | 85.92% | 83.25% | 90.17% | 91.42% |
| Device modules | 64.55% | 49.66% | 62.90% | 67.19% |

The checked-in `coverage-baseline.json` floors each measured percentage to a
whole number. Every metric in every group must meet that threshold; a strong
group cannot hide a regression in another. To raise thresholds after adding
tests, run `pnpm --filter @showpilot/web coverage:ratchet`. This reruns the full
coverage command, refuses decreases and writes only equal or higher thresholds.
Review and commit the resulting baseline. CI never edits it automatically.

Reports under `apps/web/coverage/` are ignored by Git. The runner clears old
reports before starting either pool and does not run the gate after a failed
suite. CI uploads the reports as `web-coverage`, retained for seven days. The
combined JSON and group summary remain available after a threshold failure.

Local verification passed 1,961 unit tests, 729 Worker tests, four gate tests,
web typecheck, production build and frozen-lockfile installation. A negative
probe using the real reports exited 1 for an unmet threshold, then the baseline
was restored byte-for-byte. GitHub run
[42335684059](https://github.com/reydisse/showpilot/actions/runs/42335684059)
passed both CI jobs, including the actual coverage gate and artifact upload.

### Email verification status

The confirmation page now queries Better Auth with cookie caching disabled. An
absent URL error no longer means the email is verified, and old route context
cannot authorize the success screen. Signed-out visitors see Sign in; unverified
members see Check your inbox and can request another email or check again.
Continue appears only after the current session confirms verification.

Status reads and resend requests have eight-second deadlines. Failures retain a
timestamp and Retry; timeout/unmount aborts the request and a late reply cannot
replace recovery state. Email delivery confirmation never marks the address as
verified. Existing server-side organization-creation checks remain unchanged.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-email-verification.mjs
```

The rehearsal uses a disposable unverified account and Better Auth's real token
generator and verification endpoint. It passed anonymous/unverified states,
failed and timed-out status recovery, rejected resend, actual token consumption,
verified setup and final D1 inspection. No email provider is configured in the
fixture, so no external email is sent. Better Auth captures fetch during client
initialization; transport faults are installed before application modules load.
No browser errors occurred, controls passed at 320/768/1440px, and both 320px
screenshots were inspected. Full coverage checks passed 1,970 unit tests, 729
Worker tests and four gate tests; web typecheck and production build passed.

This fixes the false verification claim and its recovery flow. Password-reset
and main web signup/destination verification are documented below. Setup,
invitation-specific flows and the other compound auth requirements remain open. No deployment, schema
change or native release was performed.

### Password reset link validation and recovery

Reset pages check the token before showing password fields. The anonymous POST
returns only validity and uses the same Better Auth verification adapter and
expiry rule as the installed reset callback. It does not consume a valid token;
Better Auth still validates and consumes it when changing the password. Link
checks use the existing fail-closed D1 auth limiter, ten per IP per minute.
Missing, expired and used links offer a new reset request. Signed-in users can
reach both reset and forgot-password pages without an organization redirect.

Link checks and reset submissions have eight-second deadlines and abort cleanup.
Read failures offer Retry. Confirmed success stays visible with Sign in now.
A lost or failed write acknowledgement shows Reset not confirmed and offers
sign-in with the new password or a new reset link; it never automatically sends
the one-use token again. Definite password-policy and rate-limit errors retain
the form for correction or explicit Retry. Token changes discard the old form
and cancel pending requests. Passwords are not persisted in browser storage.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-password-reset.mjs
```

The fixture seeds disposable reset rows with the same ISO date storage used by
Prisma, keeps rate limiting enabled, and uses separate browser and HTTP probe
clients. Expected negative auth responses are tested through the compiled
Worker's HTTP request context. The Worker test host reports handled Better Auth
HTTP errors as unhandled rejections; it covers adapter/preflight behavior and
successful password changes, while the browser rehearsal covers expired/used
token rejection and wrong-password responses through the real HTTP entry.

Verification passed 1,982 unit tests, 733 Worker tests, four coverage-gate tests,
web typecheck and the production build. The compiled browser rehearsal passed
actual sign-in with the new password, missing/expired/used token rejection,
check timeout and Retry, signed-in reset/recovery, a committed save with its
acknowledgement withheld, late-response rejection, and final D1 password/token
inspection. No browser errors occurred. Controls passed at 320/768/1440px; the
phone form, check-error, success and unconfirmed-result screenshots were inspected.

No deployment, migration, email delivery or native release is part of this change.

### Web signup recovery and auth destinations

Confirmed signup opens the email-verification page. It does not enter setup or
an organization first. Verification, resend and the link delivered by email
carry a validated app destination through to Continue. Signed-out verification
visitors return to the status page after sign-in.

Signup and sign-in requests have eight-second deadlines and abort cleanup.
Known credential, password-policy and rate-limit errors use human messages;
other failures remain unconfirmed and include a timestamp. A lost signup
acknowledgement keeps the draft and offers Sign in to check account, then
returns to verification. Late replies cannot navigate
after timeout or unmount, and submissions never retry automatically.

The installed Better Auth version catches initial verification-email delivery
failures and still acknowledges account/session creation. The interstitial
checks verification status and does not claim delivery; failed explicit resend
requests show an error and Retry. Initial delivery errors are logged server-side
and are not exposed by Better Auth's signup response.

Return destinations now preserve app paths, queries and fragments. The shared
validator rejects external URLs, ambiguous slashes/control characters, API
routes and recursive auth destinations. Anonymous workspace navigation carries
its destination through login; authenticated users follow a valid destination
before the ordinary organization redirect. A signed-in user without workspace
access gets an error instead of a login loop. HTTP redirects cannot read a URL
fragment, so login restores the browser's inherited fragment before continuing.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-signup-recovery.mjs
```

Email capture is opt-in and requires the direct local runtime. It uses
[Miniflare's outbound service handler](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/README.md)
to intercept all outbound requests, accept only the Resend endpoint and
`@display-smoke.invalid` recipients, and save fixture emails locally. There is
no network fallback and the only provider key is a local dummy value. The
rehearsal switches delivery between rejection and success, follows real Better
Auth verification links and inspects D1 after stopping the Worker. It also runs
the required login-responsive check in both modes across 24 viewport cases.

Verification passed 2,032 unit tests, 733 Worker tests, four coverage-gate tests,
web typecheck and the production build. The compiled browser rehearsal passed
real signup and verification, initial provider failure followed by visible
resend failure/Retry, verification in a fresh session, a committed but lost
signup response, deep-link restoration and final D1 inspection of three accounts
with expected verification states and no organization memberships. No browser
errors occurred. Both login modes passed all 24 required viewport cases from
320 to 3440px, including tablet breakpoints and short windows. Recovery controls
passed 320/768/1440px; screenshots were inspected after animations settled.

The invitation-specific and mobile signup screens and the remaining setup
repair still need their own audits. No deployment, migration, external email delivery or native release is included.

### Setup team validation and responsive controls

The last setup step validates every entered crew and invitation row before any
write. Incomplete rows, duplicate email addresses and values rejected by the
server's field limits block submission, preserve the draft and show a row count
plus linked field errors. Clear row explicitly removes an optional entry. Names
and positions are trimmed; invitation addresses are trimmed and lowercased.
Controls have visible labels, keyboard submission and at least 44px targets.
Fields lock during submission. Finish setup describes saving the team and
opening the workspace without starting show transport or outputs.

The header counts all six steps and wraps at narrow widths. Its initial clock
is a fixed placeholder; local time starts after hydration. The previous epoch
Date still rendered different hours in different server/browser time zones.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-team.mjs
```

Twelve component regressions passed, including a real SSR/hydration mismatch
reproduction. Full validation passed 2,044 unit tests, 733 Worker tests, four
coverage-gate tests, web typecheck and the production build. The compiled
Worker/Chrome rehearsal proved invalid rows make no writes, explicit clearing
and correction work, and final D1 contains exactly one intended crew member and
one pending invitation. One invitation email was captured locally with all
external networking blocked. No browser errors occurred. Labels, full control
bounds, 44px targets and header separation passed at 320/768/1440px; both phone
screenshots were inspected.

This covers validation before submission. Save and delivery recovery are
covered below. Setup Back/exit and seeding recovery remain open.

### Setup saves and invitation delivery recovery

Setup saves its immutable team request and all crew rows in one D1 transaction.
Concurrent submissions select one saved request. Retrying or refreshing returns
that saved team without adding crew again or recreating someone later deleted
from Team. Every read, save, invitation attempt and completion rechecks current
owner access. Internal records use existing organization-scoped app settings;
no migration is needed.

Each invitation attempt has a conditional claim and durable outcome. Better
Auth still owns invitation creation, permissions, plan limits and resending.
Its installed plugin catches email-hook exceptions, so a setup-only async
context records the invitation ID and delivery result inside the email hook.
A provider acceptance is distinct from rejection or an unknown response.
Ordinary invitations outside setup keep their existing path.

Email attempts time out after eight seconds. Client calls time out after ten
seconds, cancel on unmount and ignore late replies. Checking saved results is a
read; refreshing never replays sends. Resend is explicit, reuses a current
pending invitation, and warns that an earlier uncertain delivery may have
succeeded. Attempts still active are held for fifteen seconds; an interrupted
attempt can then be explicitly retried against its existing invitation. Old
callbacks cannot replace a newer attempt or confirmed acceptance. The email hook
also rechecks its current attempt before starting a send. Expired,
revoked, role-mismatched or unresolved creation states need review in Team.

Completion requires the saved batch and accepted invitations, or an explicit
confirmed choice to continue with unresolved invitations. That choice retains
the saved crew and explains that pending requests may still finish. A lost
completion acknowledgement can be checked or retried without replaying saves.
The old unchecked completeOnboarding RPC is removed. Deploy matching Worker and
web assets, and reload existing setup tabs.

After building, run both rehearsals:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-save-recovery.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-team.mjs
```

Validation passed 2,058 unit tests, 745 Worker tests, four coverage-gate tests,
web typecheck and production build. Twelve new Worker tests use real auth,
permissions, invitation APIs and D1, replacing only email transport. They cover
concurrent submissions, transaction rollback, replay after deletion, rejection,
unknown delivery, explicit resend, stale callbacks, access revocation, invalid
scope and explicit completion. Client tests cover bounded reads/writes, lost
responses, duplicate submits, unmount, partial success and competing tabs.

The compiled browser rehearsal passed a rejected save, an actual committed save
with its response withheld, refresh recovery, provider rejection, explicit
resend of the same invitation, a committed completion with its response withheld,
and canceled/confirmed continuation with unresolved invitations. Local email
capture and final D1 inspection proved one crew record per scenario, two
invitation records with three send attempts in recovery, and one unresolved
invitation in the explicit-skip scenario. No browser errors occurred. Recovery
and dialog controls passed at 320/768/1440px; all six phone screenshots were
inspected. The earlier form-validation rehearsal also passed.

No deployment, migration, external email or native release is included. Setup
navigation, role/workspace checkpoints and seeding recovery remain open.

### Setup rundown creation and recovery

The old seed wrote the show, checklist and cue notes separately, then recorded
completion. A forced checklist failure reproduced a partial show left behind.
The replacement commits every row and the receipt in one D1 transaction. A
conditional receipt chooses one concurrent request; subsequent requests return
the actual saved template and date without updating or recreating any rows.
Existing edits, deleted items, cue columns and same-date shows are preserved.
Legacy partial seeds, unreadable receipts and removed shows require review.

Reads and writes have ten-second client deadlines, cancellation and rejection
of late replies. Checking a result only reads. Retry keeps the original date
and template, including across midnight. The build step shows real pending
status and timestamped uncertainty instead of asserting that a failed request
created nothing or that the show clock is armed. Continue without adding a
rundown records a blank choice; if a previous request already won, the actual
saved result appears for review. A later original request cannot replace a
confirmed blank choice. Refresh only reads server progress.

No migration or native build is required. Deploy matching Worker and web assets
and reload existing setup tabs. The retired sequential seed interface is
removed. Default cue-column initialization shares the new transaction without
changing its existing initialize-once behavior for other callers.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-rundown.mjs
```

Verification passed 2,064 unit tests, 757 Worker tests, four coverage-gate tests,
web typecheck and the production build. Twelve real auth/D1 Worker tests cover
rollback through the final cue insert, competing templates, blank choice races,
edit/deletion preservation, legacy partial/corrupt data, permissions and plan
limits. The final marker-validation adjustment passed those twelve tests again.
Eight client hook tests cover deadlines, read-only recovery, missing replies,
midnight, duplicate submission, scope changes and unmount. Four component tests
verify pending, uncertain, competing and legacy results.

The compiled Worker/Chrome rehearsal passed rejected writes, an actual committed
seed with its response withheld, read timeout/retry, late replies, explicit blank
continuation, a delayed original request arriving after the blank choice, and
refresh without writes. Final D1 inspection found one show, nine items, five
checklist entries and four cue notes in recovery; both blank scenarios created
none. Existing fixture shows stayed unchanged and setup was not prematurely
marked complete. No browser errors occurred. Controls passed at 320/768/1440px
and six phone screenshots were inspected. The existing team form rehearsal also
passed against this build with real crew/invitation saves and local email capture.

Nothing is deployed. Setup Back/exit, role/workspace checkpoints, organization
creation recovery and the wider Phase 2 gate remain open.

The first CI run, 42346617800, failed the continuous-feed ProPresenter prop test.
Its fixture treated the initial HTTP feed response as cue completion. If a
WebSocket frame reserved the cue first, HTTP returned while Clear Props was
still awaiting acknowledgement. The fixture could then stop its feed too early.
A deterministic test holds the HTTP frame until Clear Props is pending and
reproduced that premature completion. The fixture now waits for the relay's
actual cue-result broadcast before stopping its feed, for success and failure.
Production timing, stall detection and assertions are unchanged. Failure
assertions include the cue result and received commands to expose any remaining
cause rather than hiding it behind a partial object comparison.

The regression failed before the fix and all 17 ProPresenter tests passed with
coverage afterward. Full coverage passed 2,064 unit and 758 Worker tests and
the existing coverage thresholds. The final ES2022-compatible helper also passed
the full plain web suite and typecheck. This correction requires no deployment.

### Setup workspace and role checkpoints

Setup now advances past workspace and role selection only after the server
confirms the choice. Failed saves preserve custom names and selected roles.
Reads and writes have ten-second deadlines, cancellation, timestamped errors,
read-only result checks and explicit same-request retries. A recovered saved
choice offers Continue; a late response cannot advance the wizard. Reload reads
the confirmed choices without replaying writes. Team roles remain personalization
only and never change the owner's membership permissions.

Workspace writes atomically compare a saved revision before committing all
fields and their receipt. Settings and mobile workspace writes advance that same
revision, including changes back to an earlier value. Roles compare the current
per-user receipt. A delayed request or retry returns the newer saved choice for
review instead of overwriting it. Selecting again is an explicit new request
against the reviewed revision. Replays cannot resurrect old field values, and a
reused current request ID with different content is rejected. The existing
workspace normalizer serves all callers; initialization-only guards now work
atomically in both the D1 and Prisma entry points.

The old unchecked saveWorkspaceType and saveOnboardingRole RPCs and their UI
callers are removed. Shared workspace schemas live in a browser-safe contract
module. Deploy matching Worker/web assets and reload existing setup tabs so all
workspace writers participate in revision checks. No migration or native build
is required. Back/exit and organization-creation recovery remain open.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-choices.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-rundown.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-team.mjs
```

The regression reproduced a rejected role save advancing the rendered wizard.
Eleven real auth/D1 Worker tests cover normalization, permissions, concurrency,
receipt replay, last-field rollback, per-user roles, initialization guards and
changes from actual Settings/mobile entry points. Eight hook tests and three
rendered-wizard tests cover bounded requests, duplicate submission, missing/late
acknowledgements, scope/unmount cleanup, failed-save navigation and kept drafts.

The compiled Worker/Chrome rehearsal passed initial-read timeout/retry, rejected
writes, committed writes with lost responses, read-only recovery, explicit
continuation, queued old writes after newer Settings/role choices, safe retry,
reselection and refresh without writes. Final D1 inspection confirmed normalized
custom names or the latest school workspace, the selected role, unchanged owner
membership and no seed/completion marker. No browser errors occurred. Controls
passed at 320/768/1440px and all seven phone screenshots were inspected.

Final validation passed 2,074 unit tests, 769 Worker tests, four coverage-gate
tests and web typecheck, including the parent ProPresenter fixture correction.
The production build passed its client budgets. Existing rundown recovery and
team form rehearsals also passed against that build, including real local D1
saves and captured invitation delivery. No deployment or external email occurred.

### Setup Back, Exit and Resume

Setup now has Back and Exit controls. Back keeps custom workspace fields and
team rows in this tab. Revisiting the organization step shows its saved identity
instead of a second creation form. The header reflects the six steps, including
reviewing an existing rundown result. Exit describes saved versus unsaved data;
Cancel retains drafts, while confirmation opens the workspace without marking
setup complete. Browser Back uses the same confirmation for unsaved work, and
closing or reloading a dirty tab uses the browser's unload warning.

Owners can resume unfinished setup from Settings → Workspace. That link reads
the selected organization's progress with an eight-second deadline, cancellation,
and an explicit read-only retry. Completed setups and nonowners get no resume
link. Reload resumes saved progress; it does not retain unsaved form entries.

Late role/workspace replies cannot advance after Back or Exit. Team completion
while a confirmation is open retains its result for explicit continuation.
Organization creation keeps the current active organization throughout setup.
Leaving aborts its client requests; a reply arriving during Exit cannot activate
the new workspace or start further setup writes. A canceled Exit can continue
using the already-created organization. Requests already sent may still commit.
Creation receipt recovery is described below.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-navigation.mjs
```

The compiled Worker/Chrome rehearsal passed Back/return with workspace and crew
drafts, a real role commit with its response held until after Back, Exit cancel
and confirm, Settings Resume, a canceled native reload warning, and
canceled/confirmed browser Back. It also
created actual organizations with replies held through departure or delivered
while the Exit dialog was open. Final D1 checks found one organization per
creation attempt, unchanged active workspace, no unintended crew and no setup
completion. Creation now commits the setup-start marker with the organization,
so a lost reply still leaves resumable progress. No external email or browser
errors occurred. Controls passed 320/768/1440px bounds, 44px
minimum targets and hit tests; phone captures were checked after animations.

Tests reproduced the pending-Exit activation race before its fix. All 31 focused
navigation/team/resume tests passed, followed by 2,089 unit tests, 769 Worker
tests, four coverage-gate tests, web typecheck and production build. This work
requires matching web/Worker assets but no migration or native build. The wider
Phase 2 gate remains incomplete. The existing choice, rundown, team-form and
invitation/completion-recovery browser rehearsals also passed against this build,
including actual local saves, captured email delivery, response loss and explicit
continuation with unresolved invitations. Nothing has been deployed or released
here.

### Atomic organization creation

The organization-create endpoint previously inserted an organization, then its
owner, then trial defaults and the active session separately. A forced owner
insert failure reproduced an organization with no owner and no trial. Creation
now commits the organization, owner, fourteen-day trial, cloud flag and optional
active-session change in one D1 batch. Failure through the final session update
rolls all of it back, so retry can use the same address.

The existing `/api/auth/organization/create` API and SDK shape remain available
to web and mobile clients. The organization plugin retains its schema,
middleware, origin checks, rate limits and cookie hooks; its creation endpoint
uses the app-owned transaction. Verified-email policy is checked against a fresh
session and again inside the write. Revoked, expired, unverified or mismatched
sessions cannot create rows. Creator identity comes from the session. Names are
trimmed and addresses use the existing workspace-address validator. Duplicate
addresses return a conflict message; unknown failures report that creation was
not confirmed. Trial prices, duration and plan limits are unchanged.

Creation dates use Prisma's ISO format. The first prototype used numeric dates,
which sorted ahead of existing ISO rows and changed the fallback workspace when
there was no active selection. The real-browser navigation rehearsal caught it,
a deterministic test reproduced it, and the final transaction preserves the
previous first workspace. Session expiry checks accept both date representations.

Sixteen actual HTTP/D1 tests cover owner and final-session rollback, retry,
concurrent address claims, metadata, actor identity, trial duration, native
activation defaults, preserved active workspace, fresh verification, revocation,
expiry, input validation and first-workspace ordering. Final web verification
passed 2,089 unit tests, 782 Worker tests, four coverage-gate tests, typecheck and
production build.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-organization-atomic.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-organization-creation.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-navigation.mjs
```

All three compiled Worker/browser rehearsals passed. The new rehearsal forces a
real owner-insert failure, preserves the form, then creates a valid workspace.
Final D1 inspection confirmed no failed organization, exactly one owner and the
same fourteen-day trial for each successful creation. Native default activation,
Expo origin, foreign-origin rejection and the ten-request rate limit passed.
No browser errors or external email occurred. The error and retry control fit
320/768/1440px with reachable 44px targets; the phone screenshot was inspected.

The atomic-create change itself needs no migration or native release. The
receipt recovery below adds a migration. Nothing has been deployed here.

### Organization creation receipts and bounded recovery

Apply `0053_organization_creation_receipts.sql` before deploying this Worker and
web build together. Keep `applied-remote.txt` unchanged until production is
actually migrated. Old mobile clients retain the existing creation API and
activation behavior; no native release is required for the setup UI change.

Setup saves an opaque request UUID in its URL before sending a creation request.
The user-scoped receipt, organization, owner, trial and setup-start marker commit
in one transaction. Retrying identical choices returns the same workspace.
Different choices on an already-committed request require reviewing its saved
result. Replays read current details without restoring names, trials, membership,
checkpoints or active-session selection. Organization deletion leaves a receipt
that prevents resurrection; account deletion removes its receipts.

Creation, result checks, address checks, verification resend and continuation
stop waiting after ten seconds. Failures retain the entered form and show a
retry. A lost response offers **Check saved workspace** and **Retry creation**;
retry sends the same identity and choices. A refresh reads the URL's receipt
without writing and requires **Continue setup** before advancing. An empty read
is explicitly not proof that an earlier request cannot still finish. Editing
choices after an empty result retains the same identity, so a competing late
commit cannot create a duplicate. Exit and unmount ignore late replies.

The result endpoint requires a fresh session, scopes receipts to its user,
checks current ownership and sends `Cache-Control: private, no-store`. Unknown
errors after commit remain unconfirmed outcomes. Only the actual unique-address
constraint is reported as an address conflict. A forced incompatible metadata
write reproduced a committed organization being misreported as a conflict before
this correction.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-organization-recovery.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-organization-atomic.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-organization-creation.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-setup-navigation.mjs
```

The recovery rehearsal withholds replies after actual D1 commits, then exercises
identical retry, refresh, a stalled result check and explicit continuation. It
checks final organization, owner, receipt and checkpoint counts, no completed
setup or external email, and controls at 320/768/1440px. The other rehearsals
retain owner-insert rollback, ordinary mobile creation, auth policy, rate limits,
Back/Exit/Resume and unchanged active-workspace coverage. Phase 2's broader
acceptance gate remains open; these changes are not deployed or released.

Final validation passed 2,097 unit tests, 794 Worker tests, four coverage-gate
tests, typecheck and the production build. All four browser scripts above passed
against that build; final phone error screenshots were inspected. The focused
suites cover 28 real HTTP/D1 creation cases and 18 setup component cases.

### Chat invite outcomes and sign-in return

Planning invites redirect from the route loader after checking the current
session, intended recipient and current chat permission. They use the workspace's
current address resolved from its signed ID. Authorized users no longer receive
the wrong-member card in server-rendered HTML. Invalid signatures, authenticated
expiry, unavailable workspaces, signed-out users, wrong accounts and removed
access have distinct outcomes. Read failures use the existing bounded route
error and Retry path; they are not presented as expired links.

Chat tokens require validated scope and finite integer expiry. Existing kiosk
callers retain their separate expiry policy. A narrowly bounded Planning-token
path exception preserves links for up to fifty recipients through sign-in;
ordinary return destinations retain the existing length and safety limits.
Guests connect only after entering a name and joining. Token changes clear that
identity, and expiry removes the guest chat and closes its connection.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-chat-invites.mjs
```

The compiled Worker/Chrome rehearsal passed the authorized HTTP redirect without
a wrong-member flash, actual long-link sign-in return, a held read followed by
Retry, guest connection and expiry, and membership removal. Notice and recovery
controls passed 320/768/1440px bounds and hit tests with 44px targets; phone
screenshots were inspected. No browser errors or external email. Full validation
passed 2,122 unit tests, 800 Worker tests, four coverage-gate tests, typecheck and
the production build.

Workspace removal is reported as unavailable, not revoked. The follow-up below
adds individual link revocation. The compound auth requirement remains open for
organization invitation recovery and remaining landing work. The invite-state
change itself requires no new migration or native release and is not deployed.

### Individual chat-link revocation

Apply `0054_chat_pass_revocations.sql` before deploying the matching Worker and
web assets. Keep the remote migration manifest unchanged until that migration
is actually applied. This work is not deployed and requires no native release.

Production leaders can use **Disable a chat link** in Chat to paste an existing
crew pass or Planning invite, review its consequences and confirm. The command
requires a fresh session, current leadership/chat access and a valid signed link
from that workspace. It stores only an organization-scoped digest, expiry,
revocation time and actor. Repeated commands keep the original receipt. Existing
web/mobile links use the same check. The creation recovery below adds a unique
nonce to newly issued grants while preserving existing links.
The digest covers authenticated signing input so equivalent base64 signature
spellings cannot bypass revocation. Malformed token structure is rejected.

The join pages distinguish revoked from invalid, expired and unavailable links.
Crew socket upgrades, attachment reads/deletes and uploads consult the denylist.
The Worker attaches the verified digest to guest sockets; each message checks
current revocation. A committed revocation pushes a relay authorization refresh,
closing affected guests while preserving other guests and members. Guest read
leases expire after sixty seconds, with an earlier alarm refresh if the push is
lost. Broadcasts continue to use synchronous lease checks without per-recipient
D1 reads. Old socket attachments without a digest must reconnect through the
gateway. Chat attachments use private/no-store responses.

The client stops reconnecting a revoked guest token and displays the revoked
notice. It also rechecks a link after connection failure. The management dialog
bounds requests at ten seconds, retains unconfirmed input and offers explicit
Retry. A missing relay acknowledgement is reported separately from the committed
revocation. Revoking a Planning invite does not remove normal member access.

Run after building:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-chat-revocation.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-chat-invites.mjs
```

The two-browser rehearsal withholds an actual committed revocation reply, checks
that the guest disconnects, retries the same command and inspects final D1 rows.
It verifies file read/delete/upload and new socket rejection, Planning's revoked
notice, retained member access, revocation between loading the name form and
joining, and zero external email. Controls pass bounds,
hit tests and 44px targets at 320/768/1440px; phone screenshots are inspected.
The earlier invite rehearsal still covers sign-in return, expiry, membership
removal and read Retry. Both run against the compiled Worker with disposable data.

Browser resizing also reproduced the composer changing its observed height
inside ResizeObserver, raising Chrome's undelivered-notification error and the
app's runtime-error banner. Height changes now run in a coalesced animation frame
with unmount cleanup. A deterministic regression failed before the fix and passes
after it. Mobile room/link controls occupy their own row, keeping the chat title
readable. The final browser rehearsal has no runtime errors.

Full validation passed 2,133 unit tests, 808 Worker tests, four coverage-gate
tests, typecheck and the production build. Worker coverage includes revocation
push/alarm/message checks after hibernation, stale read-lease cutoff, another
unrevoked guest, cross-workspace denial, current leadership/session checks,
idempotent receipts and equivalent signature spellings. Phase 2 remains open.

### Chat-link creation and share recovery

Apply `0055_chat_pass_creation_receipts.sql` after migration 0054 and before
releasing matching web and Worker assets. The remote manifest is unchanged;
this work is not deployed. The receipt stores signed claims without the bearer
signature or signing secret, scoped by workspace, actor and request ID.

New creations have a unique nonce, including two creations within the same
second. The previous issuer could recreate an already-revoked token. Retrying
with the same request ID and choices recovers the same token and original expiry;
changed choices, expired grants and revoked grants cannot reuse that request.
Current leadership, chat permission, session and selected membership are checked
again. Web and mobile API issuance share this implementation. Older mobile
clients without a request ID still work and receive distinct new grants; their
native share UI does not yet offer the web dialog's recovery controls.

Both web share forms use the shared Dialog with Escape, focus containment,
labelled inputs and 44px controls. Requests have ten-second deadlines. Closing
preserves entered choices and an unconfirmed request; reopening offers explicit
Retry. Late responses cannot replace newer state. Starting a new link is an
explicit choice and does not revoke an earlier link. Ready links expose a QR,
selectable text, expiry and bounded copy with visible error and Retry. Links
above the QR byte budget keep a text/copy fallback instead of crashing the
encoder; the long-link regression failed with `Data too long` before this fix. Known
expired or locally revoked links stop displaying as ready.

Planning notifications use the creation nonce as their deduplication key. The
result reports confirmed inbox rows separately from link creation. Failed or
partially saved notifications can be retried against the same link without
resetting read/dismissed notifications or pushing duplicate inbox inserts. A
confirmed inbox save does not claim device push delivery.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-chat-creation.mjs
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-chat-invites.mjs
```

The creation rehearsal uses real auth, a compiled Worker and disposable D1. It
withholds actual committed responses, exercises identical Retry and closing
while pending, injects a real notification insert failure, restores it, and
checks final receipt/notification counts. Clipboard denial leaves a selectable
link. Controls pass bounds and hit tests at 320/768/1440px; phone screenshots are
inspected. These are foreground rehearsals; focus emulation prevents macOS
window occlusion from suspending animation-frame measurements. No production
data or external email is used.

Full validation passed 2,143 unit tests, 815 Worker tests and four coverage-gate
tests, plus typecheck and production build. Real Worker tests cover concurrent
requests, committed receipt read failure, original expiry, revocation, current
authority, actor/workspace isolation, partial notifications and web/mobile
parity. Organization invitation recovery, remaining auth/landing work and the
wider Phase 2 gate remain open.

### Workspace invitation responses

Apply `0056_invitation_responses.sql` after migration 0055 before deploying
matching web and Worker assets. The remote manifest remains unchanged. This
change has not been deployed or released.

Accept and Decline now save a recipient-bound decision receipt in the same D1
transaction as the invitation status, membership and first active-workspace
selection. Acceptance releases the pending invitation's reserved capacity before
inserting membership, so a valid invitation works at the plan limit. Any later
statement failure rolls back the entire transaction. Concurrent opposite
responses have one winner; retries recover it without creating another member,
changing a later role, switching the session again or restoring removed access.
The receipt retains the original membership ID. Existing accepted invitations
without receipts can recover only while the recipient still has membership.

The Better Auth endpoints retain their schema, middleware, origin protection and
response shape. Writes recheck the current session, verified recipient and plan
capacity. The app's invitation-details RPC requires the current recipient before
returning workspace details; anonymous, unverified and unrelated accounts receive
only the appropriate sign-in or account guidance. Invitation reads are private
and non-cacheable. This does not claim a complete audit of every upstream Better
Auth invitation endpoint.

Both web invitation pages share one response card. Decline requires confirmation
and remains on screen until saved. Requests have ten-second deadlines, persistent
errors and explicit Retry or read-only status recovery. Late replies and unmounted
components cannot navigate or replace the outcome. Accepted invitations offer an
explicit Open workspace action with current-access checking and Retry. Sign-in,
signup and verification use the main auth flow with the invitation return path.
Expiry, cancellation, decline and removed membership have distinct messages.
Expiry timestamps use the existing hydration-safe device-timezone hook.

After building, run:

```sh
SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-invitation-responses.mjs
```

The compiled Worker/Chrome rehearsal uses real auth and disposable D1. It
withholds committed acceptance and decline replies, releases late responses,
recovers the saved decisions without another write, checks the invitations-list
path and reload, and verifies sign-in return and removed access. It also exercises
failed workspace opening and a stalled route read. Confirmation focus containment
and control bounds/hit targets pass at 320/768/1440px; phone screenshots were
inspected. No browser errors, production data changes or external email occurred.

Full validation passed 2,156 unit tests, 829 Worker tests, four coverage-gate
tests, typecheck and production build. Fourteen real Worker regressions cover
atomic rollback, concurrent decisions, reserved capacity, lost committed replies,
current recipient/session checks, response compatibility and membership removal.
Thirteen UI tests cover confirmation, timeout/retry, late replies, unmount,
workspace opening, expiry and server/client timezone differences. The capacity
and hydration regressions failed before their fixes. The broader Phase 2 gate
remains open.

### Landing entry and download recovery

The concept page's Product link now targets `/#product`. Hero, pricing and closing
copy state the 14-day Pro trial and no-card terms. Starter, Pro and Founding Member
prices are unchanged. The founding-offer end date still requires the owner's date
and timezone; no deadline is invented or marked complete. Annual billing remains
Phase 3 work.

All eight native download cards have static links. The landing Worker checks the
approved manifest before streaming a file or redirecting to an official store.
Unavailable builds and storage failures get distinct, script-free recovery pages
with Try again, View downloads and Open web app. Programmatic error responses stay
JSON, HEAD errors stay bodyless, private object keys are not reflected, and recovery
HTML uses a restrictive CSP. Manifest/object lookup and browser status requests
have eight-second deadlines. The artifact body can continue streaming normally.

Mutable download ID URLs now use `Cache-Control: no-store`. Browser rehearsal
exposed the previous immutable one-hour cache skipping a fresh release check.
The final test replaces the manifest's artifact and downloads the new bytes from
the same URL. R2 object immutability and existing range/attachment behavior remain.
Download labels are at least 14px, metadata at least 12px, including mobile overrides.

Validation: `pnpm --filter @showpilot/landing verify` passed type generation checks,
typecheck, 31 tests, static/concept build and Wrangler deployment dry run. The full
web suite passed 2,156 unit and 829 Worker tests plus four coverage-gate tests; web
typecheck passed. `node apps/landing/scripts/smoke-download-fallback.mjs` passed
against the compiled Worker and disposable R2 with actual Chrome downloads,
JavaScript disabled, status timeout, invalid-manifest recovery, same-URL release
replacement and the concept Product anchor. Release-site HTTP smoke also passed.
Controls passed 44px bounds/hit checks and readable-label checks at 320/768/1440px;
final phone screenshots were inspected. No browser errors or production writes.

PR #184's invitation CI run 42362831479 passed both main CI and Native Rust tests.
These landing changes remain a draft Phase 2 change. Nothing has been deployed,
no release manifest has been published, and the wider Phase 2 gate remains open.

### Timecode label validation

`parseTimecodeString` now requires the selected format. It rejects frame numbers
outside that rate, clock labels outside a 24-hour day and skipped 29.97 drop-frame
labels. Both colon and semicolon separators remain accepted; the selected format
controls validation. Event editing, internal start positions, song saves and cue
nudges all pass their actual format. SMPTE conversion algorithms are unchanged.

The regression reproduced `01:00:00:99` being accepted at 30 fps. Tests now cover
all supported rates, drop-frame minute boundaries and an editor draft retained
while its format changes. Full web verification passed 1,926 unit tests and 718
Worker tests, typecheck and the production build. No migration or native release
is required. The broader Phase 2 gate remains open.

### Signed-in crew attendance recovery

Crew check-in now keeps failed row, member-ID and bulk changes visible with a
timestamp and Retry. Entering an ID selects a person; a separate action confirms
check-in or check-out. Requests expire after ten seconds without acknowledgement.
Switching between entry and roster views preserves recovery, and leaving with an
uncertain change requires confirmation.

Each request captures the intended attendance, selected record revisions and a
UUID. An atomic D1 batch records the outcome and changes only those crew records.
Retry returns the original outcome without repeating a completed write. Bulk
confirmation captures the full roster, including people outside the search; one
stale or removed member rejects the entire selection. Crew added afterwards are
excluded. Every retry checks current permission and binds the receipt to its actor.

Roster reads have an eight-second deadline and pause while the tab is hidden.
A successful write invalidates earlier reads. If its refresh fails, the page says
the change was saved and offers a read-only Retry. New changes stay disabled until
attendance is confirmed. Public and signed-in attendance share revision semantics;
the public API and existing receipt fingerprints remain compatible.

Keep `attendance-write:*` receipts for the organization's lifetime. Deploy browser
and Worker together and reload old check-in tabs: `toggleCheckIn`,
`setAllCrewCheckIn` and `checkInByMemberId` were removed after migrating every caller.
No migration or secret is required. Mobile attendance is unchanged.

After building, run
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-crew-attendance.mjs`.
The disposable two-operator rehearsal loses real committed responses, retries the
exact request, preserves subsequent attendance changes, rejects stale bulk edits
without partial writes and verifies that read Retry never sends a write. It checks
320/768/1440px controls, browser errors and final D1 attendance, including another
organization. Expected receipts: seven, including one rejected conflict.

Verification passed 1,911 unit tests, 718 Worker tests, web typecheck and the
production build. Both the crew rehearsal and anonymous public check-in regression
passed. Final phone screenshots were inspected. No deployment or migration was
performed; the broader Phase 2 gate remains incomplete.

### Organization credential encryption

Credential-valued organization settings now encrypt on write. The Settings
page returns only a configured mask and provides explicit replace/clear
controls. Blank replacement fields preserve existing credentials. Clearing
requires confirmation. Single and bulk generic save responses are masked too.
Internal chat, Slack-signature, ProPresenter and mobile consumers can read the
encrypted values. Device JSON storage and protected native credential delivery
and native configuration-file migration are implemented below.

Before deploying, apply `0050_credential_backfill_cursor.sql` and provision the
Worker secret `CREDENTIAL_ENCRYPTION_KEYS`. It is JSON with an `active` key ID
and a `keys` map from key IDs to base64-encoded, cryptographically random
32-byte keys. No key belongs in source, a public build variable, a log or D1.
Missing or malformed keys block credential creation/replacement before writes;
clearing a credential and ordinary settings edits remain available. No auth,
kiosk, Companion or Bridge key is substituted for the encryption key.

Each value has a new random AES-256 data key. AES-GCM encrypts the value and
wraps its data key separately, using independent 96-bit nonces and 128-bit tags.
Authenticated data binds both operations to the organization, setting key or
device ID and nested field path, format version and wrapping-key ID. Stored
values have an `spenc:v1:` prefix. Copying an envelope between identities fails.

Existing plaintext organization credentials remain readable during migration.
Each scheduled run scans at most 100 setting rows, encrypts credential-valued
rows and saves a numeric checkpoint. At the end it starts another sweep;
compare-and-set updates preserve concurrent edits/deletion. The Bridge API-key
migration remains separate and hashes those keys. No production migration or
secret has been applied by this implementation work.

After a complete sweep, run the counts-only audit from the repository root:

```sh
node apps/web/scripts/audit-credential-settings.mjs --remote
```

It selects only setting names and aggregate counts, never values. It exits
nonzero if any nonempty organization credentials remain in plaintext or use
an unknown envelope prefix. `encrypted` counts the supported prefix; it is not
a decryption test. Also verify configured integrations with their saved
credentials. Device settings and token tables have separate verification.

For rotation, retain the prior key in the map, add a newly generated key and
make it active. New values use the new key; existing values can still be read
and explicitly re-encrypted. The scheduled plaintext migration does not rotate
existing envelopes. Do not remove an old key until all dependent ciphertext and
recovery backups have been migrated. Keep compatible Worker code and keys
available together for rollback; a pre-encryption Worker cannot consume these
values. A bulk key-rotation migration remains outstanding.

Device settings use the same keyring and cursor table. Each scheduled run scans
at most 100 device rows and encrypts credential fields, including nested JSON,
arrays and adapter password fields. Compare-and-set writes include organization,
device, adapter and previous settings; concurrent changes are revisited on the
next sweep. Invalid settings remain masked on reads and are counted in a
migration error without logging their contents. Repair those rows before
claiming a complete backfill. The migration does not alter device timestamps.

Web device list/detail/create responses contain masks. Mobile configuration
responses retain `secretConfigured` with empty credential values. Web and mobile
edits preserve omitted, blank and masked credentials; `clearCredentials` names
the field paths to remove explicitly. Changing adapter starts with fresh
settings. New credential writes fail closed if the keyring is missing; existing
ciphertext can be kept or cleared without it. Authenticated device operations
and timecode automation decrypt only after resolving the authorized device.

Browser controls for devices with saved credentials now address the device ID
through the server. They require the selected venue Bridge and an approved
destination. Password-free devices retain their direct connection behavior.
Closing a control panel stops its polling and listeners; only the explicit
Disconnect action disconnects the shared venue device. Install a protocol-3
Bridge before deploying this Worker. Keep this Worker, the keyring and a
protocol-3 Bridge together for rollback.

After building web and the native sidecar, run the disposable local rehearsal:

```sh
node apps/web/scripts/smoke-device-credentials.mjs apps/bridge-desktop/src-tauri/binaries/showpilot-bridge-aarch64-apple-darwin
```

It verifies actual UI writes, encrypted D1 values, masked read/save responses,
an authenticated browser action through the compiled Bridge, protected native
transport, blank-edit preservation, confirmed clearing and responsive controls.
This is not a production backfill or a physical OBS/PJLink hardware test.

### Private ProPresenter configuration and slide feed

Browser configuration reads return only host, ports and enable flags. Desktop
provisioning checks the existing API-key permission and passes only the Bridge
installation details to the native supervisor. Neither path returns the saved
ProPresenter password. The selected native Bridge requests its configuration
from the Worker, which reads the organization setting internally, checks the
approved destination, records the connection audit and encrypts delivery for
that native connection. Standby installations cannot request this delivery.

Use matching Worker and native sidecar builds from this change set. The new
automatic configuration request is part of the unreleased protocol-3 stack;
an earlier protocol-3 build does not implement it.

Browsers observe normalized slide events through a read-only ProPresenter
socket plus a visible-tab snapshot refresh. The socket requires lower-third
trigger or rundown-control permission, filters unrelated device traffic and
rejects all control writes. Explicit slide clears remove the preview;
connection loss retains the last confirmed slide and reports the error.

After building web and the native sidecar, run:

```sh
node apps/web/scripts/smoke-propresenter-private.mjs apps/bridge-desktop/src-tauri/binaries/showpilot-bridge-aarch64-apple-darwin
```

The fixture uses a local password-protected Stage Display server, not physical
ProPresenter hardware. It also replaces and clears a saved password while the
native target is connected, rejects an incorrect password and verifies recovery.

After saving connection settings, choose **Apply & test** in the ProPresenter
integration card. This sends the saved configuration through the protected
native path even when the target is already connected. Matching configurations
reuse the connection; changed passwords or API ports replace it. Old callbacks
cannot resolve the replacement operation or clear the retained lyric preview.
Stage Display is ready only after authentication succeeds. REST-only operation
and fallback from an unavailable Stage Display socket remain supported; an
explicit Stage Display authentication rejection is reported as a failure.

### ProPresenter automation cues

The catalog adds `pp-trigger-previous`, `pp-trigger-prop` and `pp-clear-props`.
Prop cues accept an exact `propName` and an optional connected `target`. The
editor supplies named fields. With multiple ProPresenter targets connected,
choose one explicitly.

A prop cue resolves the name to one UUID before changing output, clears only
`/v1/clear/layer/props`, waits 200 ms after acknowledgment, then triggers that
UUID. Missing and duplicate names fail before clearing. The sequence uses the
[documented ProPresenter API](https://openapi.propresenter.com/), never Clear All.
Its steps remain ordered with other ProPresenter cues, use distinct receipt IDs,
and stay bound to the reviewed Bridge installation. Cancellation after an output
command leaves the cue failed for explicit retry. Disabled cues cannot fire;
re-firing an acknowledged cue requires the existing Re-arm confirmation.

Use a matching Bridge build with the Worker update. An older Bridge cannot
resolve prop names, so the new prop cue will fail before clearing. Configure the
correct API port: reads can discover a working fallback port, but a lost output
acknowledgment is never retried against another endpoint. A Stage Display socket
write is not accepted as acknowledgment of a REST output command.

After building web and Bridge, run:

```sh
node apps/web/scripts/smoke-propresenter-cues.mjs
```

This uses disposable local accounts, actual browser saves and Fire controls,
both production relay implementations, the compiled ProPresenter adapter and a
local HTTP simulator. It checks all three actions and the props editor at 320px.
The transport fixture acknowledges Bridge roles and routes commands to the
adapter; it does not simulate physical ProPresenter rendering. Complete a venue
rehearsal before claiming physical-device acceptance. This catalog slice is not
a production release and does not complete the rest of Phase 2.5.

### Named rundown jumps and lighting blackout

`rundown-goto-item` selects a playable item from the current show's rundown.
It marks the previous item complete and starts the selected item at zero,
including when re-firing a completed item. Headers, deleted items and items
from another show fail without changing the live rundown. Cloud execution and
the native offline journal use the same `timer-goto` transition. Release matching
web and native builds; an older engine does not understand this command.

`lighting-blackout` selects an enabled lighting device that supports blackout.
It always sends the dedicated `blackout` command with empty parameters; a scene
or action override cannot turn it into a scene recall. Device latency is captured
when the clock starts. The connect and command steps remain bound to one Bridge
installation, and the cue succeeds only after its acknowledgment. DMX output
stays black until restored through the device controls.

Both actions use named target selectors with a ten-second loading deadline and
Retry. Disabled events cannot fire. Failed events support explicit retry, and
acknowledged events require reviewed re-arming before another fire.

After building web and Bridge, run `node apps/web/scripts/smoke-catalog-targets.mjs`.
It saves and fires both cues through Chromium, real local authentication and
relay implementations. The compiled DMX adapter sends Art-Net to a loopback UDP
receiver, which checks all 512 channels are zero and restore recovers the prior
level. The script also captures both selectors at 320px. The compiled local-show
probe in `apps/bridge/scripts/check-local-show.mjs` checks the same jump through
the native engine and reconciles its journal. These are local checks, not a
production deployment or a physical lighting rehearsal.

### Relative lyric cues

`lyrics-next-section` and `lyrics-previous-section` step from the current lyric
section using the saved song's section order. They take no target IDs or text
payload. Show a saved section first through Songs or a `lyrics-goto` cue. The
timeline's Fire control can execute either action while the clock is stopped.

Both actions share the lyrics output queue. Each reads only the current
organization's saved song, then replaces the display with one lyric update.
There is no intermediate clear. If a manual selection changes during the read,
the cue fails without overwriting that selection. A missing/deleted section or
the first/last boundary also leaves the current output visible and reports a
failure. Explicit retry and reviewed re-fire use the current section at that
time. Stepping preserves the active song load's scoped-clear ownership.

Run `node apps/web/scripts/smoke-lyrics-steps.mjs` after the web build. The script
creates a song through the built UI, shows its first section, saves and fires
both cues, and observes a separate confidence-display tab. It checks the same
lyric element remains mounted through Verse -> Chorus -> Verse, with no blank
state and preserved line breaks. It also captures the editor at 320px.
The Timecode preview and signed-in confidence display also provide Previous,
Next and Clear. Take control of the selected show in Timecode first. Each change
includes the displayed section's revision; a stale request or duplicate click
cannot skip another section. The relay rechecks membership and control after
reading the song. Display-pass visitors receive no write controls, and clean
hardware output omits the controls entirely. Confidence clients retain their
read-only display socket and never request the automation timeline.

Left/Right Arrow on the Timecode page steps lyrics, including keyboard-emulating
footswitches. Input fields, focused controls, dialogs, modifiers and held-key
repeats are excluded. The MIDI mapper offers Next lyrics section and Previous
lyrics section, using the existing arm and held-note protections. The operator
preview uses ConfidenceSlide auto-fit and preserves the saved line breaks.

The song loader's optional Clear after last cue adds a hold in whole frames,
then clears only that load's native lyrics. A later manual selection retains
its output. To clear manual lyrics from the timeline, add Clear Lyrics, which
explicitly clears the current native output. ProPresenter output also receives
a clear when that output has mapped cues; its clear applies to its current slide.
The loader explains songs without cue maps and empty maps before loading.

The browser script additionally exercises operator buttons, guarded keyboard
input, confidence buttons and Clear, and captures both views at 320px. Worker
tests cover D1 ordering/reordering, timed steps and clears, organization and
session isolation, stale revisions, duplicate clicks, deleted sections,
boundaries, disabling, the kill switch, retry and scoped clearing. Unit tests
cover request cancellation, controller note mapping, display-only visitors,
keyboard focus guards and song-loader validation. Physical footswitch hardware
has not been exercised in this check.

### Editing automation cues

The timeline Edit button opens the existing cue form with its saved time, label,
tolerance, lead and action details. Action type stays fixed. Action details stay
unchanged unless the operator selects **Change action details**, so renaming a
media cue does not require selecting its file again. Saving waits for a matching
relay revision. A lost connection or rejection retains the draft; it never
retries an edit automatically.

The relay accepts only definition fields. Identity, source key, enable state,
derived timing and execution history cannot be patched. Invalid patches fail
atomically. Edits recalculate timing, but never re-arm or fire a cue. The UI sends
the reviewed definition revision, execution state and frame rate; stale reviews
are rejected. The dialog keeps a stale draft until the operator explicitly
reloads the latest cue. Dispatching cues cannot be edited.

Timecode validation runs while typing and uses the current frame rate. Webhook
cues have a URL field; saved URL changes must pass the public HTTPS validator.
DNS resolution, webhook HMAC and the remaining fixed-schema hardening are still
Phase 3 work.

Run `node apps/web/scripts/smoke-cue-editing.mjs` against the built app. It uses
disposable accounts and a real local relay to check save acknowledgement,
identity and execution history, invalid timecode, concurrent changes, offline
draft retention, a 320px dialog and webhook URL validation.

### Structured cue fields

The event editor uses named fields instead of raw JSON. Lower thirds preserve free-text, person, scripture and style-only formats; stage and crew messages have text fields; rundown adjustments
use signed seconds. Start Item and Jump select a saved rundown item. Clear,
advance, previous, pause and resume actions need no extra payload.

Device actions select an enabled device, then an action and its typed fields.
The server returns only names, IDs and action definitions, scoped to the member's
organization and permissions. Connection settings and credentials stay private.
The editor uses the same number ranges, select options and parameter validation
as the device modules. Lighting scenes select a lighting device's scene recall
action. Explicit target edits replace older top-level target aliases; metadata
edits preserve their effective destination. Editing does not re-arm a cue.

Lyrics cues select a saved song and section, preview its text, and save the
complete section payload including the next section label. ProPresenter slide
cues select a saved imported presentation and its mapped section; an unmapped
section cannot be saved. Next, Previous and Clear expose the optional connected
ProPresenter target. Loading selectors is bounded to ten seconds, errors offer
refresh, and late responses cannot replace choices from a newer workspace or
song selection.

After building, run `node apps/web/scripts/smoke-cue-fields.mjs` and
`node apps/web/scripts/smoke-timecode-latency.mjs`. These use disposable local
accounts and real saved songs/devices. They exercise structured saves, lyric and
stage output, narrow layout and device timing. They do not test physical device
rendering. Unit and Worker tests cover typed parameters, stale responses,
missing mappings, target changes, organization isolation and credential masking.

### Route loading recovery

Each route guard, loader and page-code preload has a twelve-second deadline on
the browser and server. A timeout reaches the shared recovery screen; a late
result cannot complete the expired load. Navigation cancellation propagates to a
child abort controller. Organization, authentication, Board and Timecode reads
pass that signal to their requests. Cancellation cannot undo server work that
already started. Preloading a link no longer changes the active organization.

Retry waits for the router's actual loading state, including when invalidation
remounts the error screen. The screen timestamps failures and provides full-page
Reload and workspace links, with 44px controls and no decorative card on phones.
Route deadlines cover navigation; component-owned lists and mutations still need
their own bounded recovery paths and remain in the Phase 2 audit.

After building, run `node apps/web/scripts/smoke-route-loading.mjs`. It holds real
Board and Timecode responses, retries while reads remain stalled, releases late results,
navigates away from a pending Chat load, and pauses an actual page-module download
in Chrome. It checks recovery without reload and Retry reachability at 320px.
Run `node apps/web/scripts/smoke-rundown-handoff.mjs` for the navigation/write
regression. Both use disposable local accounts and data. No migration or native
build is required; these changes are not deployed by a feature-branch push.

### Settings list recovery

Companion tokens, recent webhook events, kiosk teams/roles, kiosk tokens and
roster weeks use eight-second read deadlines with cancellation, timestamped errors
and read-only Retry. Initial failures do not render a false empty state. Confirmed
lists remain visible during refresh failures. Kiosk tokens are reachable even
when the independent organization/roles read is unavailable.

After token creation or revocation is acknowledged, invalidate any pre-write read
before refreshing the list. A stalled refresh cannot lose a newly issued token or
repeat the acknowledged write. Roster weeks have separate read/draft lifetimes;
late replies from another week are ignored and refreshes preserve local edits.
Companion waits for the browser origin before offering copyable recipes, so direct
entry on a preview or alternate origin hydrates without a base-URL mismatch.

After building, run `node apps/web/scripts/smoke-settings-list-recovery.mjs` using
its disposable local fixture. It delays actual responses, creates/revokes a real
fixture token, changes roster weeks,
retains a draft and hit-tests Retry at 320/768/1440px. It checks the persisted token
and revocation in local D1 after stopping the fixture server. No migration or native build
is needed. A reported Wrangler proxy exit can trigger one fixture restart, but
only after its process has actually terminated; browser state is preserved and
read Retry must recover without repeating a write. A failure while the server is
still running is not retried by the fixture. This does not complete the product-wide loading/mutation audit:
Checklist and Incident recovery are covered below. Remaining Settings reads and
write confirmation/recovery still require follow-up.

### Checklist confirmation and recovery

Checklist and smart-draft reads use eight-second deadlines, cancellation and
separate read-only Retry. The list retains confirmed checks during an outage;
changing shows hides the previous show's entries until the new read completes.
Failures do not render a false empty state. Suggestions remain selected across
refreshes, and leaving a draft or uncertain save requires an explicit choice.

Web checklist add, completion, department, removal and smart-draft application
now use one captured operation with a request ID. Confirmation expires after ten
seconds; Retry reuses that exact operation. An atomic D1 receipt and conditional
writes prevent duplicate additions, stale edits and recreation after deletion.
Smart-draft entries and templates commit together or roll back together. Every
retry checks permission again. Receipt rows use the existing app_setting table;
there is no migration. Do not prune these receipts while clients may retry them.

Department edits made through the mobile API also advance the shared revision,
so changing a category away and back cannot make an old web edit look current.
The mobile API's request shape is unchanged; this does not add receipts to its
separate mutation endpoints. Web saves finish on acknowledgement and invalidate
any older read. A failed follow-up refresh cannot turn that success into another
save attempt. Checklist controls have labels, visible delete actions and 44px
hit targets, with wrapping rows and forms at narrow widths.

After building, run `node apps/web/scripts/smoke-checklist-recovery.mjs`. It uses
real authentication, local D1 and Chrome with disposable data, loses responses
after actual writes, retries captured operations, replays an old add after
removal, checks draft/navigation and show isolation, and measures controls at
320/768/1440px. It inspects persisted entries and receipts after stopping the
server. The verified run completed without proxy restarts or browser errors.
The fixture permits at most one restart only after a confirmed terminal local
proxy process, never to hide a timeout while the server remains running.

Deploy browser and Worker together and reload cached clients: the five old web
checklist mutation RPCs were removed after migrating their only caller. No native
binary is required. Feature-branch pushes do not deploy this change. Incident
recovery is covered below; remaining product-wide loading, mutation and
accessibility audits remain open.

### Incident confirmation and discussion recovery

The web Incident Log reads incidents, comments and reactions as one org/show
snapshot. Reads expire after eight seconds and show timestamped, read-only Retry.
Confirmed discussion and local drafts remain visible during same-show failures;
changing shows hides the previous discussion. Loading never accompanies a false
empty state. Relay hydration waits for the same pending read instead of issuing
a second snapshot request. Recovery controls remain in the sticky header, and
inside the report dialog while it is open.

Report, comment, reaction and delete commands capture an operation and request
ID before sending. After ten seconds without acknowledgement, Retry sends that
same operation. D1 commits its receipt and conditional mutations atomically;
permission is checked again on every retry. Replaying a report after deletion
acknowledges the old save without recreating it. Reactions send desired state
and the last observed own-reaction ID, so Retry cannot toggle twice or overwrite
a newer reaction intent. Deletion compares the current incident fields and
comment count before removing the incident, discussion and related reactions.
A stale edit requires reviewing the refreshed log before trying again.
Existing mobile incidents without a show keep their discussion and delete
controls. Their reads and commands match only date-only rows for that organization
and date; they cannot touch another show's incident. Creating a new web report
still requires selecting a show. Database and built-browser tests cover this path.

Acknowledgement completes a save independently of the subsequent refresh.
Retrying a failed read never repeats that write. A newer comment draft survives
confirmation of the older comment. Drafts and uncertain saves require an explicit
choice before leaving. Report fields are labelled and use the shared focus-trapped
Dialog. Delete actions are visible without hover; discussion controls and
reaction chips have 44px targets, with a bounded reaction picker on phones.

Only the request that claims a new applied receipt schedules its notification.
Cloudflare waitUntil preserves the existing best-effort inbox/push delivery
without holding the save response open. This is not a durable notification
outbox. The separate mobile mutation endpoints retain their current behavior.

After building, run `node apps/web/scripts/smoke-incident-recovery.mjs`. The
rehearsal uses real authentication, local D1 and Chrome with disposable data. It
withholds real write responses, retries exact operations, checks navigation and
show isolation, measures discussion/form controls, and inspects persisted
reports, receipts, notification recipients and deletion cleanup after stopping
the local server. The verified run retained one report, ten write receipts and
exactly four expected notifications, with no browser errors or document reload.
Controls passed at 320/768/1440px and the report dialog at 320x480; screenshots
were inspected. The full suite passed 1879 unit and 674 Worker tests, typecheck
and production build. The initial full run timed out in an existing five-second
timecode isolation test; the rerun passed without changing that test or timeout.
Run the checklist recovery rehearsal too when changing the shared operator-read
hook. On this build, two diagnostic runs completed the Checklist browser
assertions, but a complete browser-plus-D1 rerun remains unverified. Several
runs stopped after Wrangler ProxyWorker reported Network connection lost and
the CLI exited with code 1. The fixture still permits only one restart after
confirmed terminal process state. Debug logging cannot pollute JSON query output
now, and the query helper passed a direct fixture check. Responsive target checks
wait for reachability without changing required dimensions or app deadlines.
The proxy failure remains a separate verification follow-up.

Deploy browser and Worker together and reload cached clients: the old web
incident/comment/reaction RPCs were removed after migrating their sole caller,
and the build permission contracts now check their replacements. No migration
or native binary is required. Keep incident-write receipts while clients may
retry them. Feature-branch pushes do not deploy this change; remaining Settings
writes and product-wide recovery/accessibility audits remain open.

### Workspace and Settings navigation

Settings keeps the workspace sidebar on desktop and the existing menu drawer on
phones/tablets. Back returns to the preceding resolved workspace URL, preserving
its search and hash. Switching Settings sections does not change that destination.
The destination belongs to the current organization and is held only in the live
workspace shell. Direct entry or reload has no preceding in-app page and offers
Back to Show Flow instead. Fullscreen mode still hides the sidebar.

After building, run `node apps/web/scripts/smoke-navigation-audit.mjs`. With a
disposable owner account, it clicks all 21 sidebar destinations and all 13 Settings
sections, checking the rendered content and an unchanged document marker. It also
checks separate Show Flow, calendar and rundown-editor views, Planning Room return
state, direct-entry recovery, and Settings navigation at 320/768/1024/1440px. These
checks do not establish that every form in each screen is responsive; the broader
Phase 2 audit remains open. No migration or native release is required.

### Overlay feed and display-link recovery

Overlay reads have an eight-second deadline, one active request, cancellation and
capped retry backoff. Expired replies cannot replace newer output. Network or
unreadable-composition failures retain the last confirmed graphic while its display
pass remains valid. Access rejection removes protected content and requires a new
access check. Output polling continues while hidden; ordinary operator reads still
pause in hidden tabs.

Graphics keep their DOM identity when text changes. Entry and exit frames/timers
belong to each layer and are cancelled on removal or reactivation. The renderer
uses the server's layer order and validates a complete composition before applying
it, so one unreadable layer cannot publish a partial replacement.

Settings and the Graphics library offer **Open overlay monitor**, which adds
`monitor=1` to a protected display link. That view shows connection state, failure
time and read-only Retry. The copied URL and QR code remain clean broadcast output;
that view exposes connection state in the browser title without adding diagnostic
text to the video. Do not use the monitor link as an OBS/vMix source.

Creating a display link also has a bounded read and Retry. Failed refreshes retain
an existing unexpired link, expired links cannot be copied/opened, and late results
cannot replace a newer link or cross organizations. The link field stops saying
Creating after a failure. Settings explains the QR code and both pages use 44px
copy and monitor controls.

After building, run `node apps/web/scripts/smoke-overlay-recovery.mjs`,
`node apps/web/scripts/smoke-graphics-output-recovery.mjs`, and
`node apps/web/scripts/smoke-display-deadlines.mjs`. They use disposable local data
and real Worker responses, operator edits, output hides, server outages and Chrome.
The overlay rehearsal checks the published Settings monitor link and failure/retry
at 320/768/1440px. No migration or native build is required; reload open outputs
after deploying. Kiosk-link reachability and the remaining product-wide UX audit
are still outstanding.

### Device detail and legacy overlay navigation

The Devices parent now renders a route outlet, with its library in an index route.
Opening a device detail URL mounts only that device's controls. Back and browser
history restore the library selection from the URL; a removed device shows recovery
instead of silently selecting another device. Library and detail reads retain
organization permissions and pass navigation cancellation to their requests.

The old `/:slug/streaming/graphics/overlay` route redirects to `/overlay/:orgSlug`
before the graphics library loads. The canonical renderer requires a display
session; the alias grants no new access and does not change live output. Its unused
single-graphic read RPC is removed. Deploy browser and Worker together and reload
cached clients. The separate legacy unauthenticated read fix is tracked in #153.

After building, run `node apps/web/scripts/smoke-nested-navigation.mjs`,
`node apps/web/scripts/smoke-device-connection-errors.mjs`, and
`node apps/web/scripts/smoke-legacy-display-read.mjs`. They use disposable data to
check direct routes, same-document navigation, history, permission rejection,
missing-device recovery, protected overlay access, and Bridge outage/recovery on
the detail page. Navigation controls are hit-tested at 320, 768 and 1440px. No
migration or native build is required. The wider navigation audit, Devices mutation
recovery and mobile search, and canonical overlay polling recovery remain open.

### Cue-sheet connection recovery

Cue-sheet relay clients now bound socket opening and hydration at five seconds,
retain timestamped connection errors through retries, and reconnect immediately
from Retry. They report Synced only after a scoped D1 refresh and any missing
snapshot have completed. Column notifications also use that refresh path.
Reconnect and refresh retries back off; a selected-show change cancels the old
connection and read. The shared notice also appears on Incidents and the production
and technical manager dashboards.

Cue-sheet reads have an eight-second deadline, cancel superseded requests, and
reject late results after timeout or show changes. Failed reads keep the confirmed
sheet and pending note edits. Reconnecting never resubmits note writes; Retry saves
remains the explicit write retry. Note and column write recovery is documented
below; initial route-loader deadlines are covered by the shared route policy above.

After building, run `node apps/web/scripts/smoke-cue-sheet-recovery.mjs` and
`node apps/web/scripts/smoke-relay-sequences.mjs`. Both use disposable local data.
The recovery test stops the actual Worker, holds read responses past their deadline,
switches shows with a read pending, and checks retained notes, explicit save retry,
and the Retry button's reachability at 320px. No migration or native update is
required; this change does not deploy the app.

### Cue-sheet write recovery

All note and department-column writes now use `mutateCueSheet` with a captured
request ID and operation. D1 stores an outcome receipt in `app_setting` in the
same atomic batch as the change. Repeating an applied request acknowledges it
without reapplying it. Receipts survive column deletion; retrying an old create
or note cannot resurrect deleted data. Every attempt rechecks current permission.

A note compares against the text the operator saw when editing began. Concurrent
changes produce a conflict that keeps the local draft and shows the saved text
for explicit review. Replacing it requires confirmation and a fresh comparison.
The operator can instead choose Use saved note. Rename, color and width updates
compare their original field; reorder compares the complete column order.
Column additions enforce the existing 40-column reorder limit atomically.

Write confirmation expires after ten seconds. Retry sends the exact captured
request, even if the first attempt committed and lost its response. A newer local
note waits behind that confirmation, while other cells stay editable. Column
mutations share one pending operation and show its captured intent, timestamp
and recovery control. Column deletion still requires confirmation. Note events
invalidate the authorized D1 read, so a delayed notification cannot replace a
newer note with stale text.

Run `node apps/web/scripts/smoke-cue-sheet-writes.mjs` after building, followed by
`smoke-relay-sequences.mjs` and `smoke-cue-sheet-recovery.mjs` for connection and
two-tab regressions. The write rehearsal loses responses after real commits,
checks a newer note from another tab, confirms conflict replacement, exercises
all column mutation retries and delete cancellation, and replays an old create
after deletion. It also checks the Retry control at 320px.

No migration or native update is needed. Deploy the web and Worker build together
and reload cached browser/Desktop views: the old per-action server functions
have been removed and every in-repo caller uses the captured-write API. This work
does not deploy the app or complete the product-wide Phase 2 mutation audit.

### Large rundown and cue-sheet lists

Lists above 100 rows now use measured virtualization. Visible rows plus focused,
pressed, dragged and live rows stay mounted. Keyboard neighbours include the next
editable cue row across section headings. Cue-note drafts remain in their focused
cell during scrolling, then use the existing save path on blur or Enter. No relay
or database ownership changed. Short lists still render every row.

The rundown uses its existing desktop scroller and switches to the mobile page
scroller with the responsive layout. Cue sheets retain one grid scroller for both
axes. Controls have a bounded scroll area so they cannot leave the grid with zero
height on short phones. Below 640px the identity columns scroll horizontally with
the grid; pinning that whole block would cover every editable department column.
The caller clock owns its ticks and hydrates from a loader-provided instant; clock
and row times use the same initial timezone on server and client.

Run `node apps/web/scripts/smoke-virtual-operator-rows.mjs` after building. It creates
a disposable 180-row show and checks bounded mounted counts, keyboard/drag reorder,
focused draft retention and persistence, Tab across a section heading, phone grid
height, and reachable department inputs at 320, 768 and 1440px. It also requires no
unexpected browser-error notice. The frozen lockfile pins TanStack Virtual; no
migration or native update is required. Nothing in this change deploys the app.

### Rundown clock rendering

The 10 Hz clock runs inside the memoized clock card and current-item offset.
Clock ticks no longer rebuild rundown rows, keyboard handlers or cascaded times.
Progress bars own their DOM animation, including the 350 ms reset on item change,
and stop scheduling animation frames while paused. Timer transport still uses the
existing authoritative relay commands.

Run `node apps/web/scripts/smoke-rundown-clock-rendering.mjs` after building. The
browser probe samples React's installed row handler identity while the displayed
seconds advance. It fails if that handler is rebuilt by clock ticks, then checks
warning/overtime colors, pause and next-item reset through the real local relay.
The probe requires React's DOM props metadata and fails explicitly if unavailable.
Run `smoke-rundown-layout.mjs` for the keyboard, drag, focus and five-width regression.
No migration or native change is needed. Large-list virtualization is documented
above. The broader Phase 2 acceptance gate remains separate.

### Template Studio scene and Program confirmation

Template Studio now uses the Graphics output hook for bounded reads, publication
and Clear. It retains last-confirmed Program state during an outage, timestamps
unconfirmed actions and reconciles through reads without replaying Take Live.
Clear stays reachable when the last confirmed output is empty. Take Live, Clear,
saved-scene deletion, preview replacement and preview-layer deletion require
confirmation. Preview and saved-scene changes do not alter Program.

Scene create/update/delete use the same captured-request endpoint and atomic
receipts as graphic-library mutations. Retry preserves the original content,
creation time and scene ID. A late retry cannot overwrite a later edit or restore
a deleted scene. Scene-list reads use primary D1 and are invalidated after writes
so an older read cannot replace the refreshed library. The old scene save/delete
server functions were removed after migrating their caller; reload cached clients.

Publication now records receipt ownership inside the D1 transaction. Every
immutable-row insert and Program-pointer change requires that ownership. A
recorded request can acknowledge its first publication but cannot publish again,
even when two copies were prepared concurrently and one arrives after a newer
Program. Changed content under the same request ID is rejected. The existing
array publication markers are preserved for rollback recognition; new metadata
lives under `graphic-publish-receipt:`. Old markers without metadata cannot be
replayed or used to confirm new content. No migration is required.

Run `node apps/web/scripts/smoke-template-studio-recovery.mjs` after building.
It loses scene Create/Update/Delete and Program replies after real D1 commits,
checks same-request retry and unchanged Program during preview/library actions,
cancels confirmations, stops/restarts the disposable Worker, and checks controls
at 320x480, 768x900 and 1440x900. The phone inspector has named inputs, 44px hit
areas and a reachable close button. The Studio header scrolls on small screens
so it cannot cover Clear Program in short windows. Success feedback expires; failure notices
remain until recovery or an explicit operator action.

Hook tests cover stalled/lost/superseded publication responses. Real D1 tests
reproduce the delayed-duplicate publication race, preserve old markers, verify
atomic failure rollback and exercise scene retry, deletion and organization
isolation. Saved scenes now validate every layer's controls and unique key before
saving or replacing Preview. Unreadable stored rows remain visible with a timestamp
and read-only refresh; an unavailable renderer leaves the entire current preview
unchanged. Refresh never loads a scene automatically. Confirmed deletion addresses
the stored scene key, even when the embedded ID is damaged. New draft keys are
unique, including when editing an older saved scene containing `__draft__`.

Run `node apps/web/scripts/smoke-saved-scene-recovery.mjs` after building. It seeds
bad JSON, invalid controls, an unavailable renderer and a mismatched scene ID in
local D1 only, then verifies retained drafts, repair/retry, safe deletion, unchanged
Program and 320x480 recovery controls. The scene-list response now distinguishes
readable and unreadable entries; deploy browser and Worker together and reload
cached clients. No migration is needed. The broader operator-path and product-wide
UX audits remain in progress. Nothing here deploys the app.

### Graphics library confirmation

Graphics create, edit, delete, ProPresenter import and Template Studio's Save
graphic use one validated operation endpoint. Each attempt captures its content
and UUID. A D1 batch commits the change and an organization-scoped digest receipt
together. Repeating a request acknowledges the first change without creating a
duplicate, overwriting a later edit or resurrecting a deleted graphic. Receipts
remain after deletion; they contain the digest, graphic ID and ownership nonce,
not graphic text. Every retry checks current configure permission.

The client waits at most ten seconds, retains a timestamped unconfirmed notice
and offers explicit Retry with the original request. It never retries a write
automatically. Operators can acknowledge that they checked the library before
starting a different action; closing an unconfirmed editor also requires review
confirmation. Library refreshes use primary reads, a deadline and visible Retry.
A confirmed mutation invalidates older library reads before refreshing.
Workspace changes cancel local work and reset the editor. Cancellation cannot
undo a server write that already committed.

The library's Show, Hide, Clear All, Update and Delete actions require explicit
confirmation. Deleting an on-air graphic first requires a confirmed Hide through
the existing output permission path. The graphic editor uses the shared Dialog with labelled inputs,
focus trapping, Escape, scrolling within short windows and 44px controls.

Run `node apps/web/scripts/smoke-graphics-library-recovery.mjs` after building.
It loses real Create/Update/Delete responses after commit, retries the identical
request, delivers an old library read after a newer edit, checks cancellation
and Escape, and verifies 320x480, tablet and desktop
layouts. The output-recovery and ProPresenter-feed rehearsals also pass, including
lost import confirmation without a duplicate. Four hook tests and six real D1
tests cover deadlines, stale replies, concurrent retries, atomic rollback,
organization permissions and receipts surviving later edits/deletes.

No migration is required. All callers were migrated and the old add/update/delete
server functions removed; cached browsers must reload with this release. Template
Studio scene/publication confirmation is covered above; other operator error
paths remain pending.

### Graphics output recovery

The Graphics library coordinates live-output reads and writes. Reads use an
eight-second deadline, cancellation, hidden-tab suspension and capped backoff.
Live-output reads use primary D1, including when no recent-write cookie exists.
A write invalidates any older read, pauses polling until its acknowledgement or
ten-second deadline, and resumes with confirmed output. Old replies cannot
replace a newer action or cross organizations. An uncertain write retains its
timestamped warning and reconciles through reads without automatically repeating
the action.

During a read outage, badges and counts identify the last confirmed on-air state.
Per-graphic changes wait for fresh state; explicit Clear All remains available as
a stop action, even when the last confirmed output is empty. Clear All returns
observed server state, including any publication
that arrived after the clear, instead of assuming empty output. Existing callers
that ignore its return value continue to work. Clear and per-graphic controls have
44px touch targets.

Run `node apps/web/scripts/smoke-graphics-output-recovery.mjs` after building.
It stops/restarts a disposable Worker, delivers an older completed read after a
newer Hide, loses a successful mutation response after D1 commit, checks recovery
without replay, and verifies the 320px warning, output card and Clear control.
Seven hook tests cover lifecycle ordering, deadlines, scope isolation and access;
three real D1 tests cover Clear acknowledgements, concurrent publication,
organization authorization and primary reads without a recent-write cookie.
No migration is required. See Graphics library confirmation above for the
creation/editing/deletion/import follow-up.

### ProPresenter command confirmation

Rundown slide and kiosk-output actions now share a synchronous pending guard and
a twenty-second confirmation deadline. The deadline allows the existing Bridge
connection/command envelopes of eight and ten seconds. Only an explicit positive
acknowledgement shows confirmation. Timeout, rejection or a lost response produces
a timestamped unconfirmed notice and blocks further ProPresenter actions until
the operator checks the output. The acknowledgement button sends no request and
does not replay the original action. Browser cancellation does not undo an action
already sent to the venue or committed by the server.

Kiosk errors and progress remain visible when the feed is off or slide cues are
disabled. Slide actions require current control access and a connected feed/show;
kiosk changes require edit access and a connected show. Workspace/show/target
changes abort the old request and ignore its late completion. Unexpected
transport details are omitted from operator copy; declared server errors and
timeouts remain visible.

Run `node apps/web/scripts/smoke-propresenter-feed-recovery.mjs` after building.
The rehearsal now executes a Next through the fixture Bridge, discards its
successful HTTP response, verifies one execution and a timestamped warning,
acknowledges review without sending, then executes a deliberate Previous. It also
loses a kiosk response after real D1 persistence and checks that the warning is
visible with the feed switched off. Eight hook tests cover acknowledgement,
duplicate prevention, deadlines, late responses, scope changes, permissions and
review without replay. No migration or native release is required.

### ProPresenter feed recovery

The shared ProPresenter observer bounds feed reads at eight seconds and aborts
reads superseded by a pushed slide, device status, workspace/target change,
disconnect or hidden tab. Failed reads back off to at most thirty seconds;
confirmed feed/device updates restore the normal interval. Hidden tabs continue
receiving pushed slides. Failed transport preserves the last confirmed slide;
only a valid explicit clear removes it.

Rundown and Graphics expose timestamped failures and Reconnect ProPresenter feed.
Reconnect keeps the existing preview and error until confirmation, and duplicate
slide snapshots do not re-fire the preview callback. Graphics labels retained
content as last confirmed instead of inferring a connection from its presence.
Its import actions stack below the preview on small screens so lyrics remain
readable. This observer does not stop the shared venue connection or resend slide
commands.

After building, run `node apps/web/scripts/smoke-propresenter-feed-recovery.mjs`.
It uses real login, disposable settings/allowlist/Bridge keys and a protocol 3
Bridge fixture to verify both pages, disconnect retention, timestamps, manual
retry, automatic recovery, explicit clear and the 320px preview. It does not
exercise physical ProPresenter. Hook tests cover stalled/late reads, backoff,
push precedence, hidden tabs, workspace/target changes and disable/re-enable.
No migration is required. The remaining operator-error audit continues separately.

### Operator read recovery

Show Flow crew presence, active-show selection and external timer reads share an
eight-second request deadline, cancellation on navigation/workspace changes,
hidden-tab suspension and capped retry backoff. Failures retain confirmed data,
show a timestamp and offer a read-only retry. A disconnected external timer
response cannot replace the last confirmed timer with an empty default state.
Rundown ProPresenter configuration uses the same bounded read, with its error
visible even when no host was loaded and the normal controls are absent.

Show Flow holds its displayed rundown clock when the live connection or selected
show cannot be confirmed. It labels retained playback and resumes only after
confirmation. On narrow/short screens, the page scrolls so stacked recovery
notices cannot clip the timer out of reach. This does not stop the authoritative
show timer or replay any operator action.

After building, run `node apps/web/scripts/smoke-operator-read-recovery.mjs`.
It stops/restarts a disposable Worker, verifies retained data, clock hold and
recovery without reload, timestamped failures, configuration retry without a
configured host, and reachable controls/timer at 320px. It also checks 320x480,
768x900 and 1440x900 layouts. Run the show-day safety rehearsal as a regression
check. Hook tests cover non-overlap, deadlines, backoff, hidden tabs, stale
results and workspace changes. No migration is required. An actual external
OnTime feed and physical hardware were not used in this browser rehearsal.

### Rundown connection recovery

The rundown page and live rundown bar show timestamped connection failures and
an explicit Reconnect rundown button. Initial connection shows a connecting
state. Socket opening and initial state have a five-second deadline; backoff
resets only after a valid state for the selected show arrives. Socket creation,
sends, malformed frames and mismatched show state all produce visible errors.

Recovery retains the last known rundown and pending edits. Each retry keeps its
original command ID and expected revision. Transport commands still expire after
five seconds, including when manually reconnecting, and their expiry warning
remains visible after unrelated edits succeed. An acknowledgement without an
explicit boolean acceptance and valid revision cannot mark a command confirmed.
Changing shows clears the previous show's error and ProPresenter preview.

After building, run `node apps/web/scripts/smoke-rundown-connection-recovery.mjs`.
It stops/restarts a disposable Worker, checks retained state and timestamps at
320px, verifies queued edits use the same ID and confirmed revision in order,
checks disabled transport stays stopped after reconnect, and exercises the live
bar's reconnect control. Also run the existing handoff and show-day safety
rehearsals. No migration is required.

### Rundown changes during navigation

When a rundown socket closes for navigation, its pending commands retain their
original IDs, expected revisions and live-action deadlines. The HTTP handoff now
requires an explicit successful acknowledgement before sending the next change.
An HTTP rejection, missing acknowledgement, expired transport action or an
eight-second confirmation timeout stops the sequence and leaves a timestamped
review notice. A failed response cannot supply the revision for later changes.

The notice appears in the workspace shell and on standalone Board, Check-in and
Crew Chat pages. Review rundown opens the original show/date without replaying
commands. An operator can dismiss the notice after checking current state.
Browser session storage retains only notice metadata, never command bodies,
credentials, stage messages or show content. A pending notice restored after a
reload becomes unconfirmed. If session storage is disabled, the notice remains
available in memory but cannot survive a reload.

The `pagehide` handler also hands pending commands off on full-page navigation.
It drains the same queue as route cleanup, so a later cleanup cannot submit the
batch twice. Browser shutdown can still interrupt acknowledgement; the restored
notice prompts review and never assumes success.

After building, run `node apps/web/scripts/smoke-rundown-handoff.mjs`. With a
built Worker, real authentication and disposable relay data, it queues two stage
changes, navigates away, loses the first HTTP response after its real commit,
checks that the second change remains unsent, and reviews the original show.
It also checks reload persistence, standalone visibility, 320px controls and
full-page unload. No migration is required.

### Device connection recovery

Device panels now show timestamped connection and configuration errors. Invalid
saved JSON blocks connection until an operator edits and saves the configuration;
it no longer starts an adapter with empty defaults. Changing organizations or
selected devices discards callbacks from the previous controls.

The browser Bridge transport waits at most five seconds for its first status
snapshot and reconnects with backoff from one to thirty seconds. Socket loss,
malformed updates and failed sends reject pending commands immediately with an
unconfirmed-outcome message. Reconnection restores device connectivity but never
replays device commands. Operators must check the actual device before retrying
an action whose outcome is unknown. An intentionally disconnected proxy cancels
its retries.

After building, run `node apps/web/scripts/smoke-device-connection-errors.mjs`.
It signs into a disposable local organization, exercises a fixture ATEM rejection
and retry, stops/restarts the built Worker and fixture Bridge, checks the outage
message and timestamp at 320px, then verifies recovery without reloading. It does
not prove physical hardware behavior. No migration is required for this change.

### Retrying a saved-template write

Deploy the browser and Worker together. Saving a template now requires the
browser's stable save ID; an older cached browser must reload before saving.
The dialog captures its fields and items on first submission, keeps them fixed
for retries, and reports an unconfirmed save with a timestamp after ten seconds.
It stays open on failure. A retry checks the same save rather than creating a
second copy; a successful acknowledgement closes the dialog.

The existing edit-permission and PIN checks run before every attempt. One atomic
D1 batch creates the template and a `rundown-template-save:<id>` receipt in
`app_setting`. The receipt contains a SHA-256 content digest. Reusing an ID with
different content cannot overwrite the first save. The receipt remains after
template deletion so a delayed retry cannot recreate the removed template;
organization deletion removes both. Receipt keys are separate from the
`rundown-saved:` list prefix. Existing templates need no backfill or migration.

After building, run `node apps/web/scripts/smoke-template-save-retry.mjs`. It
allows a real authenticated save to commit in disposable D1, discards the response
at the browser network boundary, changes the live rundown, and retries from the
dialog. It checks unchanged template content and timestamps, exactly one template
and receipt, labelled fields and a 320px layout. Worker tests cover concurrent
retries, changed content, deletion, organization isolation, legacy-ID collisions
and rollback when the receipt cannot be written.

### Rundown loading and replacement

Load from date or template now reports failed reads with a timestamp and Retry.
A failed list does not display an empty state. List and selected-rundown reads
are bounded to ten seconds; late responses cannot apply after a timeout, close,
workspace change or target-show change. If applying the result cannot be
confirmed within ten seconds, the dialog asks the operator to review the current
rundown before trying again. It does not offer an immediate duplicate write.

Replacing a populated rundown requires confirmation. A running timer or a changed
rundown revision disables confirmation; cancel and select again after reviewing
the current state. Existing relay revision checks and permission checks still
apply. Template deletion is disabled while a load or replacement is pending.

After building, run `node apps/web/scripts/smoke-rundown-load-errors.mjs` and
`node apps/web/scripts/smoke-rundown-layout.mjs`. The first stops and restarts the
disposable Worker to verify real list/read failures, retries, timestamps, 320px
layout and confirmed replacement in the real relay. The second checks five
viewport sizes, keyboard focus, drag-and-drop and all rundown dialogs. Component
tests cover timeouts, stale results, removed templates, uncertain writes and
confirmation changes. No production data is used.

### Operational error reports

Apply `0052_operational_errors.sql` before deploying this Worker. The migration
has not been applied to production. It adds an organization-scoped D1 error log;
no external reporting service is required. Reports retain a fixed error code,
source, allowlisted exception name, server timestamp and optional public build
asset basename and line/column. Raw messages, stacks, URLs, query strings and
show/device content are omitted.

The authenticated organization shell listens for browser errors and unhandled
rejections, shows a dismissible timestamped notice, and sends reports without
waiting for a response. Reporting requests abort after three seconds. A browser
sends at most five reports per minute and suppresses identical reports for one
minute. Durable Object reports also suppress identical organization/code pairs
for one minute. Atomic D1 inserts cap each organization at 30 reports per minute
and 2,000 per day. Scheduled cleanup deletes records older than seven days;
organization deletion cascades to its reports.

`POST /api/operational-errors/:orgId` requires a same-origin request and current
membership. A 202 response acknowledges receipt; rate limits or a storage outage
may prevent persistence. Reporting failures do not reject the original live
operation. `GET` on the same endpoint requires `settings:api_keys` permission and
returns the organization's latest 50 reports with `Cache-Control: no-store`.

After building, run `node apps/web/scripts/smoke-operational-errors.mjs`. It uses
real authentication, the built Worker and disposable D1 to verify report storage,
safe payloads, duplicate suppression, authorization and the notice at 320px and
1440px. Worker tests inject actual rundown persistence and activation failures
and verify both reporting and existing rollback behavior. This does not complete
the broader audit of caught operator failures and display failure visibility.

### Device connection failures

Bridge relay requests now return an explicit failure to the requesting browser
when a connect or ping cannot reach the selected installation, including offline
and revoked installations. Connection failures retain their reason through the
browser proxy and protocol modules into the device panel. Failed connections
show Retry connection; a successful retry clears the error.

Blank optional numeric settings are omitted by the device form. In particular,
leaving Port blank uses the adapter default instead of storing port zero, which
the destination guard correctly rejects. Existing invalid settings are not
silently changed; clear an invalid optional port and save its configuration.

After building, run `node apps/web/scripts/smoke-device-connection-errors.mjs`.
It creates a disposable ATEM configuration and protocol-compatible fixture Bridge,
checks the stored optional port, rejects a connection with a specific reason,
and then accepts a retry. It uses no physical device. Worker tests separately
cover offline/revoked installations, injected socket-send failures, response
ownership and retention of destination approval and credential boundaries.

### Operator text readability

Dark muted text now uses `#A3A3A3`. Rundown and timecode operational labels and
hints use at least 12px, without additional text opacity reductions. Completed
rundown items and fired cues keep readable text; disabled controls retain their
disabled appearance. The light-theme muted token is unchanged.

The rundown-layout and timecode-timeline browser rehearsals import
`operator-readability-audit.mjs`. It measures the built UI's text size and enabled
muted-text contrast, including inherited opacity and translucent backgrounds.
The contrast threshold is 4.5:1. The rehearsals also check narrow layouts, six
rundown dialogs and stopped/failed/fired timecode states. This is an operator
surface check, not a substitute for the remaining product-wide UX gate.

### Rundown keyboard and narrow layouts

The runsheet sizes rows to its own panel instead of imposing a 760px minimum.
Below 768px of panel width, the title, duration and actions use separate rows.
Long titles wrap while notes retain their compact preview. Section and segment
rows keep their actions visible; every action and drag handle is at least 44px.
The route uses shared buttons with focus indicators. Move up/down retains focus
on the same row, choosing the opposite movement button at an endpoint.

The shell's Skip to rundown link is the first keyboard stop. On the rundown
page it focuses the runsheet without changing the selected show; from another
page it navigates to the rundown and focuses the loaded runsheet. Type and
load-source choices remain plain keyboard-operable buttons with pressed state.

Add, Edit, Save Template, Load, Show options and New show forms use the shared
dialog portal so container
queries cannot clip their fixed overlays. Their height is bounded by the viewport
and their content scrolls; Escape closes them and focus stays within the dialog.
Add/Edit inputs have associated labels. Confirmation and live-write behavior are
unchanged.

After building, run `node apps/web/scripts/smoke-rundown-layout.mjs` and
`node apps/web/scripts/smoke-show-day-safety.mjs`. They use disposable accounts and
real relay writes to exercise five widths from 320px to 2560px, hit areas, skip
navigation, keyboard and browser drag reorder, live row start/edit, all six
narrow dialogs, and existing destructive-action/offline-draft guards. The safety
rehearsal also checks that the frame-rate selector locks while timecode runs and
unlocks after Stop.

### Live rundown bar

The shared bar stays visible while the active show is loading, idle or ended.
A newly opened stopped show says No live rundown; when a running show stops in
the current session, it says Show ended. A missing current item is reported
explicitly. The rundown route keeps its own transport and continues to omit the
shared bar.

Disconnected state says Reconnecting, showing last known state in a polite live
region. The displayed timer holds, and transport stays disabled until the relay
hydrates again and the active target is confirmed. Command errors are visible
in the bar. A failed target refresh preserves the last target and offers Retry;
requests time out after ten seconds. Polling skips an awaited request, and late
results cannot apply after a timeout or workspace change. Switching workspace or active show
remounts its session, clearing the old timer and any end-show confirmation.

Previous, Pause/Resume and Next use shared 44px buttons with focus indicators.
They wrap below the title on small screens. Advancing past the final item still
requires End show confirmation; loss of connectivity or a stopped show disables
that confirmation.

After building, run `node apps/web/scripts/smoke-live-rundown-bar.mjs`. It uses
real login and a disposable relay to check idle/end states, transport commands,
final-item confirmation, 320px and desktop hit areas, target lookup failure,
disconnected clock hold and recovery. It does not modify production data.

### Timecode transport and timeline

Start, Stop, Pause and Resume stay beside the clock in the sticky timecode
header. The clock also states Running, Paused, Stopped, Signal lost or
Disconnected. Choose start position opens the existing reviewed-seek form;
cancel keeps its draft, and a changed show, clock, format or control ownership
blocks a stale confirmation. Frame-rate and input settings remain in the source
panel. The source and MIDI panels have distinct show-scoped React keys.

A lost connection retains the selected show's last confirmed timeline and clock
sample with an explicit reconnecting label. Controls remain disabled until a
fresh hydration confirms that show. Construction failures, an unreadable update
and a connection that fails to hydrate report the last error with its timestamp.
Reconnect timecode retries immediately; it neither replays cues nor restarts a
local source. Automatic retries back off until hydration succeeds, including
when sockets open but never deliver a state. Switching shows or organizations
clears retained state and errors.

Timeline rows render a sorted copy in nominal cue-time order. Next and its
countdown use the same compensated dispatch order as the relay and controller
feedback, including while stopped or paused. A later nominal cue can therefore
be Next when its lead or device latency requires sending it first. Late cues
show Overdue within tolerance or Missed after the tolerance expires. Failed rows
show FAILED and their own Retry action; retries retain existing relay guards.

Rows show device names (including disabled devices), tolerance and short action
parameters. Device names come from an organization- and permission-scoped
endpoint without settings or credentials. Names can be refreshed after edits.
Webhook summaries show only the destination origin, excluding URL credentials,
paths and query strings. Captured lighting targets use the device selected for
dispatch when the source started.

After building, run `node apps/web/scripts/smoke-timecode-timeline.mjs` and
`node apps/web/scripts/smoke-timecode-start-position.mjs`. They use disposable
accounts, D1 and relay state to exercise sticky transport at desktop and 320px
widths, 44px row actions, long labels, row retries after a real Bridge-offline
failure, disconnect/reconnect, reviewed custom starts and drop-frame validation.
No physical device or production organization participates in these rehearsals.

### Named countdown timers

`timer-start` accepts `{name, durationMs}` and starts or restarts one named
countdown. `timer-stop` accepts `{name}` and removes that countdown from output.
Names are scoped to the selected show, trimmed, Unicode-normalized and matched
without regard to capitalization. The editor offers saved/visible names and a
minutes or m:ss duration field. Durations range from one second to 24 hours.
Up to 16 timers can remain visible together; Stop frees an output slot. A timer
at zero remains visible as Complete until stopped or restarted.

These timers have their own wall-clock deadlines. Stopping timecode, pausing
automatic cues, using the kill switch or resetting cue attempts does not reset
them or alter the rundown timer. Disabled/skipped cues and the kill switch still
prevent Start/Stop cues from firing. Stop requires a timer that has started in
this show and reports an error for an unknown name.

TimecodeRelay owns the outputs in its SQLite tables, `named_timers` and
`named_timer_receipts`. Output and execution receipt commit atomically. An
interrupted attempt retains its execution ID on Retry, so an old Start cannot
resurrect a stopped timer and an old Stop cannot cancel a later restart.
Reviewed Re-fire uses a new execution ID. Editing an interrupted attempt's
name or duration requires reviewed re-arming before applying the changed cue.
Deleting the show also clears its timer outputs and receipts.

This follows the existing show-scoped lyric-output boundary. Putting these
outputs in RundownRelay would couple independent countdowns to rundown revision
changes; storing them only in a browser would lose durable execution receipts.
No D1 migration or native protocol change is required. Deploy the matching web
client and Worker; existing clients cannot render the new countdown field.

The timecode page lists active timers. The confidence display reserves a timer
row above its existing content, preserving mounted lyrics. Open timer display
opens one large countdown pinned to the selected show. Default confidence
outputs continue following the venue's active show. Display projection includes
only names, durations, deadlines and sample time, without receipt identities.
Local presentation rebases from relay time and advances using a monotonic clock.
Delayed samples cannot add time back. A disconnected display holds its last
value with an unconfirmed label, then adopts current output after reconnecting.

Run `node apps/web/scripts/smoke-named-timers.mjs` after building web. It saves
both actions through Chromium, checks real relay output, observes a countdown
with timecode stopped, preserves lyrics while starting/stopping timers, leaves
other timers running, exercises reviewed restart, switches the venue show and
restarts the local Worker. The pinned output retains its show and original
deadline. The script captures the editor at 320px, the shared stage output and
a dedicated timer at 320x240. All fixtures are local and disposable.

### Cue-controlled automation pauses

`triggers-disable` pauses automatic cue firing while timecode continues.
`triggers-enable` ends that pause at its scheduled dispatch frame. The editor
calls these Pause Automatic Cues and Resume Automatic Cues. Both take an empty
payload and support the existing enabled flag, explicit Retry and reviewed
Re-fire. The operator page shows a persisted pause and a Resume automatic cues
button. Manual Fire remains available during this cue pause.

This state is separate from the safety kill switch. Neither an Enable cue nor
the Resume button can override the kill switch, an unresolved jump review or
an input-format hold. Enabling the safety switch does not silently remove a
cue pause. Stop/Start and relay hibernation also preserve it.

Controls run in dispatch-frame order. At the same frame, Enable runs before
Disable, so Disable wins before any ordinary output is reserved. Disable also
cancels automatic work queued before output dispatch; it cannot undo a command
already sent to a device. A sparse feed crossing a queued output and then a
Disable cue can therefore leave that output missed for operator review. Resume
continues from the current clock position without replaying missed cues.

Deploy the matching web client and Worker together. Legacy snapshots default
to automatic cues enabled. There is no database migration or native protocol
change for these controls.

After the web build, run `node apps/web/scripts/smoke-trigger-controls.mjs`.
It saves both controls through the built editor, advances a real local relay,
checks stage output remains unchanged during the pause, fires manually, resumes
from a timed cue and the operator button, and verifies kill-switch precedence.
Worker cases also cover simultaneous controls, sparse and concurrent feeds,
interrupted execution/Retry, disabled/skipped events, reviewed Re-fire, eviction,
jump/format holds and control ownership. Fixtures are disposable and local.

### Timed crew messages

`crew-message` posts a text cue to Production Chat. The editor has a labeled
message field, limited to 4,000 characters. Stage messages remain a separate
output. The receiving ChatRelay checks the controlling operator's current
session, timecode and chat permissions, organization and show before saving.
The sender name and role come from the database, not the event payload.

ChatRelay commits the message and delivery receipt in one SQLite transaction.
An ordinary retry preserves the execution ID, including after a timecode crash
between the chat commit and acknowledgment. Retrying cannot duplicate the post
or resurrect a deleted message. Editing the cue after delivery requires re-arm
or confirmed Re-fire to create another post. Re-fire carries the reviewed
execution ID; stale confirmations are rejected in both UI and relay.

The cue acknowledges the durable Production Chat post. Forwarding to a linked
Slack, Mattermost, Discord or Teams service is separate and uses the existing
gateway. Cue messages now show pending, failed or sent delivery status, including
configuration failures, and preserve line breaks. The ten-second automation
deadline includes time spent queued; ChatRelay refuses expired deliveries before
committing. Receipts store a content fingerprint, not another plaintext copy.

After the web build, run `node apps/web/scripts/smoke-crew-message.mjs`. This uses
disposable local accounts and actual editor, relay and Chat UI paths. It checks
one post after Fire and ordinary Retry, a second post after confirmed Re-fire,
unchanged Planning Chat and stage output, preserved lines and the editor at
320px. Worker regressions also cover interrupted execution, concurrent delivery,
hibernation, deletion, receipt conflicts, disabled cues, the kill switch,
organization/session checks and linked-service configuration failures.

The receipt table is created by ChatRelay on activation; it requires no D1
migration. Deploy the matching web client and Worker so Re-fire can send the
reviewed execution state. This change has local verification only; it does not
confirm delivery through a real external chat service or deploy the catalog.

### Media library and playback work

Timecode includes a workspace media library for bumpers, countdown videos and
stings. The library supports MP4, WebM, MP3, WAV and Ogg containers, with a 95 MiB
limit and a three-minute upload deadline. Codec support depends on the output
computer; Preview checks decoding and playback there without starting a show
output. Uploads, browsing, previews and deletes require current `timecode:access`.
File mutations also require a trusted browser Origin. Display and guest passes
do not grant library access.

R2 owns each immutable file and its metadata together at
`orgs/<orgId>/media/<assetId>`. There is no second D1 index or migration. Existing
workspace deletion removes this prefix. Upload authorization is rechecked after
streaming; failed or revoked checks remove the completed object. Files are
streamed through a fixed-length pipe, with one byte held until EOF to reject
overlong input before R2 can commit. Container signatures and actual byte counts
are checked. Interrupted input leaves no partial object. The conditional write
prevents overlapping requests from replacing an existing asset. If an upload's
response was lost, refresh the library before retrying its existing ID.

Downloads are private and authenticated on every request, including HEAD and
byte-range reads. Single ranges and If-Range support browser seeking. Invalid
or unsatisfiable ranges return 416. Deletes are confirmed and idempotent. The UI
keeps failed uploads and deletions retryable and aborts requests when unmounted.

`media-play` and `media-stop` target a named output in a selected show. In Timecode,
open **Media outputs**, choose a name, then open its window on the playback
computer and click **Enable output**. Use that same name in the Play and Stop
cue fields. Play selects a library file and volume; Stop clears the named
output. Wait for upcoming clips to prepare before starting the clock. Files
remain private, and the output requires member timecode permission.

One explicitly enabled window owns each output name in each show, with up to
eight independent names per show. Fullscreen contains only the media, without
the operator header or native video controls. The shared web player avoids
duplicate audio from operator tabs and a second native codec stack. Its socket
cannot claim timecode control or receive the operator timeline. Display passes
cannot enable playback. The player preloads up to two upcoming clips in memory,
with a 190 MiB total buffer limit including in-flight downloads. No media is
persisted in browser storage. Preparation failures are visible and retryable.

The relay waits for actual decoded playback progress or paused, unloaded media
before acknowledging a cue. Checking `currentSrc` is insufficient for Stop:
Chromium can retain the old URL after unloading. Play and Stop use the same
ordered output queue; separate outputs run independently. Per-cue disable,
skip, manual fire, reviewed re-fire and the automation kill switch all apply.
Durable receipts survive relay hibernation. Retrying an uncertain execution
queries its original output instead of replaying it. An unknown result or a
changed output session requires operator review and re-arm. Late acknowledgments
never silently convert a failed timeline row into success.

The output has a 15-second heartbeat lease and uses a monotonic deadline based
on server round trips. Disconnect or lease expiry stops playback and clears
the buffer. Reconnect requires explicit Enable again. Disable also cancels an
in-flight Enable, including delayed browser autoplay probes and permission
checks. This output is cloud coordinated; it does not claim offline playback
or frame-accurate delivery on an unprepared computer.

After building web, run `node apps/web/scripts/smoke-media-library.mjs`. The
disposable local rehearsal uploads a real WAV and a browser-encoded WebM,
verifies decoding, playback, seeking, private reads, rejected cross-origin
deletion, confirmed removal, offline retry, restart persistence and a 320px
layout. Preview audio is muted during the test. Worker tests use real R2 and
cover partial/overlong input, upload deadlines, concurrent writes, access loss,
organization isolation, pagination and ranges.

Also run `node apps/web/scripts/smoke-media-cues.mjs` against the built app. It
creates a silent WAV and a browser-encoded WebM, adds Play and Stop through the
editor, verifies timed playback/stop acknowledgments, video decoding and clear,
fullscreen, duplicate ownership refusal, reviewed re-fire, disabled-output
failure and retry, and stop/re-enable behavior after a real Worker outage.
It checks the editor and output at 320px. The separate media Worker suite covers
receipt recovery, cross-show isolation, ordered outputs, revocation, heartbeat
expiry and late Enable cancellation. These checks prove local browser and relay
behavior, not a physical audio system or every platform's codec support.
The media feature has not been deployed to production.

### Native configuration credential migration

Desktop, Bridge Desktop and standalone Bridge now store both the installation
key and any locally entered ProPresenter password in one OS-vault entry. The
JSON file contains a reference and `credentialFormat: showpilot-bridge-v1`,
with neither secret. The format identifies a JSON credential bundle instead
of the old key-only vault value.

Loading an old plaintext file or key-only vault reference migrates it before
returning the configuration. Migration writes a fresh vault entry, atomically
replaces the sanitized file, then retires the previous entry. Failed vault or
file writes retain the previous configuration. Missing or malformed vault data
fails closed. No new plaintext fallback is created.

Bridge Desktop returns only a configured flag for the saved ProPresenter
password. Blank input preserves it for the same site, organization, host and
Stage Display port. Replacement clears the draft after successful saving.
Select “Remove the saved password when I save” and save to remove it. Changing
the destination does not carry the saved password into the new destination.

Older native builds cannot read this vault format. Keep a compatible native
build for rollback; do not restore plaintext configuration backups. Locked or
unavailable OS stores must be unlocked before migrating or saving.

Run the real OS-store probes on an unlocked test machine:

```sh
cargo test --locked --manifest-path packages/native-credentials/Cargo.toml -- --include-ignored
pnpm --filter @showpilot/bridge build
node apps/bridge/scripts/check-credential-store.mjs
pnpm --filter @showpilot/bridge-desktop build
node apps/bridge-desktop/scripts/smoke-private-config.mjs
```

The first two probes use disposable OS-vault entries and test migration,
replacement, clearing and recovery. The standalone probe also loads the
configuration in a second process. The final browser check uses the built UI
with simulated native IPC, covering blank saves, failed drafts, explicit
removal and responsive layout. It does not replace the native Rust/OS tests.

### Applying a migration to production

Use a quiet change window and work from the reviewed commit intended for
production. From `apps/web`:

```sh
# 1. Prove the manifest is an ordered prefix of the numbered files.
pnpm run db:audit-production-manifest

# 2. Capture the current Time Travel bookmark. Save the JSON in the private
#    change record, outside the repository.
pnpm exec wrangler d1 time-travel info showpilot-db --json

# 3. Run the migration-specific read-only preflight below.

# 4. Apply exactly one file against the remote production database.
pnpm exec wrangler d1 execute showpilot-db --remote --file=prisma/migrations/000N_name.sql

# 5. Run that migration's postcondition below. Record the filename only when
#    the command succeeds and the expected objects are present.

# 6. Append the filename on its own line to
#    apps/web/prisma/migrations/applied-remote.txt

# 7. Repeat steps 3 through 6 for the next file, then require a clean check.
pnpm run db:check-production-manifest
```

The check rejects gaps, duplicate entries, unknown files, and out-of-order
entries. The deploy workflow runs the same command and stops before either
Worker changes if any migration remains pending.

For migrations 0030 through 0037, use these read-only preflights where noted:

```sh
# 0030: must return 0.
pnpm exec wrangler d1 execute showpilot-db --remote --command='SELECT COUNT(*) AS duplicate_endpoint_org_groups FROM (SELECT 1 FROM "push_subscription" GROUP BY "endpoint", "orgId" HAVING COUNT(*) > 1)'

# 0032: must return 0.
pnpm exec wrangler d1 execute showpilot-db --remote --command='SELECT COUNT(*) AS duplicate_checklist_groups FROM (SELECT 1 FROM "checklist_entry" WHERE "showId" IS NOT NULL GROUP BY "orgId", "showId", "templateId" HAVING COUNT(*) > 1)'

# 0034: both counts must return 0. Any non-credential provider or duplicate
# credential account needs an explicit provider-owned backfill before rollout.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT COUNT(*) AS non_credential_accounts FROM \"account\" WHERE \"providerId\" <> 'credential'"
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT COUNT(*) AS duplicate_credential_users FROM (SELECT \"userId\" FROM \"account\" WHERE \"providerId\" = 'credential' GROUP BY \"userId\" HAVING COUNT(*) > 1)"

# 0036: must return 0.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT COUNT(*) AS existing_scheduled_call_time FROM pragma_table_info('rundown') WHERE name = 'scheduledCallTime'"

# 0037: must return 0.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT COUNT(*) AS existing_song_objects FROM sqlite_master WHERE name IN ('song','song_orgId_title_idx','song_orgId_ppPresentationUuid_key','song_section','song_section_songId_sortOrder_idx','song_section_orgId_idx','song_cue_map','song_cue_map_songId_idx','song_cue_map_orgId_idx','song_cue','song_cue_cueMapId_sortOrder_idx','song_cue_sectionId_idx','song_cue_orgId_idx')"

# 0038: both result sets must be empty.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT type, name FROM sqlite_master WHERE name IN ('notification_preference','notification_preference_orgId_userId_category_key','notification_preference_userId_idx','notification_orgId_userId_deviceAlertEnabled_createdAt_idx') ORDER BY type,name; SELECT name FROM pragma_table_info('notification') WHERE name IN ('category','deviceAlertEnabled') ORDER BY name;"

# 0039: must return no rows.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT type, name FROM sqlite_master WHERE name IN ('rateLimit','rateLimit_key_key') ORDER BY type,name"
```

After applying each file, require its exact postcondition:

```sh
# After 0030: returns push_subscription_endpoint_orgId_key only.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT \"name\" FROM \"sqlite_master\" WHERE \"type\" = 'index' AND \"name\" IN ('push_subscription_endpoint_key', 'push_subscription_endpoint_orgId_key') ORDER BY \"name\""

# After 0031: returns the table and both indexes.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT \"type\", \"name\" FROM \"sqlite_master\" WHERE \"name\" IN ('expo_push_receipt', 'expo_push_receipt_ticketId_key', 'expo_push_receipt_nextCheckAt_idx') ORDER BY \"type\", \"name\""

# After 0032: returns checklist_entry_orgId_showId_templateId_key.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT \"name\" FROM \"sqlite_master\" WHERE \"type\" = 'index' AND \"name\" = 'checklist_entry_orgId_showId_templateId_key'"

# After 0033: returns the table and its lookup index.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT \"type\", \"name\" FROM \"sqlite_master\" WHERE \"name\" IN ('chat_user_room', 'chat_user_room_userId_idx') ORDER BY \"type\", \"name\""

# After 0034: returns accountId, issuer, providerId, userId and then
# account_issuer_accountId_uidx.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT \"name\" FROM pragma_table_info('account') WHERE \"name\" IN ('accountId', 'issuer', 'providerId', 'userId') ORDER BY \"name\""
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT \"name\" FROM \"sqlite_master\" WHERE \"type\" = 'index' AND \"name\" = 'account_issuer_accountId_uidx'"

# After 0035: returns four tables and seven indexes.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT type, name FROM sqlite_master WHERE name IN ('show_report_note','show_report_note_author_key','show_report_note_show_idx','show_report_reminder','show_report_reminder_recipient_key','content_block','content_block_pair_key','content_block_viewer_idx','content_report','content_report_queue_idx','content_report_target_idx') ORDER BY type, name"

# After 0036: returns scheduledCallTime.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT name FROM pragma_table_info('rundown') WHERE name = 'scheduledCallTime'"

# After 0037: returns four tables and nine indexes.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT type, name FROM sqlite_master WHERE name IN ('song','song_orgId_title_idx','song_orgId_ppPresentationUuid_key','song_section','song_section_songId_sortOrder_idx','song_section_orgId_idx','song_cue_map','song_cue_map_songId_idx','song_cue_map_orgId_idx','song_cue','song_cue_cueMapId_sortOrder_idx','song_cue_sectionId_idx','song_cue_orgId_idx') ORDER BY type, name"

# After 0038: the first query returns one table and three indexes; the second
# returns category and deviceAlertEnabled.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT type, name FROM sqlite_master WHERE name IN ('notification_preference','notification_preference_orgId_userId_category_key','notification_preference_userId_idx','notification_orgId_userId_deviceAlertEnabled_createdAt_idx') ORDER BY type,name; SELECT name FROM pragma_table_info('notification') WHERE name IN ('category','deviceAlertEnabled') ORDER BY name;"

# After 0039: returns the rateLimit table and its unique key index.
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT type, name FROM sqlite_master WHERE name IN ('rateLimit','rateLimit_key_key') ORDER BY type,name"

# After all files: returns no rows.
pnpm exec wrangler d1 execute showpilot-db --remote --command='PRAGMA foreign_key_check'
```

Time Travel is always enabled on production D1. The bookmark command above is
read-only. A restore is destructive: it overwrites the whole database, cancels
in-flight queries, and discards every write made after the selected bookmark.
Never restore automatically and never restore merely because a postcondition
failed. First stop the rollout, retain the command output, assess writes made
since the bookmark, and get explicit owner approval. If restoration is the
approved recovery:

```sh
pnpm exec wrangler d1 time-travel restore showpilot-db --bookmark=<BOOKMARK_RECORDED_BEFORE_MIGRATION>
```

Cloudflare returns the pre-restore bookmark during restoration. Save it so the
restore itself can be undone. See Cloudflare's
[Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
documentation.

For a fresh local database, apply every numbered migration in order with:

```sh
pnpm db:migrate:local
```

The local runner records applied files in the local D1 database, so rerunning
the command only applies new migrations. It accepts an optional
`--persist-to <directory>` for isolated test state and cannot target the remote
database. Older local databases created with direct `wrangler d1 execute`
commands have no runner history; continue applying explicit files there or use
a fresh local state directory.

### Display access deadlines and expiry

Timer and overlay access checks time out after eight seconds and expose a timestamp
and Try again. Cancellation reaches the request, and late results cannot authorize
an expired attempt or another display scope. Confirmed content stays mounted during
renewal failures only while the last confirmed pass remains valid. A separate expiry
timer removes it at the pass deadline, even when renewal is stuck. Responses whose
pass has already expired cannot restore content.

After building, run `node apps/web/scripts/smoke-display-deadlines.mjs` and
`node apps/web/scripts/smoke-display-access.mjs`. The deadline rehearsal delays real
Worker replies, verifies that no private display reads start before authorization,
checks recovery without reload and a 44px Retry at 320px, and expires a real signed
shared pass while renewal is delayed. It creates disposable accounts and Chrome
profiles only. It requires local Chrome or `SHOWPILOT_CHROME_EXECUTABLE`.

No migration or native build is required. Deploy the browser build and reload open
displays to apply this client-side expiry behavior. Existing server-side token
checks remain unchanged; the old unauthenticated graphics RPC is closed separately
by #153. Neither fix is deployed by pushing its feature branch.

### Legacy graphics read removal

The unused `getActiveGraphicBySlug` server function bypassed display authorization.
It is removed from the source and built RPC registry. Public graphics reads use
`/api/overlay/:orgSlug`, which requires a display pass; signed-in operator reads
retain their organization permission checks. No migration or native build is
required. Deploy the Worker to remove the old endpoint; a PR alone does not close
it in a running deployment.

After building, run `node apps/web/scripts/smoke-legacy-display-read.mjs`. The
disposable fixture verifies that the old RPC is unavailable, unsigned, expired,
wrong-surface and wrong-organization display reads are denied, and a valid overlay
pass still renders the fixture's active graphic. The build boundary check also
rejects reintroducing the removed function.

### Current state

The production manifest records every migration through `0046_equipment_revision.sql`.
Migrations 0030 through 0035 were applied in order on 2026-08-28. Migrations
0036 and 0037 were applied in order on 2026-09-10. Migrations 0038 and 0039
were applied in order on 2026-09-18. Before each rollout, every
required preflight returned zero and a D1 Time Travel bookmark was captured.
Every migration postcondition passed, and `PRAGMA foreign_key_check` returned
no rows after each rollout.

The September web audit release includes migrations 0040 through 0046 in the
production manifest. Read-only production checks on 28 September confirmed
their required columns, indexes and member-limit triggers. Three older
notification creation timestamps retain valid `+00:00` suffixes; inbox readers
compare parsed instants. See the [audit release evidence](docs/audit-status-2026-09-28.md)
for the exact deployed commit, CI result and remaining acceptance limits.

---

## GitHub Actions setup

Repository secrets (Settings → Secrets and variables → Actions):

| Repo secret | How to create |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → create a token scoped to this account with Workers Scripts: Edit, Workers R2 Storage: Edit, and zone Workers Routes: Edit. The workflow lists the private downloads bucket and deploys both Workers, but never mutates D1. Distinct from the runtime Stream token `CLOUDFLARE_STREAM_API_TOKEN` — same dashboard, different permissions and different place. |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview → right sidebar → Account ID. |

Repository **variables** (same page, "Variables" tab) — build-time publics
baked into the client bundle by `deploy.yml`. All optional: unset means
analytics no-op / checkout falls back to the hosted Stripe page.

| Repo variable | Value |
| --- | --- |
| `VITE_POSTHOG_KEY` | PostHog project API key (when analytics is enabled). |
| `VITE_POSTHOG_HOST` | PostHog host, e.g. `https://us.i.posthog.com`. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe **publishable** key (`pk_…`) — enables the in-app embedded checkout modal (unset → falls back to the hosted Stripe page). Set the **test** key (`pk_test_…`) now to exercise embedded checkout pre-launch; swap to the **live** key (`pk_live_…`) at launch ([switch flips](#public-launch--switch-flips) step 1). Locally: put it in `apps/web/.env.local` (not `.dev.vars`; Vite doesn't read that). |

Workflow summary:

- **`ci.yml`** — PRs and pushes to `main`. Order is load-bearing:
  install → native release contract → `db:generate` → typecheck → web/Bridge
  tests → React Native export/Doctor → landing verification, plus a parallel
  native Rust job. The
  generated Prisma client is gitignored, so skipping the generate step makes
  `tsc --noEmit` fail with cascading errors. Web, Bridge, mobile, landing,
  Desktop Rust, and Bridge Desktop Rust checks are all blocking.
- **`deploy.yml`** — runs only after CI succeeds on a push to `main`. Fails
  before deploying if any numbered migration is missing from
  `applied-remote.txt` or the private downloads bucket does not exist. It then
  deploys the product and landing Workers and smoke-tests the live landing
  download API.

Mobile store builds are separate from the Cloudflare deploy. They use the
manual, build-only workflows under `apps/mobile/.eas/workflows`; no push to
`main` creates or submits a store build. Follow `apps/mobile/README.md` and run
the authenticated `verify:release` gate before invoking either production
workflow. EAS project linkage, signing credentials, store submission, and the
pending push migrations require explicit owner authorization.

---

## Uptime monitoring / status page (manual setup)

The Worker exposes an unauthenticated health endpoint:

```
GET https://showpilot.tech/api/health   → 200 {"status":"ok","commit":"<git sha>"}
```

It is dependency-free (no DB/auth), so it reflects Worker liveness; `commit`
is the deployed git SHA (`VITE_COMMIT_SHA` from deploy.yml; `"dev"` locally).

One-time setup with UptimeRobot (or Better Stack — equivalent steps):

1. Create a monitor: type **HTTPS**, URL `https://showpilot.tech/api/health`,
   interval 1–5 min, keyword check for `"status":"ok"` (keyword monitors
   catch a Worker that returns 200 with an error page).
2. Add an alert contact (support@showpilot.tech and/or SMS).
3. Optional public status page: UptimeRobot → Status Pages → add the monitor,
   then CNAME `status.showpilot.tech` to the page per UptimeRobot's
   instructions.

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

---

## Public launch — switch flips

The launch sequence, in order. Everything before step 5 is reversible.

**1. Turn on analytics + embedded checkout (build-time publics).**
GitHub → repo → Settings → Secrets and variables → Actions → **Variables**
tab → add:

| Variable | Value |
| --- | --- |
| `VITE_POSTHOG_KEY` | PostHog → Project Settings → Project API key (`phc_…`) |
| `VITE_POSTHOG_HOST` | `https://us.i.posthog.com` (or your PostHog region host) |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe → Developers → API keys → **live** Publishable key (`pk_live_…`) |

They are injected by `deploy.yml` at build time — they take effect on the
**next** deploy (push to `main` or re-run the Deploy workflow at
https://github.com/reydisse/showpilot/actions/workflows/deploy.yml).

> If `VITE_STRIPE_PUBLISHABLE_KEY` was set to a `pk_test_…` key pre-launch to
> verify embedded checkout in Stripe test mode, this step swaps it to the
> `pk_live_…` key so it matches the live secret keys from step 2.

**2. Create live-mode Stripe objects and swap the five secrets.**
Follow [Stripe live-mode setup](#stripe-live-mode-setup) in **live mode**
(products/prices, webhook on `https://showpilot.tech/api/stripe/webhook`,
customer portal), then from `apps/web`:

```sh
pnpm exec wrangler secret put STRIPE_SECRET_KEY      # sk_live_…
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_… (live endpoint)
pnpm exec wrangler secret put STRIPE_PRICE_STARTER   # price_… (live Starter)
pnpm exec wrangler secret put STRIPE_PRICE_PRO       # price_… (live Pro)
pnpm exec wrangler secret put STRIPE_PRICE_FOUNDING  # price_… (live Founding)
```

Secrets apply to the running Worker immediately — do this together with
step 1's redeploy so live publishable + live secret keys match.

**3. One real checkout + refund.**
With a real card: settings → Billing → subscribe (checkout must stay on
showpilot.tech — embedded mode) → webhook flips the plan → Stripe dashboard →
Payments → refund the charge → cancel the subscription in the customer
portal → plan reverts. This proves keys, webhook, and portal in live mode.

**4. Verify monitoring.**
`curl https://showpilot.tech/api/health` returns `{"status":"ok","commit":…}`
with the freshly deployed SHA, and the uptime monitor (see
[Uptime monitoring](#uptime-monitoring--status-page-manual-setup)) is green.

**5. Set the public launch date.**
https://admin.showpilot.tech → superadmin → "Public launch date" → set the
date and save. Beta orgs evaluate as **pro** until this date — setting it
starts the clock on beta access ending, and gates founding-rate eligibility
to orgs created before it.

**6. Announce.**
Landing page is live at https://www.showpilot.tech (deployed separately —
see [Landing page](#landing-page-appslanding--wwwshowpilottech)); links for
the announcement: landing → `https://showpilot.tech/login?signup=1` with
`utm_source/utm_campaign` params for attribution.

After launch, run the full [post-deploy smoke tests](#post-deploy-smoke-tests)
once more — billing step now in live mode.

### MIDI transport synchronization

Deploy this Worker with the updated browser and Bridge before relying on DAW
transport controls. Older Bridges report only timecode frames and do not send
MIDI Stop or resynchronization messages. Native transport messages use the same
selected-installation authorization, bound-show routing and credential audit as
native timecode feeds.

MIDI Stop holds the clock and cue evaluation while keeping the input and source
ownership. Continue waits for a fresh full-frame position or Song Position
Pointer, followed by valid MTC. Start implies song position zero and still waits
for absolute MTC. A full-frame locate during Stop does not fire cues. Fired cues
stay fired; the first resumed frame does not catch up intervening cues, and the
existing large-jump confirmation still applies.

Song Position Pointer and MIDI Clock describe musical beats, not SMPTE time.
ShowPilot tracks them for transport synchronization but requires MTC on that
input for an absolute timestamp. It does not guess a tempo to convert a
clock-only stream. See the [MIDI Association message summary](https://midi.org/summary-of-midi-1-0-messages).
Browsers require the operator to select “Receive full-frame MIDI sync” and grant
SysEx permission for full-frame messages. Quarter-frame input uses ordinary MIDI
permission. Repeated stationary timestamps do not count as fresh clock feeds.

Run these after building the web application and native sidecar:

```sh
node apps/web/scripts/smoke-midi-reconnect.mjs
node apps/bridge/scripts/check-midi-transport.mjs
cargo test --locked --manifest-path apps/bridge-desktop/src-tauri/Cargo.toml --lib
```

The browser rehearsal uses simulated MIDI ports with real login, local D1 and
relay state. The sidecar probe uses its compiled stdin parser and a real local
WebSocket. The unsigned platform workflow runs that probe after bundling.
Physical DAW/USB and browser permission behavior still require a venue rehearsal.

### Per-show MIDI controllers

Deploy the browser and Worker together for controller mappings and Pause. In
Timecode, take control of the show, connect the controller, choose its input and
optional output, and save the mappings. Use **Map APC cue grid** for the 64-pad
layout or choose an action and **Learn MIDI input**. Save after learning. Arming
is explicit for this browser and show; reload, control loss, a show switch, or a
new mapping revision disarms it. Opening another show never adopts its mappings
as an armed controller.

Start resumes a paused local source or starts the internal clock. Pause retains
source ownership and ignores late frames; Stop releases it. Reset asks for
confirmation and resets the clock only, preserving fired cues. Re-arm asks for
confirmation of the selected cue's exact attempt and does not fire it. Seeking,
scrub, offset trim, and jog operate on the internal clock. Large seeks retain the
existing automation hold. Offset and jog take their first fader position as the
starting point after arming or reconnecting; movement then changes the clock.

Banks contain 64 cues in timecode order. APC mini mk2 feedback uses blue for
armed, yellow for next, green for fired, white for running/dispatching, and red
for failed. Its LED bytes follow the [Akai protocol](https://cdn.inmusicbrands.com/akai/attachments/APC%20mini%20mk2%20-%20Communication%20Protocol%20-%20v1.0.pdf).
Other controllers can learn notes and CCs; their LED protocols are not assumed
to match the mk2. Original APC mini LED hardware still requires verification.

The show-bound TimecodeRelay owns mappings and their revision, separate from the
clock journal. Mapping saves use the existing controller claim and compare the
expected revision before persisting. Operator hydration includes the mappings;
display clients and regular clock updates do not. Keeping this data in the show
relay avoids a second D1 ownership and concurrency path. The session provider
owns arming, banks, confirmation and the separate MIDI listener; it stays mounted
across route changes. Reconnect uses statechange plus a two-second rescan, with
name/manufacturer fallback only when exactly one port matches.

After a web build, run `node apps/web/scripts/smoke-midi-controller.mjs`. It uses
real login, local D1, relay commands and lyrics output with simulated MIDI ports.
Complete the physical APC/DAW/USB rehearsal before claiming hardware acceptance.

Desktop uses its native MIDI engine, including on macOS webviews without Web
MIDI. Deploy the matching Desktop binary with the web update. Older Desktop
builds cannot handle the new controller commands and will report a connection
error. Browser clients continue to use Web MIDI. Native Bridge MTC remains a
separate input; controller notes and LED feedback stay on the venue computer
through Tauri IPC and never travel through the cloud relay.

Only the main Desktop window has controller permission. Each connection has a
fresh session ID and an eight-second lease, renewed every two seconds. Losing
that session releases the ports and clears its lights. The UI disarms and offers
Connect controller again. A new session requires explicit arming. Native
selection revisions and input generations reject delayed selection replies and
old port callbacks. Native replug uses the OS port ID, then an unambiguous name;
the native library does not supply manufacturer metadata. Feedback accepts only
bounded note LED messages, coalesces updates, restores lights on output replug,
and clears owned lights before session replacement or application exit.

Run `node apps/web/scripts/smoke-native-midi-controller.mjs` after the web build.
It exercises the built UI, Tauri Channel, real local authentication and relay,
with IPC simulated at the native boundary. On a Mac, run
`cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml coremidi_controller_input_feedback_replug_and_session_cleanup -- --ignored --nocapture`
to exercise actual CoreMIDI virtual ports, message filtering, input/output
replug, LED recovery, stale revisions, session replacement, lease expiry and
shutdown cleanup. Both macOS jobs in the unsigned workflow run this probe.
Virtual ports do not replace the physical APC/DAW/USB acceptance rehearsal.


## Chat room navigation and history recovery (2026-11-07)

Chat now resets the full view for each organization, identity and room connection.
Late history responses and old callbacks cannot update a replacement connection,
even after returning to the same room. Older-history reads coalesce, abort on
room exit, and reach a visible error with Retry after eight seconds. No schema or
native binary change is needed for this web fix.

The room selector preserves browser Back/Forward and distinguishes shared rooms
from direct messages. Desktop buttons expose the selected room; invalid or foreign
DM links show recovery instead of pretending to be Production. The unsupported
seven-day retention claim is removed. Signed-in operators enter rooms directly;
the public guest page still requires its explicit join action.

After building, run
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-chat-rooms.mjs`.
It seeds 2,003 messages through the real local relay, then exercises actual older
history held across room changes, timeout/Retry, DM sends, Back/Forward, invalid
links and 320/768/1440px controls. The 320px screenshot was inspected. All checks
passed with no browser errors or external email. The final full suite passed
2,168 unit tests, 829 Worker tests and four coverage-gate tests; typecheck and web
build passed. Ten hook regressions and two additional adapter regressions cover
stale replies, identity changes, return navigation, callback ownership, deadline
recovery, cancellation and timer cleanup. Nothing deployed or released.

The existing `smoke-chat-creation.mjs` regression also passed real lost-response
recovery, clipboard denial and notification retry at all three widths, with
three durable creation receipts and no external email.

Landing PR #185 CI run 42363813340 passed both main CI and Native Rust tests.


## Song Studio UI and narrow layout (2026-11-07)

Song Studio shows Save all changes only for a dirty draft, explains the empty
lyric preview, provides 44px section arrows and ordering instructions, and shows
a no-match search state with Clear search. The library has one set of empty-state
actions and spells out ProPresenter instead of PP. No schema change is involved.

Run `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-song-studio.mjs`
after the web build. It uses actual keyboard Enter, creates a two-section song,
opens the Studio, moves a section, adds and removes a cue, checks every visible
form control's horizontal bounds at 320/768/1440px, and tests empty preview and
search recovery. Final D1 inspection confirms exact multiline lyrics and section
order. `--audit` reports boolean findings for comparison instead of failing on
those findings. The baseline exposed duplicate actions, conflicting save state,
small ordering targets and missing preview/search messages; entry line breaks
and create-dialog navigation already worked in that build.

An initial screenshot also revealed nested horizontal scrolling despite a
passing document-width check. Grid tracks/children now shrink and cue controls
stack on phones. The stronger per-control check and inspected final phone image
pass. The complete suite passed 2,168 unit tests, 829 Worker tests and four
coverage-gate tests; web typecheck/build passed. No browser errors, production
writes, deployment or release.

This UI rehearsal exposed Prisma's D1 non-transactional warning during song
creation/reordering. The subsequent song-write recovery work below addresses
that finding; the UI rehearsal alone did not prove atomic writes.


## Song write rollback and request recovery (2026-11-07)

Apply `apps/web/prisma/migrations/0057_song_write_receipts.sql` before deploying
this web build. It adds `song.writeRevision`, revision triggers and org/actor
scoped command receipts. Keep this additive migration if rolling the Worker back.
It has only been applied to disposable local/test databases; do not add it to the
remote migration manifest until an authorized production migration succeeds.

The D1 Prisma adapter did not make nested song creation or `$transaction` writes
atomic. Five real D1 failure tests reproduced partial song creation, mixed
section ordering, lost cue maps, partial draft updates and destructive
ProPresenter replacement. Song writes now use one bound D1 batch containing the
receipt and all changes. A revision check rejects changes made during command
preparation. Replaying a committed request does not apply it again, and receipts
survive song deletion so retries cannot recreate a removed song.

The UI retains the exact request and slide snapshot for Retry. Writes and
post-save reads have separate ten-second deadlines; an acknowledged write is
not repeated when only opening/refreshing its view fails. Late callbacks and
callbacks from an abandoned editor are ignored. Creation recovery survives
closing/reopening the dialog. Failed edits retain their drafts; explicitly
resuming editing first reads the stored song and compares it with those drafts.
Section deletes require confirmation. A Back navigation held during a save can
resume after confirmation when no unsaved drafts remain. Confirmed deletion is
identified separately from a failed library refresh.

The import dialog uses the shared Dialog, including labelled search and bounded
library reads. Partial-library Retry remains available. A reimport keeps the
original fetched slides across write retries. The library and map list refresh
without replacing the active recovery UI. Load cues waits for relay
acknowledgement, rejects a running/disconnected clock or mismatched format,
and cancels its pending read when the song/show changes.

Verification commands after the web build:

- `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-song-write-recovery.mjs`
- `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-song-import-recovery.mjs`
- `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-song-studio.mjs`

The first two use actual Chrome, the compiled Worker, real local authentication
and D1. The import rehearsal connects a simulated ProPresenter peer through the
real Bridge relay. It also withholds a committed Timecode acknowledgement,
checks that success is not reported, retries and verifies that the stored group
has two events rather than duplicates. The physical ProPresenter application
and venue hardware are not exercised by this fixture.

Fourteen Worker regressions cover rollback, concurrent retries, changed-payload
rejection, removed records, permission revocation, org isolation and writes that
race command preparation. Eight new hook/dialog regressions cover deadlines,
late results, serialization, scope changes, retained creation requests and
post-save recovery. The complete suite passes 2,176 unit tests, 843 Worker tests
and four coverage-gate tests; web typecheck and production build pass.

Limits: request IDs and drafts survive retries while their editor is mounted,
not a full page reload. The server revision check protects request preparation;
it is not a client revision protocol for long-lived concurrent/offline edits.
Other product-wide mutation/confirmation requirements and the Phase 2 gate
remain open. No production migration, deployment or native release was run.


## Empty library entry actions (2026-11-07)

Stream, Audio, Devices and Multi-Platform now show their header creation action
only when their list has entries. An empty library keeps its single in-context
primary action; Multi-Platform also hides the unusable Go Live control until a
destination exists. Songs and Lower Thirds already used this header rule. Shared
empty-state buttons now have a 44px minimum height and visible keyboard focus.
Board's Add Team Members link goes directly to Team instead of the admin alias.

After building the web app, run:

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-library-empty-actions.mjs`

The rehearsal uses actual Chrome, local authentication and a disposable D1. It
opens the populated graphic editor, confirms removal of the last fixture graphic,
then checks all seven empty screens at 320/768/1440px. It counts their primary
entry actions, checks target size and hit-testing, opens/closes their actual
forms and follows Board to the rendered Team screen. The pre-change audit
reproduced duplicate controls on the four repaired screens. No Stream creation
is submitted, no paid ingest is provisioned, and no real organization is changed.
The three phone screenshots inspected for Stream, Audio and Multi-Platform show
one reachable primary action. This verifies the empty entry points, not the
remaining product-wide dialog, mutation, keyboard or responsive requirements.

Full web validation passed 2,176 unit tests and 843 Worker tests, along with
typecheck and the production build. No deployment or native release was run.


## Audio patch recovery and narrow layouts (2026-11-07)

Apply `apps/web/prisma/migrations/0058_audio_write_receipts.sql` before the matching
web build. The new receipt table is scoped to organization, actor and request;
receipts remain after channel deletion. It was applied only to disposable local
and Worker-test databases. The production migration manifest is unchanged.

The previous Audio UI stayed on Saving after a lost successful reply and deleted
channels without confirmation. Its mute/edit/delete calls had no failure state,
and selected-show reads had no deadline. The baseline Chrome rehearsal reproduced
the stuck save and unconfirmed deletion against the built app.

Creation, edits, stored mute and deletion now retain an exact request for Retry.
Each command and its receipt commit in one D1 batch. Racing retries recover the
winning receipt; a changed payload is rejected. Replays cannot duplicate a channel,
overwrite a later edit or recreate a removed channel. Permissions are checked
before receipt lookup, and every write remains organization scoped. Independent
first-time edits retain the existing last-writer behavior.

The shared `useConfirmedWrite` hook is the former `useSongWrite`, with every
caller and its six lifecycle tests migrated together. Writes and post-save reads
have separate deadlines. After acknowledgement, Retry refresh does not repeat the
mutation. A failed channel form can close/reopen with its draft and pending
request intact. Explicit stored-state review refreshes the patch before unlocking
that draft. Leaving the patch warns before discarding unconfirmed retry state;
this state is not persisted across a full page reload.

Audio reads use `useOperatorRead`: eight-second deadlines, error/Retry, retained
confirmed data and cancellation on show changes. Missing data does not render an
empty state until a read succeeds. The channel editor uses the shared Dialog with
explicit modal semantics, focus trapping, Escape, labelled fields, scrolling
content and fixed header/footer controls. Deletion uses `useConfirmDialog` and
states that it affects this show's stored patch, not the physical mixer.

Grouped channel cards replace the wide table below xl. The desktop table and
cards use native keyboard buttons to select the inspector; search remains visible,
no-match searches are explained and operational controls have 44px targets.

Verification after the web build:

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-audio-write-recovery.mjs`

The rehearsal passed actual Chrome, compiled Worker, authentication and disposable
D1 with held successful replies across creation, update, stored mute and deletion.
It checks exact retry bodies, post-save refresh without a repeated write, rejected
validation with draft preservation, focus trapping/Escape, delete cancellation,
keyboard selection and 320/768/1440px geometry. A second-show timeout recovers with
Retry; releasing its late reply cannot overwrite the restored first show. Final
D1 has five command receipts and one remaining channel with its multiline notes.
Phone recovery and populated-card screenshots were inspected.

Eight authenticated Worker regressions cover receipt races, changed requests,
rollback, deletion replay, revoked membership, show/date/org boundaries and bound
text. Two Audio component regressions replace the old selected-show source-text
counter check. Full validation passed 2,178 unit tests, 851 Worker tests, typecheck
and production build. Existing Song Studio and seven-screen empty-state browser
rehearsals also passed. No real organization, physical mixer, production migration,
deployment or native release was changed. Product-wide Phase 2 requirements remain
in progress; this evidence covers Audio only.


## Devices write recovery and mobile search, 2026-11-07

Apply `apps/web/prisma/migrations/0059_device_write_receipts.sql` after 0058
before deploying the matching web build. It adds only the scoped command receipt
table. Receipts remain after device deletion and contain no settings or credential
payload. The migration was applied only to disposable local and Worker-test
databases; the production migration manifest is unchanged.

The preceding Devices UI stayed on Saving or Removing after a lost successful
reply and gave toggle failures no Retry. Search disappeared below the desktop
breakpoint. The baseline compiled-app browser rehearsal reproduced all four.

Creation, configuration changes, enable/disable and deletion now retain one exact
request for bounded Retry. D1 commits its receipt and mutation in one atomic batch.
The existing authentication secret keys an HMAC fingerprint of the command, so a
database reader cannot guess low-entropy credentials from a plain payload hash.
A changed payload is rejected. Authentication-secret rotation also invalidates
old fingerprints; it cannot turn a recorded request into a fresh mutation.
Current permissions are checked before every receipt lookup. Plan limits,
credential encryption/masking and the existing preparation compare-and-set check
remain enforced. A replay cannot duplicate a device, undo a later update or
recreate a deleted device.

The editor retains its fields and pending request across close/reopen while
mounted. Stored-state review refreshes devices before unlocking that draft.
Leaving the page warns before discarding unsaved or unconfirmed work. Full reload
persistence is not provided. An acknowledged write retries only its failed list
refresh. Device reads have eight-second deadlines, visible error/Retry, retained
confirmed data and stale-response cancellation. Controls are unavailable while
configuration changes are unconfirmed.

Search filters both the mobile selector and desktop list, with an explicit
no-match state and Clear search. Selection remains URL-owned and does not change
a pending request's target. The editor uses the shared Dialog with labelled
fields, focus trapping, Escape, a scrolling body and fixed footer. Removal names
the device and warns about dependent cues; explicit credential clearing keeps
its separate confirmation. Audio and Devices share the same recovery notice.

Verification after the web build:

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-device-write-recovery.mjs`

The final rehearsal passed actual Chrome, authentication, the compiled Worker
and disposable D1. It withholds committed create, update, toggle, credential-clear
and delete replies, checks exact Retry payloads and changes selection during a
pending toggle. It also checks post-save refresh without another write, rejected
validation with draft retention, credential masking/preservation, cancelled
clear/delete, stale list replies after deletion, actual Tab/Escape/Enter and
320/768/1440px layouts. Phone recovery and filtered-selector screenshots were
inspected. Final D1 has six receipts and one encrypted device after three create
attempts. All devices use fixture addresses/credentials; no venue Bridge or
physical equipment is contacted.

Eight authenticated Worker regressions cover retry races at the plan cap,
changed credential requests, secret rotation, rollback, preparation conflicts,
revocation and organization isolation. Ten existing credential tests remain
green. Three component tests cover read deadlines, workspace changes and mobile
filtering. Full validation passed 2,181 unit tests, 859 Worker tests, the four
coverage-gate tests, typecheck and production build. Broader Phase 2 requirements
remain open. Nothing was deployed or released.

Existing Audio recovery and nested Devices/overlay navigation rehearsals also
passed on this build. The older navigation test expected a bare `/login`; it now
asserts the login pathname and the retained protected `returnTo` deep link. Actual
anonymous access still reaches sign-in without overlay content, and a signed-in
member without device permission cannot open device controls.


## Multi-Platform output status recovery, 2026-11-07

No schema change is required for this slice. The preceding Devices migration
0059 remains required by its own matching web build. No production migration or
deployment was performed.

The Multi-Platform summary expected connected/reconnecting health states, but
the server returned provider configuration states, enabled or disabled. As a
result, a successfully enabled output appeared to be Connecting indefinitely.
The page also suppressed polling errors and had no request deadline or Retry.
Two component tests and the baseline browser audit reproduced those failures.

The summary and cards now describe confirmed configuration only: output enabled,
disabled, missing, unconfirmed or unavailable. An enabled output does not prove
that viewers receive a broadcast. The page explicitly directs operators to check
each destination platform. Failed reads retain values as Last confirmed with a
timestamp and Retry. Pending Go Live markers are unconfirmed, not endless
Connecting spinners.

Output reads use the shared useOperatorRead lifecycle: eight-second deadlines,
coalescing, hidden-tab pause, abandoned-response rejection and workspace/output
identity scoping. The server reads each live input once per poll, queries inputs
only within the organization, and bounds each provider response and body to five
seconds. Independent inputs are checked concurrently. Malformed, missing-enabled
and failed responses produce unknown states rather than invented health. Provider
credentials and arbitrary error bodies are never returned.

Run the compiled-app rehearsal with:

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-platform-output-status.mjs`

The optional `--audit` mode reproduces the old behavior against the preceding
build. The fixture intercepts every outbound request, permits only GET on its
exact fake Stream endpoint, and never contacts Cloudflare. It simulates enabled,
disabled, missing and pending outputs, provider errors, malformed responses and
a delayed body. Final Chrome checks pass lost replies, explicit Last confirmed
state, Retry, stale-reply rejection and 320/768/1440px recovery controls. The phone
screenshot was inspected. Seven client polls made seven provider GETs; final D1
values match all four original destination/output IDs and enabled states exactly.

Five component tests cover status truth, deadlines, workspace changes, output-ID
changes with an unchanged count, visibility and overlapping polls. Four Worker
tests use real D1/permissions with a simulated provider to cover grouped reads,
credential exclusion, a hung body, independent input results, pending markers,
foreign inputs, revocation and malformed responses. The source-boundary check
now follows useOperatorRead; actual component tests verify its integration.

Full validation passed 2,186 unit tests, 863 Worker tests, the four coverage-gate
tests, typecheck and production build. After a final wording correction, 26
focused tests and the rebuilt browser rehearsal passed. The existing seven-screen
empty-state browser regression also passed. Phase 2 remains 46/79; no paid
resource, real organization, production deployment or native release was changed.

Remaining streaming work includes confirmation and bounded recovery for Go Live,
Stop All, selection, destination creation/edit/deletion and ingest mutations.
The old destination form also still needs the shared Dialog and retained drafts.
This status-read repair does not claim those paths are complete.

### 2026-11-07: stream-status CI follow-up

Run 42375622195 passed Native Rust and all typechecks but timed out in the first Audio receipt test. A local coverage timing probe measured 1,976 ms of real-auth fixture setup versus 61 ms for the concurrent saves. Move authenticated fixture setup into `beforeEach`, retaining the mutation assertions and their default five-second deadline. No production code, timeout setting, or permission check changed.

Validation: the clean full `test:coverage` run passes 2,186 unit tests, 863 Worker tests, the boundary/migration/coverage checks, and all coverage thresholds; web typecheck passes. An earlier full local run timed out in the separate same-day timecode scoping case. That case completed in 84 ms when instrumented, then passed an instrumented full Worker run and the clean full coverage run; no timecode code or test change is retained. GitHub CI must confirm the pushed revision before the next PR.

### 2026-11-07: recover stream destination configuration saves

Parent PR #192 now passes both main CI and Native Rust on commit
538bd2a709622f21d1aa19fe9ce58a4bbfe11fc6, run 42377131598. This clears the
Audio test timeout before the next draft PR.

Reproduced duplicate destinations when a create response is lost, raw stream
keys in create/update responses, and a real Chrome editor stuck on Saving after
D1 had committed. Destination configuration now uses an org/actor/request receipt
and atomic receipt-plus-mutation batch. Retry keeps the exact submitted request;
changed payloads are rejected, revoked membership is rechecked, replay cannot
restore deleted destinations or overwrite later edits, and preparation conflicts
roll back the receipt. The HMAC receipt contains no payload or stream key.

New and replaced destination keys use the existing credential vault, bound to
organization and destination. Create, update and web toggle responses redact the
stored key, including legacy plaintext. Blank edits preserve the exact stored
key. Legacy plaintext remains readable and is not backfilled by this change.
The mobile API uses the same save core and accepts optional request IDs; existing
native clients that omit an ID do not yet recover lost creates automatically.
No mobile UI completion is claimed.

A reproduced race let Go Live use credentials replaced after its initial read.
The connection claim now compares the stored RTMP URL and key as well as its
existing selection/output conditions. The real-D1 regression confirms a stale
snapshot makes no provider request. The connection core is explicitly server-only;
the production import-protection check caught and prevented a client import of
the credential helper during development.

The web editor retains failed drafts across closing/reopening, exposes bounded
Retry, and retries only reads after an acknowledged save. Refresh failures retain
confirmed destinations. The shared Dialog provides labels, keyboard focus,
Escape, explicit draft discard, navigation protection and reachable 44px controls.
The fields scroll independently of its header and footer on narrow screens.

Rehearsal:

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-stream-destination-recovery.mjs`

Its `--audit` mode reproduced the previous compiled behavior. Final compiled-app
Chrome checks pass lost create/edit responses, exact request reuse, retained keys
and drafts, refresh-only Retry, navigation Stay, Tab/Enter/Escape, discard
confirmation and 320/768/1440px layouts. Phone screenshot inspected. Actual D1
contains two destinations and four receipts despite seven save attempts; stored
keys are encrypted and both destinations remain disabled. A rerun initially
clicked during the initial refresh; the click helper now rechecks enabled state
after layout settles, and the final run passes.

Nine Worker tests use real login, D1, permissions, crypto and a fake provider to
cover the save/replay/security/concurrency cases. Four component regressions cover
retained requests, refresh-only Retry, bounded reads and old-workspace replies.
Full suite passes 2,190 unit tests, 872 Worker tests, migration/client boundaries
and all four coverage-gate tests. Typecheck and production build pass. Final
focused tests pass after removing obsolete mobile test-fixture SQL. Existing
output-status browser regression passes seven polls/seven provider reads with all
four destinations unchanged; the seven-screen empty-action browser regression
also passes.

Migration 0060_stream_destination_write_receipts.sql is required before deployment.
New/replaced keys require the existing CREDENTIAL_ENCRYPTION_KEYS configuration.
No production migration, deployment, native release, real organization write or
paid provider action was performed. The 20 necessary tracked Markdown files
remain. Phase 2 stays 46/79. Go Live, Stop All, destination selection/deletion and
ingest mutation confirmations/recovery remain to be completed before its gate.

## Stream output command recovery and broadcast confirmation

The real-D1 baseline reproduces Disable clearing a pending marker while its
provider output is still enabled, and Stop All refusing to reconcile that marker.
Command receipts alone cannot fix partial provider effects. An organization
Durable Object would serialize requests but still need durable provider outcome
tracking and would add a deployment binding. Use D1 command receipts with frozen
targets and per-destination intent, provider state and expiring execution leases.
A newer Stop supersedes the earlier intent without erasing its physical state.
Completed command retries cannot apply over later commands. Keep credentials out
of command records; retain the existing encrypted destination key.

Create provider outputs disabled, persist the creation attempt before the POST,
and enable only after rechecking the current intent. Capture existing provider
output IDs before creation so recovery cannot adopt or delete an unrelated output.
An unknown creation with no matching new output remains explicitly unconfirmed;
elapsed time does not prove the POST failed and cannot authorize a duplicate POST.
Bound provider calls including response bodies, preserve failed stop records, and
report independent results. Keep selection separate from Go Live. A credential
claim prevents simultaneous destinations with identical credentials from making
recovery ownership ambiguous. Legacy markers without a baseline require a unique,
unclaimed matching output; ambiguity remains an explicit error.


Implemented migration 0061_stream_output_commands.sql and the shared web/native/
Companion output command core. Go Live captures the confirmed destination IDs and
versions, including keyed fingerprints of the displayed name, platform and stored
credentials. Receipts retain those configuration fingerprints: an old request
cannot silently adopt credentials edited after a provider rejection. The receipt
and target intents commit together. Completed retries never repeat provider work,
including after destination deletion. Current authorization is checked on every
public retry. Mobile selection/removal accepts the same retained request IDs.
Companion Start/Stop returns partial failures as HTTP 502 with per-target results.

Stop All includes selected destinations whose creation has not begun yet. It
supersedes their intents without erasing provider state, and continues across
missing targets, missing inputs and individual claim/provider failures. A
pending or ambiguous creation cannot be cleared by guessing that elapsed time
means failure. New outputs start disabled; unknown creates reconcile only against
new matching output IDs. A keyed credential claim prevents competing creations
for identical destination credentials. Provider operations have five-second
response/body deadlines. The web retains exact requests with ten-second bounds,
refreshes without re-sending acknowledged changes, protects navigation and offers
explicit Review. Stop remains available while Go Live awaits confirmation and
replaces that pending browser operation only after the Stop confirmation. Server
intent/version checks, not browser abort alone, prevent late restarts.

Shared confirmation dialogs name Go Live/Stop targets, identify active-output
Disable and confirm removal. Selection alone never starts a broadcast. The new
smoke-stream-output-commands.mjs runs actual Chrome/auth/compiled Worker/D1 with
an isolated, stateful fake provider. Its final run passes Cancel without a
command, lost Go Live/Stop/selection/deletion replies, exact Retry, partial Stop,
unknown provider creation and Stop during delayed creation. After five fixture
provider creates and nine distinct commands, D1 retains only the beta destination,
selected with no output or input binding, and the provider map is empty. Its
320/768/1440px confirmation controls pass bounds/hit tests; phone screenshot
inspected. The fixture snapshot now uses a single write queue and atomic rename
so concurrent provider operations cannot corrupt the observation artifact.

Evidence includes baseline failures for the original pending-marker bugs,
independent Stop preparation, credential changes after rejection and stale
confirmation versions. Twenty-five real-D1 output tests plus eleven real-auth
stream-save/API tests cover recovery, supersession, expired leases, frozen
completed targets, ownership, scope/revocation, redaction, deadlines, rollback and
configuration fencing. Six new component cases cover confirmation and retained
output requests. Five old mock-Prisma mutation tests were replaced by these real
D1/provider tests, retaining their behavioral assertions.

Final full suite: 2,192 unit tests, 899 Worker tests, migration/client boundaries
and four coverage-gate tests pass. Typecheck and production build pass, with
511,914 raw / 162,143 gzip client entry bytes. Coverage thresholds also passed
before the final configuration-fencing follow-up; CI reruns coverage on the pushed
head. Compiled output-status and destination-editor browser regressions pass.
The final command browser run uses the rebuilt configuration-fencing code.

Migration 0061 remains unapplied to production. No production deployment, native
release, real organization mutation, real provider request or paid service was
used. Twenty necessary tracked Markdown files remain. Phase 2 stays 46/79:
ingest mutation recovery, native/Companion client request retention and the
remaining product-wide/catalog/gate checks are still outstanding. Phase 3 has
not started.

## Live input recovery, health honesty and operator recovery

Real-auth/D1 baseline tests reproduce repeated creation making two provider
inputs, plaintext ingest keys in storage/write replies, a successful-but-lost
DELETE stuck on its next 404, and malformed provider health reported as Idle.

A receipt around the existing POST cannot recover an unknown provider outcome.
A request marker in Cloudflare metadata alone does not serialize competing
attempts or protect deletion. Use command receipts plus a per-input lifecycle,
with an immediately visible local placeholder and a durable provider phase.
Create the provider input disabled with a unique ShowPilot input ID in metadata;
recover unknown creation through List followed by Retrieve, never another POST.
Encrypt the retrieved RTMP key before enabling the identified input. Preserve
existing plaintext keys until replaced; credential disclosure remains restricted
to explicit manage-authorized reads. A pending card must support Resume after a
reload, so recovery does not depend on the original browser retaining its request.

Deletion records its intent before contacting the provider, converges through
404, and retains a tombstone/receipt. Its admission and Go Live admission must
exclude one another atomically. Check both stored destination bindings and
pending output intents, including the interval before an output ID exists.
A lease protects each provider transition; deletion supersedes pending setup
without allowing a late reply to enable the input. Missing/ambiguous unknown
creations remain visible and retryable instead of guessed absent.

Health reads need their own bounded provider/body deadline, strict status parsing,
last-confirmed UI values and read-only Retry. Newer checks must own cache updates;
a delayed old response cannot replace newer health. The Stream page and TM health
panel must not present cached or failed telemetry as current Online/Live. Use the
existing bounded read/write hooks and shared dialogs, retaining editor drafts and
protecting navigation. Creation/deletion, health polling and clipboard operations
must show errors and recovery. Provider and browser fixtures remain isolated from
real accounts, inputs and broadcasts.

Implemented in `fix/stream-input-recovery`, stacked on #194. Migration
`0062_stream_input_lifecycle.sql` adds atomic command receipts, retained input
lifecycle records and ownership of cached health checks. Apply it after 0061
before deploying this build. Existing inputs remain usable without lifecycle
records. New RTMP keys use the existing credential-vault configuration; old
plaintext keys remain readable and are not backfilled by this change.

Create and delete commands retain org/actor request IDs. Pending inputs appear
immediately and can resume after reload. Inputs are enabled only after their
credentials are stored, and an unreadable enable response stays pending. Removal
and output admission exclude one another in a D1 batch, including before an
output ID exists. Expired leases can be reclaimed; late former owners cannot
write newer state. The oldest ready input is used by automatic selection, and
Multi-Platform excludes pending/deleting inputs. Missing or ambiguous creation
results remain explicitly unconfirmed; no repeated POST guesses at absence.

Stream uses the shared bounded read/write hooks and Dialog, with named deletion
confirmation, retained failed drafts, exact-request Retry, refresh-only Retry
once acknowledged, navigation protection, and Resume/Retry removal after reload.
Copy waits for clipboard completion and exposes failure with Retry. Controls
have labels, keyboard focus and 44px targets. Health calls include network/body
deadlines and guarded cache writes; provider reasons and unknown states are not
echoed. TM starts with unknown input health, offers Retry and labels destination
records as configuration, not proof of delivery. Pending output markers no
longer count as connected in TM/mobile summaries; a removed mobile input is
unknown rather than falling back to cached Live.

Verification:
- The four initial real-auth/D1 regressions failed for duplicate creation,
  plaintext keys, lost-delete recovery and invented Idle. All now pass.
- Twenty-one input Worker tests cover lost creates/deletes/enables, reload Resume,
  absent/ambiguous provider matches, changed requests, removed rows, revoked
  authority/org scope, missing encryption, transactional rollback, stale health,
  response-body deadlines, both admission orders, deletion during creation and
  expired-lease recovery. Nine component cases cover exact Retry, acknowledged
  refresh, confirmation, Resume, health deadlines/late replies, truthful TM,
  clipboard rejection, hidden tabs/coalescing and input replacement.
- Full web checks passed 2,201 unit and 917 Worker tests, migration/client
  boundaries and the four coverage-gate tests. After the final disabled-status
  redaction and concurrency cases, coverage passed all 2,201 unit and 920 Worker
  tests and existing thresholds. Typecheck and production build passed. The main
  client bundle is 512,295 raw / 162,277 gzip bytes, within both budgets.
- `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-stream-input-recovery.mjs`
  passed real Chrome/auth/compiled Worker/disposable D1 with an isolated provider.
  It withholds committed replies, retries identical requests, resumes after a
  reload, converges provider deletion through 404, checks malformed/slow health,
  clipboard failure, draft retention, navigation Stay, Tab/Enter/Escape and
  320/768/1440px controls. The phone screenshot was inspected. Two provider
  creations finish with zero inputs, four completed receipts and two deleted
  lifecycle records. The test now accounts for CSS-uppercase text and accepts
  the real beforeunload warning when deliberately reloading a pending request.
- The existing stream-output-command browser regression passed on this build:
  five provider creations, nine command receipts, partial Stop and late creation
  cancellation, with no remaining provider outputs.

The provider contract was checked against Cloudflare's official
[Create](https://developers.cloudflare.com/api/resources/stream/subresources/live_inputs/methods/create/),
[List](https://developers.cloudflare.com/api/resources/stream/subresources/live_inputs/methods/list/),
[Retrieve](https://developers.cloudflare.com/api/resources/stream/subresources/live_inputs/methods/get/)
and [Update](https://developers.cloudflare.com/api/resources/stream/subresources/live_inputs/methods/update/)
API references. All provider mutations during verification used isolated fake
resources; no real organization, provider, production migration, deployment or
native release was changed. The 20 necessary tracked Markdown files remain.
Phase 2 remains 46/79; remaining UI sweeps, native/Companion request retention,
MIDI/LTC/local-mode/catalog verification and phase gates still need completion.

## Team command recovery

Real-auth/D1 baselines reproduce four failures: replaying a role change reverts
later work; retrying an email-based removal deletes a newly joined membership;
cancellation overwrites accepted invitation status; closing an already dismissed
report as resolved reports success without making that decision. The Team page
also passes a user ID where Better Auth removal expects a membership ID, drops
role/moderation failures, and can leave cancellation disabled after rejection.

A client deadline and fresh read alone cannot fence a late older mutation.
Wrapping the existing Better Auth write with a receipt afterward leaves a commit
window and cannot preserve last-owner checks under concurrent commands. Use the
existing ShowPilot organization endpoint extension: retain each endpoint's
schema, middleware, origin/rate-limit/cookie handling, but commit the decision
and receipt through one D1 batch. Preserve installed Better Auth role semantics
(static plus dynamic permissions, owner-only changes to owners, at least one
remaining owner, organization scope), current session and actor authority, and
post-commit relay read-authority refresh. Better Auth teams are not enabled; do
not confuse the app's crew team tables with Better Auth membership plumbing.

The caller supplies its organization, stable request ID and target membership
revision where available. The server freezes the concrete membership even for
legacy email-based removal. A member management revision advances on role
changes from every writer, including away-and-back changes. Receipts survive
membership removal, replays require current authority and never mutate a newer
membership or role, and dynamic role-policy snapshots are compared at commit.
Cancel only pending invitations, preserving accepted/rejected outcomes and the
existing atomic recipient-response path. A report decision conflicting with a
terminal outcome must fail explicitly. Self-removal clears the current session's
active organization in the same batch, matching the installed plugin behavior.

Use bounded Team reads and shared confirmed-write recovery for role/removal,
cancellation and moderation. Keep unresolved commands visible across tab
switches, confirm removal/cancellation with names, use actual membership IDs,
make removal controls visible without hover, and provide keyboard tab semantics.
Invitation creation/email delivery and crew/access editors retain their separate
contracts and must be audited before the product-wide requirement can close.
All verification uses disposable users and organizations, never real crew data.

Migration 0063 adds the membership revision trigger and atomic command receipts.
The web and mobile wrappers preserve request IDs and reject the explicit error
payload returned by Better Auth's in-process API; HTTP status alone does not
cause that API to reject. Mobile cancellation and removal can recover after the
original target has already changed. Both membership endpoints still await the
existing relay authority refresh. Apply 0063 after 0062 before deploying this
code; no production migration has been applied.

The Team workspace now retains one unfinished command across tabs, bounds reads
and writes, and distinguishes Retry change from Retry refresh. Removal uses the
membership ID and displayed revision. Invitation cancellation and report
resolution/dismissal have named confirmations. The native role selector and
visible removal controls meet 44px; tabs expose tablist/tabpanel relationships
and Arrow/Home/End navigation. A pending command protects page navigation.
Invitation and report dates hydrate from a stable ISO representation before
using the operator's locale; report timestamps are explicitly returned as UTC.

Verification on fix/team-write-recovery:
- Four real-auth/D1 baseline failures reproduced the original retry bugs.
  Twenty-four Worker regressions now cover exact replay, new memberships,
  cross-organization and revoked-actor boundaries, dynamic/multiple roles,
  last-owner concurrency, stale/away-and-back revisions, session expiry,
  policy/recipient/target races, receipt rollback, self-removal session cleanup,
  moderation and the web/mobile API wrappers.
- Seven component cases cover retained requests across tabs, refresh-only Retry,
  correct removal IDs, cancellation/moderation confirmations, timeouts and tabs.
  Full web checks pass 2,208 unit and 944 Worker tests plus migration/client
  boundary and coverage-gate checks. Typecheck and production build pass; the
  main client bundle is 522,833 raw / 165,530 gzip bytes, within its budgets.
- smoke-team-recovery.mjs passes actual Chrome, authentication and the compiled
  Worker with disposable D1. It withholds committed replies, changes a role
  through another request before retrying the old one, checks read-only Retry,
  confirms cancellation/moderation/removal, tests keyboard/navigation behavior,
  and checks 320/768/1440px controls. Six receipts remain with exactly one owner,
  a canceled invitation and a resolved report attributed to the operator.
  The browser reports no runtime or hydration errors; phone layout inspected.

This closes these Team controls, not the whole Team audit: invitation creation,
email delivery, crew/access editors and native client request retention remain
outstanding. Phase 2 stays 46/79. No deployment, native release, real crew write
or external email occurred. The 20 necessary tracked Markdown files remain.

## Team invitation creation and email recovery

Four real-auth/D1 baseline failures reproduce lost creation acknowledgements,
missing rejected/unknown email status, and recreation after cancellation when an
old request is retried. Team and Settings have separate invitation forms; both
must use the same recovery component. Mobile uses the direct organization API.
Setup already records delivery outcomes through its email hook and must keep
that evidence. The installed Better Auth adapter generates invitation IDs and
commits insertion before the email hook. Migration 0040 already enforces member
plus pending-invitation capacity atomically; preserve it rather than duplicating
plan rules in a new implementation.

A UI-only retry can resend or recreate after cancellation. Recording only after
the existing create endpoint leaves the insertion/receipt gap; recording only
before it cannot identify an insertion that committed without its hook running.
The chosen shape extends the existing organization endpoint wrapper: retain its
schema/middleware/origin/rate-limit boundary, reuse current Team authority and
commit guards, and atomically insert the invitation, request receipt and ready
email attempt. The email attempt owns its frozen payload, stable provider key,
lease and accepted/failed/uncertain outcome. A creation retry returns the same
invitation's current state and can recover its original email attempt; it never
reopens a canceled/answered invitation. An explicit resend creates a new attempt
for the same pending invitation, guarded against an outdated target/attempt.

Caller shape: create with organization, email, role and request ID; refresh the
invitation's delivery state; retry its same attempt after uncertainty; explicitly
confirm sending again when an earlier email may have been accepted. Keep email
acceptance separate from the recipient accepting the invitation. Preserve the
Setup hook and migrate Team, Settings and mobile error handling together.

Resend documents [24-hour key retention and identical-payload replay](https://resend.com/docs/dashboard/emails/idempotency-keys).
Freeze the email payload and stop automatic provider replay after 23 hours from
first admission, leaving a margin inside that contract. A new confirmed resend
gets a new key; it must never be disguised as retrying the previous attempt.
A lease and current invitation/actor guards prevent competing dispatches and
stale attempt owners from changing newer outcomes. Tests use fake email delivery
and disposable organizations, never real recipients or provider traffic.


Implementation and verification:

- Migration 0064 adds atomic creation/resend receipts and durable email attempts.
  Invitation lists join their current delivery in one scoped snapshot and never
  expose frozen email bodies. Retry checks current membership, session, role
  policy, invitation state, lease and the 23-hour replay window. Email payloads
  escape organization/inviter text and require a valid provider acceptance ID.
- Four additional baseline failures exposed web/mobile callers returning auth
  error payloads as success and rejecting receipt recovery at the plan cap.
  Those callers now forward exact request IDs, reject explicit auth failures and
  leave capacity enforcement to the existing atomic database boundary. Setup
  forwards its attempt ID and reviewed resend target while retaining its own
  delivery evidence and explicit completion decision.
- Team and Settings share the invitation form, delivery states, bounded clipboard
  feedback and confirmed resend controls. Team retains drafts across form close
  and tabs, coordinates invitations with other pending Team changes, and blocks
  accidental navigation. A confirmed write followed by a failed read retries the
  refresh only. Controls have labels, visible actions and 44px minimum targets.
- Mobile parses delivery state, bounds team/invitation requests, shows errors and
  retries the original request from the session's mutation cache after returning
  to the screen. Offline mutations run their bounded transport rather than pausing
  indefinitely. Accepted, expired, rejected and uncertain email/invitation states
  stay distinct. Real QueryClient tests verify retained variables, current-user
  cache isolation, pruning and offline behavior; no native simulator UI run or
  native release is claimed for this change.
- The new real-auth/D1 Worker file has 23 cases, covering exact/concurrent retry,
  rollback, duplicate and capacity races, frozen payloads, request mismatch,
  explicit resend, stale attempts, lease ownership, current owner/actor access,
  commit-time revocation, canceled/expired invitations, web/mobile wrappers and a
  provider that never responds. Existing Team and Setup regressions remain green.
  The Team component suite has 12 cases; email transport/template tests have 14;
  three mobile recovery tests exercise the real mutation cache and status copy.
- Final full web coverage run passes 2,227 unit and 967 Worker tests, migration and
  client-boundary checks, and all coverage thresholds. Web/mobile typechecks and
  the production build pass. Main client bundle: 523,008 raw / 165,632 gzip bytes.
- `smoke-team-invitations.mjs` passes real Chrome/auth/compiled Worker/disposable
  D1: a committed creation with its browser reply withheld; a provider acceptance
  with its reply lost; exact Retry; explicit resend; refresh-only Retry; clipboard
  failure/recovery; Settings draft navigation protection; and 320/768/1440px
  controls. Final evidence is three invitations, four delivery attempts, four
  request receipts and six provider calls for four distinct accepted emails.
  The 320px screenshot was inspected. Both existing Setup recovery/skip browser
  scenarios also pass, preserving crew and truthful email completion evidence.

Apply 0064 after 0063 before deploying these callers. Phase 2 remains 46/79;
crew/access editors, the remaining native Team mutations and product-wide gates
are still open. No production migration, deployment, native release, real
organization mutation or external email occurred. Twenty necessary tracked
Markdown files remain.

The existing `smoke-team-recovery.mjs` also passes against this final build:
six Team command receipts, one remaining owner, correct cancellation/moderation,
newer role preservation, exact and refresh-only retries, keyboard/navigation and
320/768/1440px controls. Its geometry check excludes the now-preserved, hidden
invitation form; enabled visible controls retain the same minimum-size checks.

## Crew roster recovery: implementation in progress

Four real-auth/D1 baseline failures reproduce duplicate-creation errors after a
lost acknowledgement, old edit retries overwriting newer crew details, removal
retries failing after a committed delete, and stale drafts saving over new names.
The roster's stable database ID differs from its reusable check-in badge ID.
Profile writes exist in web and mobile; Setup and CSV import also create crew,
while public/signed-in check-in updates attendance and sometimes the profile
photo. Preserve those identities and do not make every check-in invalidate a
profile edit. CSV import has its own plan check, while direct roster creation
currently has none; this change does not infer a new pricing rule from that
inconsistency.

The form currently owns an unbounded request and closes through a custom overlay;
the list has an alert-only delete failure and fire-and-forget refresh. Team
unmounts the Crew tab, which loses the editor and pending request. Native roster
writes use separate SQL paths. History eb218a9 reduced MemberForm motion; it did
not add transaction receipts or revision checks.

A UI-only retry cannot distinguish a committed create/delete or protect a newer
profile. Reusing the device receipt helper would mix credential-specific hashing
and device ownership with crew rules. The chosen contract is one crew command
boundary for create/update/delete, an atomic request receipt, and a profile
revision incremented by a database trigger for profile fields. Attendance fields
stay independent. Use current member/session authority and commit-time guards;
return a receipt identity, then refresh current roster data. An old create replay
must not recreate a deleted record, and an old remove must never affect someone
who later reuses the same badge ID.

Web/native callers supply a stable request ID and the displayed profile revision
for edits/removal. Team owns the pending write across tabs, the shared Dialog owns
focus/Escape, and the form keeps its draft until confirmation or explicit discard.
A read failure after acknowledgement retries only the read. Tests cover real
D1/auth boundaries, concurrent/late requests, attendance independence and actual
compiled-browser form/delete/refresh recovery. Access grants are a separate next
slice with on-duty authority and notification/relay-refresh semantics to preserve.

## Crew roster recovery: implementation and verification

Migration 0065 adds a crew profile revision and an atomic command receipt. The
trigger covers every profile writer, including public photo updates, without
invalidating a profile draft when attendance alone changes. Web and native API
create, update and removal use the same command boundary. Current session and
member-management authority are checked before receipt recovery and again in the
transaction. Retrying a committed request acknowledges its original identity;
it cannot restore an old name, recreate a deleted profile or delete a new holder
of a reused badge ID. Native's existing 128-character badge limit is preserved,
and whitespace-only badges are rejected after trimming.

Team owns the pending web request across tabs. The Crew editor uses the shared
Dialog, retains drafts when closed, confirms discard and deletion, restores
focus, labels fields and exposes visible 44px actions. After acknowledgement,
Retry refresh repeats only the read. Photo preparation has a deadline and cancels
on editor close. The responsive browser check caught and fixed a remaining 40px
Add button. A component test also caught retained fields when switching from a
discarded new-person draft to an existing profile; editor identity now resets
that draft correctly.

Native requests carry their exact command UUID and displayed revision. Failed
commands survive screen navigation in the signed-in mutation cache, with Retry
and explicit review/discard controls. Reads and writes have a ten-second deadline
including response parsing. Photo conversion is bounded separately. The screen
is keyed by account and organization, protects unsaved navigation, and refreshes
a confirmed change without replaying it. Native API and cache behavior were
verified; no simulator or physical-device UI run is claimed.

Verification:

- The four initial real-D1 failures pass after the fix. Fourteen Crew Worker
  regressions cover exact/concurrent retries, rollback, badge reuse, current
  authority and target races, profile/attendance independence, native/web
  interoperability, stale revisions and expired sessions. Seven earlier native
  mocked-SQL tests were migrated to real-auth/D1 Worker tests.
- Full web tests pass with 2,233 unit and 987 Worker tests. The final coverage run,
  including the additional badge-boundary regression, passes 2,233 unit and 988
  Worker tests and all existing coverage thresholds.
- Web and mobile typechecks pass. Production build passes, with 524,916 raw and
  166,556 gzip bytes in the main client bundle. The client-boundary verifier now
  follows Crew authorization into the shared command function and checks its
  member-management permission, tenant/revision guard and commit-time authority.
- `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-crew-roster.mjs`
  passes against the compiled app, real Chrome, real authentication and disposable
  D1. It verifies lost create/edit/delete replies, a newer native edit surviving an
  older retry, refresh-only recovery, retained drafts, navigation protection,
  focus/Escape and 320/768/1440px controls. Database evidence is five receipts and
  the two untouched seed crew members. The 320px editor screenshot was inspected.

Apply 0065 after 0064 before deploying these web/native callers. Older callers
can omit revision and request ID for compatibility; displayed-revision protection
and client retry recovery require the updated callers. No production migration,
deployment, native release, real organization mutation or external email occurred.
Phase 2 stays 46/79; Access management and the wider native/product gates remain
open. Twenty necessary tracked Markdown files remain. PR #197's exact-head CI
run 42406977373 is green for both main CI and Native Rust tests.

The existing `smoke-team-recovery.mjs` also passes against this build: six Team
receipts, one remaining owner, exact and refresh-only retries, newer role
preservation, cancellation/moderation, keyboard/navigation and 320/768/1440px.

### Crew PR CI follow-up: song test setup

Run 42409219813 passed Native Rust and all typechecks, but the first song-write
Worker test exceeded its five-second limit. Its fixture created and hashed a
credential, seeded the organization and signed in through the real auth endpoint
inside the behavior test. A local coverage timing probe measured 1,740 ms in
fixture setup and 19 ms in the trigger-induced rollback and database assertions.
The probe did not reproduce the CI timeout locally; it identified setup as the
large cold-start cost.

Move each test's fresh authenticated fixture to `beforeEach`, matching the Team
Worker suite. Preserve real auth/D1, all rollback/receipt/foreign-org assertions,
and the default five-second behavior timeout. No production code or test timeout
setting changes. The targeted 14 tests, full 2,233 unit and 988 Worker tests,
coverage thresholds, web typecheck and status-ledger check pass locally. The next
GitHub run must confirm this on the CI runner before calling the failure closed.

The follow-up GitHub run 42410688370 passed web coverage, all typechecks, Bridge
and Desktop tests, and Native Rust. It then exposed a stale mobile source
contract: `verify-mobile.mjs` still required three removed Crew wrapper names in
`team-crew.tsx`. The screen now uses the shared `executeMobileCrewCommand`, parsed
commands and retained mutation cache. Update the contract to follow that path,
including create/update/delete schema variants and receipt validation. Local
`pnpm --filter @showpilot/mobile verify` passes all three Expo exports, 18 Expo
Doctor checks and the polling boundary check; five native Crew recovery tests
also pass. This is JavaScript export/API/cache evidence, not native device UI
acceptance. A new CI run is still required for the combined branch.

## Access grant recovery: implementation in progress

Four real-auth/D1 baseline tests fail in `access-grant-recovery.worker.test.ts`:
exact grant retry returns a duplicate error, retry after revocation creates new
access, revoke retry fails after commit, and a draft reviewed for an earlier week
silently grants the current week. The first fixture attempt lacked a required
membership timestamp; `/tmp/showpilot-access-before2.log` is the valid baseline.

`access-grants.ts` owns capability validation, no-self-grant, member scoping and
weekly limits. `effective-access.ts` derives Sunday-to-Sunday weeks in the org's
timezone and gives current on-duty TM assignments temporary management authority.
The mobile adapter calls the same service. Notifications follow the write and
intentionally cannot block urgent revocation. Commit d33ac4c preserves feature
links in those notifications; b958a96 adds the post-commit relay refresh whose
bounded read leases remain the fallback. Neither change added request receipts
or commit-time member/duty guards.

The selected contract is `writeAccessGrant(actor, command)`: grant/revoke commands
carry a stable request ID and weekly grants carry the displayed week. One D1 batch
stores the grant/revocation and its receipt. Commit guards retain actor session,
member identity/role, target membership, org timezone, reviewed weekly window and
current TM assignment. Exact replay acknowledges the old grant identity and reads
its current status; it cannot recreate revoked or expired rights. Web/native
adapters share the parser and transaction implementation.

Putting notifications in that transaction would make notification failure block
revocation. A UI-only retry would still recreate a revoked grant. Instead the
receipt stores a durable notification intent, delivered after the authoritative
write with a deterministic notification ID. Failed delivery stays pending and is
listed for explicit retry; superseded grant/revoke notices are not emitted late.
Relay refresh starts after commit and stays best effort with a deadline, preserving
lease-based revocation. Callers distinguish saved access from pending notification
and refresh failures. Team owns pending commands/drafts across tabs; native caches
exact failed requests by account and organization. Access authority and notification
semantics are verified independently before adding UI recovery.

### Access recovery validation

Access grant/revoke receipts and pending notification intent use migration 0066.
Web and native writes share the same server transaction, current authority checks
and exact replay behavior. Web Team owns the pending command across tabs; the
Access form retains its draft and reviewed week, confirms revocation/discard,
restores focus, and offers notification-only retries. Native uses account/org
mutation-cache keys, the same reviewed week and request ID on retry, bounded
reads/writes, explicit retry/review controls, retained drafts while the screen
stays mounted, navigation warning, and 44px controls. Notification failure cannot
block a committed revocation; relay refresh remains bounded and best effort.

All four original real-auth/D1 failures now pass. Thirty real-Worker Access tests
cover receipt concurrency, rollback, current authority/session/membership/duty and
timezone changes, no-self-grants, custom-permission scope, notification recovery
and suppression, foreign orgs, expired/deleted grants, native API/web replay and
a hung relay refresh. Seven web editor tests cover retained drafts and reviewed
weeks, exact retry, refresh-only recovery, named revoke/discard confirmation,
notification-only retry and late-response suppression. Four native mutation-cache
tests cover exact grant/revoke/notice retry, offline attempts and account/org
isolation. The former seven service and five mobile mocked tests were migrated
to real Worker coverage rather than relaxing authentication or database contracts.

Full coverage passes 2,232 unit and 1,018 Worker tests with all three coverage
gates met. Web/mobile typechecks pass. The web production build passes at 525,791
raw / 166,810 gzip main-bundle bytes. `smoke-access-recovery.mjs` passes in compiled
Chrome with real login/D1: a lost grant reply followed by native revocation never
restores access, a read-only retry does not repeat a grant, lost revocation replies
recover, and drafts, focus, confirmation, navigation and 320/768/1440px controls
work. Database audit finds four receipts, four notifications and zero active
grants. The 320px screenshot is readable. Native verification passes iOS/Android/
web Expo exports, 18 Expo Doctor checks and polling boundaries; native device UI
acceptance remains open.

Build verification caught and fixed the snapshot helper's missing server-only
boundary. The initial expanded Access tests also caught two invalid fixtures:
a custom permission outside the operational allowlist and a timezone insert
without the required row ID. The final suite exercises valid versions of both.

Apply 0066 after 0065 before deploying these callers. Legacy callers can omit the
request/week fields; durable exact retry requires updated web/native clients.
No migration, deployment, native release, real organization write or external
notification provider call has occurred. Phase 2 remains 46/79 and the wider
native/product gate remains open. Twenty necessary tracked Markdown files remain.

PR #198's exact parent head fd9accbb49ef550f4adbeeba4c6b3ca6846bf31c is now
fully green in GitHub run 42411480306, including main CI and Native Rust. The
song setup timeout and stale native Crew verification contract are both closed
before opening the Access draft PR.


## Settings plan and timezone clarity (2026-11-07, not deployed)

Billing previously presented effective Pro trial access as the current plan,
highlighted the available Founding offer as if selected, and could mark both Pro
and Founding current for a Founding subscriber. The Billing component now shows
one current plan separately from feature access and trial/beta status. It follows
the existing paid-entitlement policy, displays inactive subscription status, and
keeps a current Founding card visible after acquisition eligibility closes.
Available offers share neutral styling and actions say Subscribe. Existing
prices, checkout APIs, entitlement rules and database fields are unchanged.

Organization timezone now has a labeled search and native select with 44px
controls. The browser's supported IANA catalog loads after hydration, avoiding
server/browser ICU differences. UTC is explicit, Toronto is searchable, and
saved aliases remain visible even outside the search results. Search never
writes. The existing Settings owner retains save, retry, conflict and navigation
state. Unset timezones no longer falsely display New York as saved; London is
no longer described as UTC. A custom combobox and a second timezone/save store
were unnecessary because native selection preserves keyboard behavior and the
existing write contract already owns recovery.

Two Billing regressions failed before the repair. Ten focused component cases
now pass, covering plan/entitlement distinctions, Founding uniqueness, expired
trial, beta, unpaid subscriptions, timezone aliases, no matches and unset values.
The full web suite passes 2,242 unit and 1,018 Worker tests. Typecheck and the web
production build pass; main client bundle is 525,791 raw / 166,829 gzip bytes.

After building, run `SHOWPILOT_SMOKE_RUNTIME=miniflare node
apps/web/scripts/smoke-settings-clarity.mjs`. Seven real-D1 billing organizations
exercise the compiled UI with real login; timezone search/save/reload and
320/768/1440px controls pass. Payment RPC calls are forbidden by the rehearsal
and none occurred. Phone screenshots were inspected. The existing
`smoke-settings-autosave.mjs` regression also passes lost replies, exact Retry,
newer edits, two-operator conflicts, ProPresenter save gating, Confidence draft
preservation and the final audit of 18 receipts.

No migration or native binary is needed for this slice. No deployment, release,
real organization mutation or payment-provider call occurred. Notification
categories and the remaining Settings/product-wide acceptance work remain open;
Phase 2 stays at 46/79. Twenty necessary tracked Markdown files remain.


## Personal notification preference recovery (2026-11-07, not deployed)

Settings described editable notification categories without providing their
controls. The inbox editor reverted failed saves, but its Retry refreshed the
inbox instead of saving the requested preference. A real-auth/D1 regression also
proved that retrying a lost save reply could overwrite a newer preference.

Web and native now share the preference writer and reader. Migration 0067 adds
account/org/request receipts with user/organization cascade cleanup. The receipt
and preference commit in one D1 batch, with current session/membership guards.
The command includes the reviewed boolean choice; a conflict returns the stored
choice for review. Replaying a completed command reads its current result and
cannot overwrite a newer choice. Reusing a request ID for different intent fails.
Legacy callers without recovery fields still work; updated callers retain IDs
and reviewed values for exact retry.

Settings and the inbox use one category editor. Web caches live in a per-rendered-
app QueryClient at the root, with account/org keys and no SSR module singleton.
This preserves commands when an editor closes or a Settings section changes.
Reads time out after eight seconds; writes after ten. Saved changes update the
shared cache, while a failed follow-up read offers only a refresh retry. Native
Settings uses the same account/org recovery ownership in its mutation cache,
bounded requests and visible save/retry/conflict feedback. None of these choices
changes another member's preferences or removes inbox notifications.

A client-only retry was rejected because it cannot distinguish an acknowledged
write from an old command that would overwrite a newer choice. Reusing the inbox
editor unchanged was also insufficient: it had no confirmation deadline and
retried the wrong operation. The shared server receipt is authoritative; web and
native caches retain only the current session's recovery intent.

Validation passed 2,254 web unit and 1,029 Worker tests, web/mobile typechecks and
production web build. Eleven real-auth/D1 regressions cover receipts, concurrency,
rollback, current authority, account/org isolation, cleanup and web/native
interoperability. Seven shared-editor tests cover all categories, retained exact
retry, read-only recovery, deadlines, late responses, account separation and
render stability. Six existing inbox tests and five native cache/contract tests
pass. Main bundle: 551,383 raw / 174,355 gzip bytes, below 600,000 / 175,000 limits.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node
apps/web/scripts/smoke-notification-preferences.mjs` passes against the compiled
app with real login and disposable D1. It verifies a lost web reply followed by
a newer native choice, exact retry after section navigation, read-only retry,
shared Settings/inbox choices, late replies and 320/768/1440px controls. Final
audit: four receipts and three category rows, with the other org untouched. The
phone screenshot is readable. Mobile verification passes iOS/Android/web Expo
exports, all 18 Doctor checks and polling boundaries. Hermes bundles remain under
6.5 MB. Native simulator/device UI verification remains outstanding.

The first compiled-browser run caught the missing root QueryClient provider,
which component wrappers had supplied. Full-suite testing then exposed a real
selector render loop: retaining freshly-created validation errors in observable
snapshots caused 1,505 renders during 500 ms of simulated waiting. Selectors now
return parsed values or null. A Profiler regression requires fewer than 20 renders;
native structural-sharing coverage guards the same behavior. Test deadlines were
not raised. Browser harness corrections also waited for the document and compared
decoded commands rather than JSON property order. The final build and browser
rehearsal were rerun after the production fixes.

Apply 0067 after 0066 before the matching Worker/web deployment and native release.
No production migration, deployment, native release, real organization mutation
or notification-provider call occurred. Phase 2 remains 46/79; the complete
Settings-specific and product-wide gates remain open. Twenty necessary tracked
Markdown files remain. Parent #200 at 48d81887c458b405e2690f78a6634864a3060ff1
passed both jobs in GitHub run 42413363800 before this draft PR is opened.

## Settings report export recovery and Settings-specific audit (2026-11-07, not deployed)

The compiled browser reproduced an unbounded show-list spinner in Danger Zone
export. Report preparation also had no deadline; its hand-built modal lacked
Escape/focus management, the show select was unlabeled, and a missing selection
could silently fall back to the first show. These are now handled by a dedicated
ShowReportExport component using the shared Dialog and bounded read hook.

Show-list reads finish with data or an eight-second error and Retry. Report reads
and file encoding share a ten-second deadline. Failures preserve the selected
show, format and sections. Close, Escape, route unmount and timeout cancel the
request; late replies cannot start a download or dismiss a newer dialog. A show
that disappears requires a new explicit selection. The copy describes selecting
a saved show by name/date rather than implying a calendar picker or past-only
filter. Form controls have labels, native radio/checkbox semantics and 44px
click targets. The dialog scrolls within short/narrow windows and restores focus.

File serialization is extracted without changing existing JSON/CSV/Excel section
selection or spreadsheet-safe CSV escaping. Downloads now include the stable
show ID in their filenames, and JSON/CSV metadata includes showId, so two shows
on one date remain distinguishable. The server still checks organization access
and the exact show/date; export performs reads and browser file generation.

Validation: eight recovery component tests; full web suite 2,262 unit and 1,029
Worker tests; web typecheck and production build all pass. Main bundle remains
551,383 raw / 174,350 gzip bytes within the existing limits. The baseline compiled
browser failed waiting for bounded list recovery; the final
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-settings-export.mjs`
passes with real auth and disposable D1. It withholds list/report replies,
recovers the selected same-date show, rejects late/canceled downloads, checks
focus trapping/Escape/return, and measures controls at 320/768/1440px. Actual JSON,
CSV and Excel files downloaded through Chrome were read from disk; their contents
contain only the selected show's segment and omit the unchecked Crew section.
The Excel ZIP's XML was inspected. Final fixture audit confirms both shows remain
and the other org has no rundown rows. Phone screenshot inspected.

The first layout check measured during the dialog animation; the browser script
now waits for settled animations before measuring. A subsequent reopen clicked
through a closing overlay; clicks now wait for hit testing to confirm the target
is reachable. These were observation fixes, with no production timeout or target
size relaxed. The final run also verifies unique Integration Connect accessible
names, distinct general autosave/Confidence Apply guidance, the visible Webhook
URL Save button, and the overlay/QR explanation through in-app section changes.
Together with the Billing/timezone and notification browser evidence above, all
eight clauses of the Settings-specific requirement are now verified. Phase 2 is
47/79. Broader loading, mutation, confirmation and UX gates remain open, including
Danger Zone destructive actions; this export fix does not certify those actions.

No migration, deployment, native release, production data change or external
provider call. Twenty necessary tracked Markdown files remain. Stacked on draft
#201; do not open the export PR until #201 CI run 42415959635 passes.

## Chat history clear recovery (2026-11-07, not deployed)

The original Settings action deleted only legacy D1 chat_message rows, while
native history remained in ChatRelay SQLite. A real-auth Worker baseline proved
that the action reported success while Production still returned the old message.
The action now requires the exact organization name in the shared Dialog and
records one organization/account/request receipt with a fixed cutoff and room
list. Migration 0068_chat_history_clear_receipts.sql must follow 0067 before the
matching Worker deployment. No remote migration has been applied.

The server checks current session and danger-zone permission, rechecks membership
and session at the D1 commit, and delivers the clear to registered rooms plus
Production and Planning. Each relay checks the durable receipt, room identity,
live authority and delivery deadline before committing. Room acknowledgements are
reported individually. A timeout or partial reply retains the original request
across Settings navigation; Retry finishes that request without deleting newer
messages. Legacy D1 deletion runs only for the invocation that created the receipt.
Cleared message IDs cannot be replayed from an outbox; old external imports are
suppressed, and newer replies lose quotes of erased messages. Uploaded files and
connected chat services are unchanged, as stated in the confirmation.

Review found a second defect: an offline client missed the clear broadcast and
merged old messages back into the UI on reconnect. The compiled browser reproduced
that failure before the correction. ChatRelay now persists a clear version and
includes it in ordinary hydration, allowing web clients to replace retained
history on reconnect. Both web and native clients reject stale older-history reads
that complete after hydration. The current live document remains open throughout.

Validation: 12 Worker cases cover actual relay/D1 clearing, direct rooms and org
isolation, eviction and lost replies, partial recovery, duplicate requests, exact
name and authority checks, rollback, commit-time revocation, expired delivery,
2,100 older rows, external import suppression and cleared outbox IDs. Component
and web/native hook tests cover typed confirmation, cancel, bounded pending state,
account isolation, exact retry, live clearing and offline hydration. The final
full suite passes 2,270 unit and 1,041 Worker tests. Web and mobile typechecks pass.
Production web build passes at 551,383 raw / 174,337 gzip bytes. Mobile verification
passes iOS/Android/web exports, 18 Doctor checks and 41 API contracts; this is not
a device UI or signing test.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-chat-history-clear.mjs`
passes against the compiled app with real authentication and disposable D1/relay
storage. Two Chrome sessions verify live clearing, an intentionally lost reply,
exact retry after navigation, newer messages retained, and offline reconnect
recovery without reloading the chat document. The fixture has exactly two clear
receipts across three rooms, no foreign-org mutation and zero outgoing emails.
Controls pass 44px checks at 320/768/1440px; the phone screenshot was inspected.

Stacked on draft #202, whose CI run 42416828926 passed both jobs before publication.
No deployment, native release, production data mutation or provider call occurred.
Phase 2 remains 47/79. Graphics reset, organization deletion and the broader
product-wide gates remain open. Twenty necessary tracked Markdown files remain.

## Saved graphics reset recovery (2026-11-07, not deployed)

A real-auth D1 baseline reproduced two Danger Zone defects: a wrong confirmation
name was ignored, and retrying a successful reset deleted a template created
after the first request. The old operation also deleted templates referenced by
Program. The Settings action now uses an exact typed organization name in the
shared Dialog and a durable organization/account/request receipt. Migration
0069_graphic_library_reset_receipts.sql follows 0068 before deployment.

Reset now requires settings:danger_zone rather than the broader permission to
configure lower thirds. The writer verifies a current session, snapshots current
membership, and rechecks membership/session/name at the atomic D1 commit. The
receipt stores the original deleted count and shares the transaction with deletion.
Only its creating invocation can delete; retries acknowledge the original result.
Saved scenes, uploads and other settings remain intact. A new reset is refused
while Program references graphics or has an unreadable output pointer, with a
visible instruction to clear Program in Graphics first. The idle check also runs
at commit. A replay of a completed reset remains safe if new graphics are on air.
Independent text lower-third payloads do not reference the template library and
remain intact. Reset does not clear live output itself.

The UI has a ten-second acknowledgement deadline, persistent error and timestamp,
and exact-request Retry retained across Settings navigation with account/org
isolation. It confirms the deleted count and keeps later graphics. A later reset
requires a new typed confirmation. Controls have labels and at least 44px targets.
The initial phone screenshot exposed clipping from the long destructive label;
the final dialog uses a bounded grid column and wrapping buttons. The browser now
checks that each control fits inside the dialog, not only document scroll width.

Validation: nine Worker cases cover exact name, concurrent duplicate requests,
changed confirmation, lost-reply replay, org isolation, preserved scenes/settings,
active/malformed Program, commit-time Program and membership changes, rollback,
role/session checks and organization rename. Four component cases cover cancel,
exact retry through navigation, account isolation, timeout/late reply and renewed
confirmation. Final full suite: 2,274 unit plus 1,050 Worker tests passed. Web
typecheck and production build passed; main bundle 551,383 raw / 174,349 gzip bytes.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-graphics-reset.mjs`
passes against the compiled app with real auth and disposable D1. It verifies that
live Program blocks deletion, explicitly clears fixture Program, withholds the
successful reset reply, saves a new graphic, navigates away/back, and retries the
same request without deleting that graphic. The final receipt records two deleted
templates once; all five fixture scenes remain. Cancel sends no request. Controls
and dialog bounds pass at 320/768/1440px; final phone screenshot inspected. No
outgoing email, real organization mutation or external-provider call occurred.

Stacked on #203. Do not open this draft PR until #203 CI run 42418701631 is green.
No production migration, deployment or native release. Phase 2 remains 47/79;
organization deletion and broader product-wide gates remain open. The 20 necessary
tracked Markdown files are retained; no new Markdown file was added.

## Organization deletion recovery (2026-11-07, not deployed)

Real-auth D1/relay baselines proved two recovery failures. A successful deletion
signed out the acting session before its lost acknowledgement could be retried.
A trigger rejecting the final organization DELETE left the organization alive
but removed its owner, because Prisma D1 $transaction ran the prior membership
deletes individually. The first correction exposed a third defect: resumed chat
purge tried loading SQL history after the first purge had dropped its tables.

The final organization DELETE now uses the existing ON DELETE CASCADE constraints
for memberships, invitations and app settings. That single SQLite statement is
atomic, so a failed final delete keeps the owner and deletion marker for retry.
App-data cleanup remains ordered and resumable; Stripe cancellation still precedes
destructive cleanup. This shared-core correction also applies to the administrative
CLI. ChatRelay authorizes and handles an org purge before reading history, making
repeated cleanup succeed after its tables have already been dropped.

Organization deletion now retains the user's account session. Deleted memberships
and active-organization pointers are removed; the account and other memberships
remain. This allows the same authenticated request to confirm an already-completed
deletion. The obsolete continueAccountDeletion switch is removed from both callers.
The public confirmation page states that the account is kept and offers Continue
to ShowPilot. The server reads the session without cookie-cache shortcuts and
retains owner-only, recent-sign-in and typed-name checks for existing organizations.

Settings and the account-deletion workspace blocker share a typed-name Dialog.
The deletion request has a twenty-second acknowledgement deadline, abort/late-reply
protection, explicit partial-cleanup copy, timestamped errors and Retry of the same
organization/name. Mutation state survives editor unmount within the account/org
cache. Post-success navigation has its own five-second deadline. Account deletion
continues only after workspace removal is acknowledged. Inputs and buttons are
named, at least 44px, and fit within the dialog at narrow widths.

Seven real-auth Worker tests cover normal deletion, lost-response replay, final
DELETE interruption with owner retained, repeated relay purge, other-org/account/
session isolation, raw receipt cascades, wrong name/role/org and stale/revoked
sessions, subscription failure before data removal, and child-table interruption.
Subscription tests use an isolated mock; no provider is contacted. Thirty shared
core tests and four UI cases pass, including exact retry, navigation failure,
account isolation and ignored late results. Full web suite: 2,278 unit plus 1,057
Worker tests. Typecheck and production build pass; main bundle 551,432 raw /
174,357 gzip bytes. A stale unused icon import was removed after the first typecheck.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-organization-deletion.mjs`
passes twice against the compiled app with actual auth, D1 and native chat: once
from Settings and once from the account-deletion workspace blocker. Both withhold
the committed deletion reply, reach bounded Retry, confirm through the exact same
request and preserve the account plus the other fixture organization. Settings
opens /org-deleted; the account flow returns to its password form. Cancel sends no
request, controls and containment pass at 320/768/1440px, and the phone screenshot
was inspected. Both fixture runs send zero emails.

No migration, deployment, native release, real-org mutation or external-provider
call. Stacked on draft #204; wait for its CI run 42419840525 to turn green before
opening this draft. Phase 2 remains 47/79: kiosk blanking still lacks confirmation
and its initial read silently fails, so the broad confirmation and UX gates are
not complete. Twenty necessary tracked Markdown files remain.

## Kiosk display command recovery (2026-11-07, not deployed)

Real-auth Worker baselines reproduced a lost acknowledgement retry re-blanking
displays after a newer Companion restore, and stale reviewed state overwriting
an intervening controller change. Component baselines reproduced immediate
blanking without confirmation and an unknown initial read presented as restored.

Settings now uses a shared confirmation before blanking, with Cancel making no
request. Restore remains one click. Reads and writes have eight/ten-second
acknowledgement deadlines, explicit errors with timestamps, and separate Retry
controls. The exact failed command survives navigation in its account/org cache.
The UI describes the desired setting and next kiosk poll, not an unverified
claim that every physical display has already applied it. Controls are at least
44px and the confirmation fits at 320/768/1440px.

An atomic D1 batch records the account/org/request receipt, desired boolean and
revision. Commit-time membership/session/role revision and org-deletion checks
protect writes. A stale reviewed revision returns conflict; an exact replay
only reads its receipt and latest state. Companion and the technical dashboard
share the server setter, which advances the revision atomically with the flag.
Their boolean contract and the read-only kiosk payload remain unchanged. No
migration is needed. Generic Settings access still excludes these internal keys.

The first production build exposed a server-only helper exported through the
client RPC module. Storage helpers now live only in the server module and the
boolean interpreter lives in the pure contract; import protection stays enabled.
The first compiled Chrome rehearsal then proved kiosk polling reused a cached
pre-command response. The display endpoint now returns private, no-store. Other
kiosk endpoint caching remains part of the Phase 3 token-hygiene requirement.

Nine real-auth Worker cases cover duplicate/concurrent commands, intervening
Companion changes, changed-payload reuse, transactional rollback, org/actor
isolation, revoked access and corrupt saved state. Six component cases cover
confirmation, bounded unknown reads, retained exact retry, account/org isolation,
late replies, reviewed-state capture and one-click restore. Final full suite:
2,284 unit plus 1,066 Worker tests. Typecheck and production build pass; main
bundle 551,432 raw / 174,352 gzip bytes.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-kiosk-display-command.mjs`
passes against compiled Chrome/auth/D1 with real fixture kiosk and Companion
tokens. It withholds a committed write response, restores via Companion, navigates
away/back, retries the exact command and proves the restore remains. Fresh blank
and restore commands reach browser polling without a stale cache. It also checks
bounded initial reads, Cancel, three durable receipts, other-org isolation and
320/768/1440px confirmation bounds. Phone screenshot inspected; no runtime errors
or emails. Physical kiosk hardware was not exercised.

Stacked on #205, whose CI run 42420964310 is green. Keep this PR draft. No
production deployment, release, migration or real-org/provider mutation. Phase 2
remains 47/79; the broader product confirmation/error gates remain incomplete.
The Kiosk org-chart/roster editors still have unbounded writes and unconfirmed
removal, and the technical dashboard's output controls need further review.
Twenty necessary tracked Markdown files remain; no new Markdown file was added.

## Kiosk org-chart recovery (2026-11-07, not deployed)

Five real-auth Worker baselines reproduced duplicate teams after a lost create
reply, adding a user outside the organization, a failed promotion demoting the
previous lead, a rejected final DELETE stripping team members, and an already
completed deletion failing on retry. Two component baselines reproduced deletion
without confirmation and creation staying busy without bounded recovery.

Migration 0070 adds a team revision and org/actor/request receipts. The single
writeKioskTeam command replaces all five old write wrappers and their callers.
A D1 batch commits the receipt and mutation together, including lead replacement
and FK-cascaded team deletion. Exact retries return the original acknowledgement
without rewriting newer data. Reviewed revisions reject stale edits; current
session, permission, membership revision and organization-deletion state are
checked at commit. A target who leaves the org before commit produces a recorded
conflict rather than a permanently locked retry. Existing CSS color values remain
supported. Organization/user deletion cascades the new receipts.

Team metadata and members are read from one SQLite snapshot. Admin and kiosk
projections exclude departed org members. A further Worker baseline proved the
old kiosk projection kept showing a departed lead; its org-scoped membership join
now removes that stale person from the displayed org chart. The public payload
still contains display data only and does not expose command receipts or revisions.

The editor has explicit Save, named color/people controls, and confirmation for
team deletion, member removal and lead changes. Writes time out after ten seconds
with a timestamp and exact Retry. Drafts and pending commands survive section
navigation in an account/org cache. Read failure retries only the read after a
confirmed write. Conflicts preserve edits and require explicit review of the new
team revision. A late-acknowledgement remount regression exposed stale local form
state; synchronous cache subscription now updates both controlled inputs and a
remounted editor. No blur-triggered write remains.

Final verification: 14 real-auth Worker cases and eight editor cases, plus the
existing settings/display/token cases. Full web suite passes 2,292 unit and 1,080
Worker tests. Typecheck and production build pass; main bundle 551,432 raw /
174,364 gzip bytes. These include storage rollback, concurrent duplicate and
competing commands, org/actor isolation, target departure, revoked sessions and
commit-time access changes, receipt cascades and preservation of CSS colors.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-kiosk-team-recovery.mjs`
passes against compiled Chrome with real auth/D1. It withholds a successful create
reply, edits that team from another request, navigates away/back and retries the
same create without duplication or overwriting the newer name. It then exercises
explicit rename, refresh-only recovery, member add, confirmed promotion and team
deletion. Cancel sends no write. Six receipts remain, with no team/member rows,
foreign-org receipt or outgoing email. Controls and dialogs fit at 320/768/1440px.
Screenshot review found squeezed member names on phones; the row now stacks and
the browser check requires readable name width as well as 44px control bounds.
The final phone screenshot was inspected. No runtime errors were captured.

Stacked on #206, whose CI run 42422075613 is green. Keep this PR draft. Migration
0070 has only run in disposable local fixtures; no production migration,
deployment, native release or real-org/provider mutation. Phase 2 remains 47/79:
on-duty roster writes and broader confirmation/error/UX gates are still open.
Twenty necessary tracked Markdown files remain; no new Markdown file was added.

## Duty roster command recovery (2026-11-07, not deployed)

Six real-auth Worker baselines reproduced partial default roles, silently ignored
role-code conflicts, failed deletion erasing assignments, lost-save replay
replacing a newer PM assignment, old week saves clearing newly added roles, and
assignment notification failure becoming permanent. Three editor baselines
reproduced unconfirmed role deletion, indefinite saves and lost week drafts.

Migration 0071 adds roster/catalog revisions, org/actor/request command receipts,
and durable duty notification jobs. Settings and the Production Manager dashboard
now use one strict command path; the old roster write wrappers and save helper
are removed. The receipt, assignments, role changes and notification jobs commit
in one D1 batch. Current session, role, membership revision, target membership and
organization-deletion state are checked at commit. A role deletion also checks
its assignment revision across weeks. Exact replay recovers the original outcome
and reads current state without replacing a newer decision. Commands normalize at
the execution boundary so equivalent parsed/internal inputs have the same receipt
fingerprint. A 100-role regression verifies bounded statement parameters.

Both editors expose bounded reads/writes, timestamped errors and exact Retry.
Unsent week/role drafts and uncertain commands survive account/org-scoped section
navigation. Changed revisions retain selections and require review before an
existing assignment is replaced. Role deletion and assignment replacement use the
shared confirmation dialog. Read Retry remains visibly pending through a first-
load retry, rather than losing its error notice. Background refresh preserves
unsaved selections. The PM card shows confirmed assignments without attaching the
previous person's attendance to a newly selected person; viewers without roster
management permission retain their summary.

Assignment notifications are retried independently from roster commands, including
by the existing scheduled duty-reminder job. Inbox delivery is durable and uses
once-only notification IDs. Push remains best effort and is not replayed for an
existing inbox item. Delivery respects current membership and alert preferences,
skips superseded assignments and survives storage failures. Further baselines
proved departed members remained visible on kiosk/PM duty projections and a PM
read failure appeared as an empty roster; those paths now filter membership and
report read errors.

Final checks pass: 24 Worker roster/notification cases and 12 editor cases;
full web suite 2,303 unit and 1,100 Worker tests; typecheck and production build.
Main bundle is 551,534 raw / 174,416 gzip bytes. The compiled Chrome/auth/D1
`smoke-duty-roster-recovery.mjs` rehearsal confirms lost-reply recovery after an
intervening PM change, exact retry across section navigation, week draft retention,
confirmed replacement/deletion, both editors, seven receipts and seven distinct
notifications. Controls and dialogs fit at 320/768/1440px; the phone screenshot
was inspected. No runtime errors or outgoing emails were captured. The migrated
`smoke-settings-list-recovery.mjs` also passes against the compiled build, including
read timeouts, late replies, retained drafts and token recovery without replay.

Stacked on #207, whose CI run 42423815285 is green. Keep this PR draft. Migration
0071 ran only in disposable local fixtures; no production migration, deployment,
native release or real-org/provider mutation. Phase 2 remains 47/79: the technical
dashboard control pad and broader confirmation/error/UX gates remain open.
Twenty necessary tracked Markdown files remain; no new Markdown file was added.

## Technical dashboard rundown recovery (2026-11-07, not deployed)

Four real-auth Worker baselines reproduced repeated Next advancing twice, an old
click controlling a newly selected show, expired transport executing, and dashboard
access bypassing rundown permissions. Three UI baselines reproduced indefinite
feedback/command waits and enabled transport without confirmed state.

The eight rundown/lyrics controls now use a dedicated member-authorized RPC and
RundownRelay command path. The previous technical-control RPC rejects these
transport actions. Current session, dashboard access and rundown control/PIN are
checked before dispatch; the relay checks live rundown authority inside its
serialized command handling. Commands carry the reviewed show/date, revision,
request ID and original five-second deadline. Reads never initialize or relabel a
room. Starts skip section headings, paused starts preserve elapsed time, and
adjustments remain in the authoritative transport implementation.

Migration 0072 adds org/actor/request receipts, binding each request to its
original payload and storing its terminal outcome. Retrying an uncertain request
uses the original relay ID/revision/deadline. Completed receipt replay does not
modify a newer show state. D1 receipts and relay state do not share a transaction;
if the receipt outcome was not persisted, the relay's duplicate acknowledgement
recovers it. If that acknowledgement is no longer available, revision/expiry
checks prevent replay and the UI asks the operator to review current feedback.
It does not claim an expired or conflicted uncertain command never ran.

The dashboard retains confirmed state, timestamps failures, bounds reads at eight
seconds and commands at ten, and keeps exact retry available across account/org-
scoped SPA navigation. Unknown, stale, unprepared, locked and unconfirmed states
block fresh commands. Successful acknowledgement survives a subsequent read
failure. End show confirmation follows show identity across item advances; hiding
lyrics requires confirmation and retains the reviewed revision.

Verification passes: 17 real-auth Worker cases, 11 new UI cases plus the existing
nine stream-health cases, the full web suite (2,314 unit / 1,116 Worker), typecheck
and production build. Main bundle: 551,540 raw / 174,413 gzip bytes.
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-tm-rundown-recovery.mjs`
passes against the compiled Worker and Chrome with disposable authenticated D1.
It withholds a successful Next reply, advances again independently, navigates
away/back and retries the exact request without changing the newer item/revision.
It also tests bounded read recovery, late replies, confirmed lyrics/show end,
320/768/1440px panel/dialog containment and 44px touch targets. Three command
receipts remain, no runtime errors or outgoing emails. Phone screenshot inspected.

Stacked on #208; CI run 42426620978 is fully green. Keep this PR draft. Migration
0072 ran only in disposable local fixtures. No production migration, deployment,
native release or real-org/provider mutation. Phase 2 remains 47/79: technical
display blanking, legacy graphics clear and stream commands still require their
own authoritative recovery work, along with the remaining broad UX/error gates.
Twenty necessary tracked Markdown files remain; no new Markdown file was added.

## Technical kiosk controls share safe command recovery (2026-11-07, not deployed)

Two real-auth Worker baselines proved the technical dashboard's old blank action
re-blanked kiosks after another controller restored them, both on a lost-reply
retry and after a stale confirmation. The dashboard now uses the same kiosk
editor and atomic receipt/revision command handler as Settings. The old technical
RPC rejects both blank and restore actions. The card names kiosk displays and
explains that connected kiosks apply the desired state on their next poll.

Dedicated technical RPCs retain existing dashboard access without extending
Settings' permanent settings:members permission. Owners/admins/TMs use their
current role; temporary device operators use current dashboard:tm grants. The
atomic commit rechecks session, membership/role revision, organization deletion,
and live grant contents, revocation and dates. Grant dates use the organization's
local day, with a commit bound at its actual next date transition and a timezone
setting guard. This handles DST day length without treating a UTC date as venue
local time. Request receipts remain shared across Settings and dashboard entry
points and isolated by org/actor/request.

The shared editor remounts on account/org/surface changes so an open confirmation
cannot follow another workspace. Read Retry stays visible and disabled during an
initial retry, failures stop automatic polling, and a late command snapshot does
not replace feedback read after that command began. Uncertain commands remain
available across navigation and between the two entry points. Blank requires a
confirmation; restore does not. Companion's existing revision advancement and
the authenticated kiosk polling contract remain intact.

Verification passes: 13 new real-auth Worker cases plus nine existing kiosk
command cases; ten shared editor cases including four new cases, plus nine
existing stream-health cases. Full web suite: 2,318 unit / 1,129 Worker tests;
typecheck and production build pass. Main bundle: 551,588 raw / 174,455 gzip bytes.
`smoke-kiosk-display-command.mjs` passes in both default Settings mode and
`--technical` dashboard mode against compiled Chrome/auth/disposable D1. Each
rehearsal verifies bounded unknown reads, confirmation/cancel, lost-reply retry
across navigation, preservation of a newer Companion restore, late replies,
fresh kiosk polling and explicit restore. Dialogs and 44px targets fit at
320/768/1440px; the technical phone screenshot was inspected. Each fixture has
three receipts and no outgoing emails or browser runtime errors.

Draft PR #210 is based on #209, whose CI run 42428247129 passed both jobs.
No new migration, production deployment, native release or real-org/provider changes.
Phase 2 remains 47/79: technical streaming and graphics controls and the remaining
product-wide gates still need work. Twenty necessary tracked Markdown files
remain; no new Markdown file was added.


## Technical stream controls preserve reviewed commands (2026-11-07, not deployed)

Two real-auth Worker baselines reproduced the dashboard's Go Live retry
restarting outputs after Stop and starting destinations added after confirmation.
The old RPC discarded the request ID, input and reviewed destination versions.
The dashboard now uses the existing durable stream-output command handler with
strict request/input/target validation, fresh sessions and current dashboard plus
stream permissions. The legacy technical RPC rejects streaming actions. No second
output coordinator or migration was added.

Go Live names the input and reviewed destinations; multiple ready inputs require
a choice. Stop has its own confirmation and can supersede unfinished Go Live,
including retained targets after navigation and a failed feedback read. Command
history is scoped to account and organization, read/write waits are bounded at
8/10 seconds, exact retries keep the original payload, and delayed older command
replies cannot overwrite newer Stop feedback. Provider failures stay visible per
destination. Status reports output enablement rather than treating configuration
counts as proof of broadcasting. The team activity notification is retained,
deduplicated by receipt and retryable independently of completed output writes.

Verification passes: 15 new real-auth Worker cases and 11 UI cases; existing
stream command/status and input-health cases remain green. Full web suite:
2,329 unit / 1,144 Worker tests; typecheck and production build pass. Main bundle:
551,588 raw / 174,463 gzip bytes. `smoke-tm-stream-recovery.mjs` passed against
compiled Chrome/auth/disposable D1 and the isolated provider stub. It verifies
named confirmation/cancel, lost Go Live reply then an independent Stop, exact
retry across navigation without restarting outputs, bounded read recovery and
late replies, Stop during slow provider creation, and successful exact Stop retry.
Four command receipts remain, zero browser runtime errors, and no external
provider writes. Controls/selects and confirmation fit at 320/768/1440px with
44px targets; the phone screenshot was inspected.

Stacked on #210; keep draft and open only after its CI succeeds. Nothing deployed
or released, and no real organization/provider data changed. Phase 2 remains
47/79: the legacy graphics-clear control and the remaining product-wide UX and
acceptance gates are still open. Twenty necessary tracked Markdown files remain;
no new Markdown file was added.


## Technical graphics controls preserve newer output (2026-11-07, not deployed)

The dashboard's old Clear left Program graphics on air and replaying it erased
newer lower thirds. Real-auth Worker baselines reproduced both failures. The
new command reviews Program and relay revisions, uses org/actor/request receipts,
and rechecks current sessions and permissions. Migration 0073 advances Program
revisions for every active-pointer writer and edits to active templates. It is
applied only to local fixtures. Shared permission guards preserve the existing
Settings and technical-dashboard grant rules.

Program and lower-third relay commits are independent and their outcomes remain
visible. Exact Retry recovers the original result without clearing newer output,
including after navigation and relay eviction. Relay writes serialize and persist
before changing memory or broadcasting; a persistence failure leaves current
output intact. Confirmation names the graphics, reads/writes have deadlines,
failed reads stop polling, and saved templates/scenes remain available. The old
technical RPC is removed, with a build boundary check preventing its return.

A separate request-wrapper regression proved the overlay used first-unconstrained
replica sessions for publication, Clear and replacement reads. The endpoint now
reads primary data, since a display does not share the operator's write cookie.
Dashboard feedback also retains the overlay's legacy single-graphic fallback
when the multi-graphic list is empty.

Verification: 21 real-auth graphics Worker cases, 11 UI cases, and the overlay
primary-read regression pass. Full web suite: 2,340 unit / 1,164 Worker tests;
typecheck and production build pass. Main bundle: 551,588 raw / 174,444 gzip bytes.
The rebuilt Chrome/auth/disposable-D1 rehearsal passes named confirmation/cancel,
actual clearing of both display endpoints, lost reply then exact Retry across
navigation, preservation of newer publications, stale confirmation rejection,
bounded read recovery and late replies. Controls/dialogs fit 320/768/1440px with
44px targets; phone screenshots inspected. Three receipts, five retained saved
templates, no browser runtime errors or outgoing emails.

Stacked on #211, whose CI run 42430451510 passed both jobs; keep draft. No production
migration, deployment, release or real-org changes. Phase 2 remains 47/79 pending
the remaining requirements and broader acceptance checks. Twenty necessary
tracked Markdown files remain; no new Markdown file was added.


## Phase 2 catalog and error-visibility acceptance (2026-11-07, not deployed)

Audited the 14 new catalog actions against their actual relay tests and compiled
browser rehearsals. The disabled/retry coverage now explicitly includes both
lyric directions and both media actions. A disabled media cue sends nothing on
manual Fire or clock advance. A confirmed output failure retains its execution
identity on Retry, uses a new request, and rejects the old acknowledgement.
Previous Lyrics follows the same disable/kill/retry/re-fire behavior as Next.

Full web suite passes: 2,340 unit / 1,166 Worker tests. Web typecheck passes.
The app code is unchanged from the graphics build at b299e9e; that production
build passed at 551,588 raw / 174,444 gzip main-bundle bytes. Bridge TypeScript
build also passed. `node scripts/check-phase2-catalog.mjs` is the repeatable
compiled-browser acceptance entry point after the web build; it captures each
case's log/result in a temporary directory and stops on failure. Optional case
names run only those cases and never report the whole gate passed.

All seven browser cases passed on the current compiled app:

- `catalog-targets`: named rundown jump selects the reviewed item with zero
  elapsed; the compiled DMX adapter sends actual loopback Art-Net with all 512
  channels black, and Restore returns the original level.
- `propresenter-cues`: the compiled adapter resolves the prop, clears only props,
  waits 205 ms, triggers it, then sends Previous and Clear Props to the loopback
  HTTP simulator. No Clear All or external device call.
- `lyrics-steps`: both event types and operator/display controls step saved song
  sections. The confidence lyric node remains mounted, line breaks remain, and
  Clear removes output. Updated the stale empty-library selector to the existing
  Create manually button; the first attempt failed on New song before any lyric
  action, and the rerun passed.
- `named-timers`: independent Start/Stop output, reviewed restart, held disconnected
  output, preserved deadlines across restart and pinned-show isolation pass.
- `media-cues`: actual audio/video decode and playback progress, timed Play/Stop,
  fullscreen, cleared video after Stop, duplicate-output exclusion, disable,
  failed-cue Retry, disconnect stop and explicit re-enable all pass.
- `crew-message`: two deliberate Production Chat posts, no duplicate on Retry,
  no Planning Chat post, unchanged stage message and preserved line breaks.
- `trigger-controls`: clock continues through automatic cue pause; manual Fire,
  timed/operator resume, no replay of held cues and the safety kill switch pass.

The relay tests cover disable and retry/re-fire across all 14 actions in
`timecode-catalog-targets`, `timecode-propresenter`, `lyrics-steps`, `named-timers`,
`media-cues`, `crew-message` and `trigger-controls` Worker suites. Browser evidence
is in the two catalog result directories HvrNrU and ImKiI9 under the system temp
folder; the first contains the Bridge build plus target/ProPresenter passes and
the stale-selector failure, the second contains all five remaining passes.
ProPresenter and confidence phone screenshots were inspected.

The error-visibility acceptance check also passes. The compiled
`smoke-device-connection-errors.mjs` exposes a refused connection's reason and
timestamp, retries to connected, and recovers a socket outage without reload.
`timecode-execution.worker.test.ts` proves a rejected graphics event stays failed
and reaches an actual read-only display WebSocket via the safe projection,
without payloads, errors or full event-list leakage. The compiled
`smoke-rundown-clock-rendering.mjs` sampled 281 times over 2.5 seconds: the clock
advanced through four displayed values with zero rundown-body rerenders; pause,
warning/overtime and Next progress behavior also passed. Logs are retained in
/tmp/showpilot-error-visibility-gate.log.

These close the catalog enable/retry requirement, catalog gate and error-visibility
gate. Phase 2 is now 50/79 verified, with 29 remaining. This is not the full Phase 2
gate. No production deployment, native release, real-org changes or physical
hardware claims. Keep the acceptance change draft and open it only after #212's
CI passes. Twenty necessary tracked Markdown files remain.


## Operator connection consistency (2026-11-07, not deployed)

Chat and Timecode now share the meanings and labels for disabled, connecting,
connected, reconnecting, disconnected and error. Playback remains separate from
transport readiness: a confirmed, stopped clock is not an offline clock.
Timecode's header, large display, Song Studio and media-output panel consume the
same show-scoped connection. Initial clocks show placeholders; the timeline and
media-output list cannot report empty before a confirmed snapshot. Reconnecting
keeps the last confirmed state, while changing shows hides the previous state.

Chat previously reported Connected and flushed its outbox on socket open, before
room hydration. It now waits for the room snapshot, bounds initial connection and
hydration to eight seconds, retries constructor failures, ignores superseded
socket callbacks and sends queued messages only after confirmation. Subsequent
history responses do not re-flush pending messages. Reconnect includes a timestamp
and retains queued text. The notice scrolls with the conversation so it does not
consume the message viewport on a short phone screen. All four chat callers pass
the same status, timestamp and retry behavior; the Chat header and details panel
use the same label instead of mixing Live and Connected.

Both transports now retire timed-out ownership before asking the socket to close.
Two new tests reproduced the old behavior: a stalled network close handshake left
both clients Connecting beyond their deadline. The fix starts recovery without
waiting for that handshake, and late messages/close events cannot affect the
replacement connection. Existing timecode source-stop and no-replay behavior is
preserved. Board has no invented transport/Live label.

Validation on the final app:

- Full web suite: 2,349 unit and 1,166 Worker tests passed. Typecheck and production
  build passed. Main bundle is 551,648 raw / 174,467 gzip bytes.
- `smoke-connection-status.mjs` uses actual compiled pages, authentication, D1 and
  relays, delaying delivery of real WebSocket messages. Timecode, Song Studio,
  Chat, Show and Board navigate without a document reload. The shared clock
  survives route changes; initial unknown state, deadlines, reconnect, old
  callbacks and exactly one queued-message delivery all pass.
- The first browser pass also exposed Media outputs saying Disconnected and
  empty during initial Timecode confirmation. That panel now uses the shared
  state, with a regression test. Initial failed assertions for the uppercase
  Connection heading and full-screen Board structure were corrected to inspect
  their actual DOM; product assertions were retained.
- At 320, 768 and 1440px, the retry control is reachable and at least 44px, and
  the queued message remains readable in the scrollable conversation. Both phone
  screenshots were inspected. No browser runtime errors or outgoing email.
- Existing `smoke-timecode-timeline.mjs` passes ordering, next cue, payloads,
  sticky transport, failure Retry, retained disconnect state and no cue replay.
  Its expected label is now Reconnecting. `smoke-chat-rooms.mjs` passes 2,003
  seeded messages, three-room switching, direct-message isolation, back/forward,
  real older-history retry, delayed history isolation and invalid-room recovery.

Logs: /tmp/showpilot-connection-full4.log, /tmp/showpilot-connection-tsc5.log,
/tmp/showpilot-connection-build4.log, /tmp/showpilot-connection-browser5.log,
/tmp/showpilot-connection-timeline2.log and /tmp/showpilot-connection-rooms1.log.
The stalled-close baseline and focused fix logs are
/tmp/showpilot-connection-close-before.log and
/tmp/showpilot-connection-close-after.log.

Phase 2 advances to 51/79 verified, with 28 remaining. The full Phase 2 gate stays
incomplete. Stack this draft on #213, whose CI run 42433557842 passed both jobs.
No production deployment, migration, release or real-organization changes.
Twenty necessary tracked Markdown files remain.


## Native implementation and controller acceptance (2026-11-07, not released)

[Unsigned run 42432936054](https://github.com/reydisse/showpilot/actions/runs/42432936054)
completed successfully on all four platforms at
`b299e9ed5c8718c94bced425817581ffd44eba0b`. Native and shared source is unchanged
between that build and web acceptance commit `19b842e`. No signing secrets were
used; searching `test-build.yml` for `secrets.` returns no matches.

| Platform | Desktop and Bridge bundles | Native probes |
| --- | --- | --- |
| Windows | [Download](https://github.com/reydisse/showpilot/actions/runs/42432936054/artifacts/13599235550) | Passed |
| Linux | [Download](https://github.com/reydisse/showpilot/actions/runs/42432936054/artifacts/13598054046) | Passed |
| Intel Mac | [Download](https://github.com/reydisse/showpilot/actions/runs/42432936054/artifacts/13599555482) | Passed, including CoreMIDI |
| Apple Silicon | [Download](https://github.com/reydisse/showpilot/actions/runs/42432936054/artifacts/13598955183) | Passed, including CoreMIDI |

These are unsigned test artifacts, not production releases. Artifact retention
ends November 22, 2026. Each platform passed real OS credential-store tests,
compiled MIDI transport, native LTC and compiled local-show probes. Each native
LTC run delivered 20 decoded frames through the actual Rust runtime/queue and
compiled sidecar to an authenticated fixture WebSocket, ending at 00:00:01:22.
The audio capture factory supplies independently encoded 48 kHz PCM in 10 ms
blocks; it replaces the hardware input, not the decoder or sidecar. Both Mac
jobs also passed the actual CoreMIDI virtual-port test, including input filtering,
LED output, hotplug, stale generations, lease expiry and cleanup.

The compiled local-show probe passed encrypted preparation, native loopback
control, OS vault retrieval, equipment dispatch, duplicate suppression, exclusive
engine ownership, forced-crash recovery with unknown device receipts and cloud
handoff. Its cloud peer is a fixture and its final reconciliation calls the shared
reconciler directly. Full product acceptance still needs the real app's cloud
reconciliation, and the LTC gate still needs native PCM reaching the real app
relay rather than stopping at the fixture receiver. Do not claim those gates from
compilation or these narrower probes.

Current compiled browser rehearsals passed:

- `smoke-midi-controller.mjs`: learning never fires; 77 mappings persist;
  65-cue banks, fire/skip/re-arm confirmation, start/pause/resume/stop/reset/seek,
  scrub/jog/offset, separate MTC/controller inputs and reconnect all work. New
  assertions inspect the latest actual MIDI output message for armed blue,
  next yellow, fired green and the running/paused/stopped transport indicator.
  Controller layouts and 44px controls pass at 320/768/2560px.
- `smoke-native-midi-controller.mjs`: the built web UI and real Tauri Channel
  serialization drive actual fixture-org relay/lyrics changes through simulated
  native IPC. Explicit arm, LED output, unplug rejection, replug, lease recovery,
  re-arm and disarm cleanup pass. The native half is independently covered by
  the real CoreMIDI test above.
- `smoke-midi-reconnect.mjs`: DAW Stop holds the clock and cancels a buffered feed;
  Continue waits for position, SPP/full-frame locate works, static frames do not
  disguise a stopped source, and reconnect preserves input identity. Controller
  messages never enter the MTC parser; another input listener survives.
- `apps/bridge-desktop/scripts/smoke-timecode-inputs.mjs`: rebuilt production Bridge
  UI passes microphone-denial retry, selected channel/rate, lock, unplug/replug,
  last-frame age and Stop at 320/560/680/2560px. Native IPC is a fixture here.

The current full web suite remains 2,349 unit / 1,166 Worker tests, with passing
web typecheck/build. It includes the MIDI controller and transport suites, real
Worker LTC loss/format/eviction tests, and HTTP/WebSocket rejection of unsupported
sources. Selecting LTC cannot pretend it is active without valid Bridge audio.
The Bridge UI typecheck/build passed separately. No application source changed
for this acceptance record; the new browser LED assertions passed on that build.

Logs: /tmp/showpilot-native-midi-browser2.log,
/tmp/showpilot-native-controller-browser1.log,
/tmp/showpilot-native-midi-reconnect.log,
/tmp/showpilot-native-bridge-ui-build.log and /tmp/showpilot-native-ltc-ui.log.
Read-only macOS device inventory found no attached USB MIDI/audio test device;
audio inputs are the built-in/continuity microphones. Physical APC/DAW cabling and
a venue audio interface have not been exercised. The MIDI gate's available-gear
coverage uses OS virtual ports and protocol fixtures, with this limitation stated.

This closes the controller/feedback implementation, MIDI acceptance and LTC
implementation requirements. Phase 2 is 55/79 verified, with 24 remaining. The
LTC integration gate, local-show gate and full Phase 2 gate remain open. No
production release, deployment, real-organization writes or outgoing email.
