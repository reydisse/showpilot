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
checks remain unchanged. The unauthenticated graphics RPC removal is included
below. Pushing this branch does not deploy either fix.

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

### Phase 0 Bridge credential rollout

Apply `0048_bridge_installation_credentials.sql` before deploying the Bridge
credential changes. The SQL adds three tables and five named indexes. It does
not alter existing settings or credentials, so the previous Worker can keep
running after the schema change.

Use the bookmark and migration procedure above. Before applying the file,
confirm that none of its tables or indexes exists and that the foreign key
check returns no rows. Count legacy keys without selecting their values:

```sh
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT name, type FROM sqlite_master WHERE name LIKE 'bridge_%' ORDER BY name; SELECT COUNT(*) AS legacy_key_rows FROM app_setting WHERE key = 'api-key'; PRAGMA foreign_key_check;"
```

After applying the file, the schema query must return three tables and five
named indexes. All three tables must be empty, the legacy key count must be
unchanged, and the foreign key check must still return no rows:

```sh
pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT name, type FROM sqlite_master WHERE name LIKE 'bridge_%' ORDER BY name; SELECT (SELECT COUNT(*) FROM bridge_installation) AS installations, (SELECT COUNT(*) FROM bridge_credential) AS credentials, (SELECT COUNT(*) FROM bridge_credential_audit) AS audit_entries; SELECT COUNT(*) AS legacy_key_rows FROM app_setting WHERE key = 'api-key'; PRAGMA foreign_key_check;"
```

Only then append the filename to `applied-remote.txt`. Keep the preflight,
bookmark, migration result, and postcondition output in the private release
record outside the repository.

After deployment, the Worker converts legacy keys to hashes on Bridge
reconnection or in bounded scheduled batches. Existing Bridges keep using the
same header credential. Conversion removes the plaintext setting. Verify that
`legacy_key_rows` reaches zero without reading or logging credential values.
Use a disposable test organization to check installation creation, rotation,
revocation, and Bridge reconnects.

**Rollback boundary:** before credential conversion, the previous Worker can
use the unchanged settings with the additional tables present. After conversion,
do not roll back to a Worker that only accepts the removed plaintext settings.
Deploy a corrective build that retains installation authentication and the
new schema. A database restore requires the explicit owner approval described
above and can discard newer show data. Never recreate plaintext credentials
from a backup as an automatic rollback step.

### Current state

The production manifest records every migration through `0063_team_command_receipts.sql`.
Migration 0048 was applied on 2026-11-05 after a clean preflight and a saved
Time Travel bookmark. Its postcondition verified three empty tables, five
named indexes, an unchanged legacy key count, and no foreign key violations.
Migration 0051 (`device.latencyMs`) was applied on 2026-11-09 after a clean
preflight and a saved Time Travel bookmark. Its postcondition verified the
NOT NULL integer column with default 0 and range check, all existing devices
at zero latency, and no foreign key violations.
Migrations 0052 through 0056 (`operational_error`,
`organization_creation_receipt`, `chat_pass_revocation`,
`chat_pass_creation_receipt`, `invitation_response`) were applied in order on
2026-11-10 after a clean preflight and a saved Time Travel bookmark. Each
postcondition verified its empty table, columns, and named indexes, existing
row counts were unchanged, and no foreign key violations were reported.
Migrations 0057 (`song.writeRevision`, ten song revision triggers and
`song_write_receipt`) and 0058 (`audio_write_receipt`) were applied in order on
2026-11-10 after a clean preflight and a saved Time Travel bookmark. Their
postconditions verified the NOT NULL integer column with default 0 and every
existing song at revision 0, all ten triggers, the empty receipt tables and
named index, unchanged existing row counts, and no foreign key violations.
Migration 0059 (`device_write_receipt`) was applied on 2026-11-10 after a clean
preflight and a saved Time Travel bookmark. Its postcondition verified the
empty table and no foreign key violations.
Migration 0060 (`stream_destination_write_receipt`) was applied on 2026-11-10 after a clean
preflight and a saved Time Travel bookmark. Its postcondition verified the
empty table and no foreign key violations.
Migration 0061 (`stream_output_command`, `stream_output_intent`) was applied on 2026-11-10 after a clean
preflight and a saved Time Travel bookmark. Its postcondition verified the
empty tables, named index, and no foreign key violations.
Migration 0062 (`stream_input_command`, `stream_input_lifecycle`, `stream_input_health`) was applied on 2026-11-10 after a clean
preflight and a saved Time Travel bookmark. Its postcondition verified the
empty tables and no foreign key violations.
Migration 0063 (`member.managementRevision`, `member_management_revision`, `team_command_receipt`) was applied on 2026-11-10 after a clean
preflight and a saved Time Travel bookmark. Its postcondition verified the
NOT NULL integer column with default 0 and every existing member at revision 0,
the trigger, the empty receipt table, unchanged existing row counts, and no
foreign key violations.
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
It was applied to production on 2026-11-10 and is recorded in the remote
migration manifest.

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
receipts remain after channel deletion. It was applied to production on
2026-11-10 and is recorded in the remote migration manifest.

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
payload. It was applied to production on 2026-11-10 and is recorded in the
remote migration manifest.

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
It was applied to production on 2026-11-10 and is recorded in the
remote migration manifest. The 20 necessary tracked Markdown files
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

Migration 0061 was applied to production on 2026-11-10 and is recorded in the
remote migration manifest. Twenty necessary tracked Markdown files remain. Phase 2 stays 46/79:
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
resources. It was applied to production on 2026-11-10 and is recorded in the
remote migration manifest. The 20 necessary tracked Markdown files remain.
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
code. It was applied to production on 2026-11-10 and is recorded in the
remote migration manifest.

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
reconciler directly. Full local-show product acceptance still needs the real app's cloud
reconciliation. The separate LTC integration rehearsal below extends the native
probe through the actual app relays; compilation and the fixture receiver alone
do not prove that path.

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

`smoke-native-ltc-relay.mjs` now passes the complete LTC software path. It builds
on the native Rust PCM probe using the actual compiled sidecar and a real fixture
API key issued by the local app. Audio samples pass through the decoder/queue,
BridgeRelay and show-pinned TimecodeRelay to the operator clock at 00:00:01:22.
Crossing 00:00:01:15 fires a stage-message cue, acknowledged by the real
RundownRelay. Native input shutdown holds the clock and does not replay the cue.
Only the audio capture device is substituted. The native decoder, compiled
Bridge, authentication, relays and operator display are real.

The first rehearsal correctly rejected cue creation from the fixture's separate
inspection session with 409. The test now creates the cue from the browser session
that owns timecode, preserving that authorization boundary. The final run passes
with no outgoing email. Additional logs are
/tmp/showpilot-ltc-relay-sidecar-build.log and /tmp/showpilot-native-ltc-relay2.log.
Run the sidecar build, then the rehearsal with SHOWPILOT_SMOKE_RUNTIME=miniflare;
it starts the existing ignored native PCM probe against its disposable app.

This closes the controller/feedback implementation, MIDI acceptance, LTC
implementation and LTC integration gate. Phase 2 is 56/79 verified, with 23
remaining. The local-show and full Phase 2 gates remain open. No production
release, deployment or real-organization writes. Physical audio-interface testing
is not claimed.


## Local-show preparation and cloud handoff (2026-11-07, not deployed)

The complete product rehearsal exposed two preparation blockers that the narrower
native probe did not cover. The rundown route negated the `hasPendingCommands`
function itself, keeping Prepare and Sync disabled even with no pending changes.
It now calls the function. Home Assistant device actions require current
discovery, but local preparation had no discovery callback. Preparation now
connects the approved target on the reviewed installation, reads its current
actions, rejects a venue handoff, and rechecks operator authority. Discovery does
not execute a service. Saved credentials remain encrypted during delivery.

Six new Worker regressions cover successful encrypted preparation, removed
entities, malformed or failed discovery, an installation handoff during discovery,
and reconnect before a subsequent local session. The first five tests failed
before the discovery fix; all 24 preparation tests now pass.

`smoke-local-show-handoff.mjs` exercises the built app with actual auth, D1,
BridgeRelay and RundownRelay; the rebuilt native sidecar and OS vault; the shipped
offline HTML/JS; and an authenticated Home Assistant equipment simulator. The
Chrome automation channel supplies Tauri IPC transport and unrelated desktop
decorations. Every local-show response comes from the real native loopback API.
It does not manufacture preparation, timer state, device receipts or sync results.

Verified behavior:

- The app prepares the two-item rundown and its approved device cue, with fresh
  Home Assistant discovery and no equipment service execution.
- With the actual cloud Worker stopped and unreachable, the shipped offline page
  enables local control, advances both items and sends the authenticated device cue.
- Finish holds the timer and preserves its journal and device receipt.
- After restart, the cloud still has its original revision. Dropping the sync
  response after the real commit preserves the local journal; the app retry
  confirms the existing receipt without another revision or device execution.
- A second preparation reconnects the approved device. A later local session
  conflicts with a newer cloud edit; the app preserves the complete local journal
  and the cloud's newer revision, current item and stage message.
- The equipment received exactly one service command across both sessions and
  all sync attempts. No external email was sent. Temporary data, browser profiles,
  native processes and fixture OS-vault keys are cleaned up.

Validation: 2,349 unit and 1,172 Worker tests, web typecheck and production build
passed. The main client bundle is 551,648 raw / 174,468 gzip bytes. Native source
is unchanged from four-platform unsigned run 42432936054. PR #215's Native Rust
and main CI jobs also completed successfully before this PR was opened.

Logs: /tmp/showpilot-local-handoff-before6.log, /tmp/showpilot-local-ha-before.log,
/tmp/showpilot-local-ha-after2.log, /tmp/showpilot-local-handoff-after2.log,
/tmp/showpilot-local-handoff-full.log, /tmp/showpilot-local-handoff-tsc4.log,
/tmp/showpilot-local-handoff-build2.log and
/tmp/showpilot-local-handoff-native-build.log. To repeat, build web and the Bridge
sidecar, then run `SHOWPILOT_SMOKE_RUNTIME=miniflare node
apps/web/scripts/smoke-local-show-handoff.mjs`.

The rehearsal also reports recoverable React #418 hydration warnings on native
page loads. The local workflow completes, but this remains an open product-wide
UI finding. Native-only first-render markup is the next investigation target;
this record does not claim a clean native hydration pass.

Phase 2 is 59/79 verified, with 20 remaining. The full local mode satisfies the
conditional queue-only fallback requirement; no queue-only substitute is claimed.
The overall Phase 2 gate remains open. No production deployment or release.


## Desktop hydration preserves the operator page (2026-11-07, not deployed)

The local-show rehearsal found recoverable React #418 errors whenever Desktop
opened the rundown page. The server could not see Tauri and rendered web markup;
the first client render immediately selected native markup. Sidebar QuickActions,
the Desktop status bar and the rundown local-show section differed, causing React
to replace the operator tree. Device connection guidance had the same pattern.

`useDesktopRuntime` now supplies a stable false server snapshot through
`useSyncExternalStore`. Hydration first matches the server HTML, then renders
native controls from the actual runtime. The relevant render branches and
local-show polling use that hook. Imperative actions continue to check the real
runtime directly. No error is suppressed, and runtime reporting remains enabled.

A renderToString/hydrateRoot regression failed before the fix. It now reports no
recoverable error, preserves the original operator button DOM node, reveals the
native controls and successfully invokes Check-in. Thirty targeted native/UI
tests pass. The strengthened `smoke-local-show-handoff.mjs` rejects browser
runtime errors and completes the actual compiled-app/native-engine offline and
cloud handoff with zero runtime or hydration errors, one device command and zero
external emails. Both lost-response retry and conflicting-revision preservation
still pass.

The first stricter run also exposed a test-transport lifecycle issue: a native
status reply could arrive after navigation destroyed its requesting Chrome
context. The fixture now tracks actual context creation/destruction and drops
replies only for retired contexts, never delivering them into the next page.
The final browser run passes both IPC and runtime-error assertions.

Full validation passed: 2,350 unit tests, 1,172 Worker tests, typecheck and the
production build. The client entry is 551,735 raw / 174,479 gzip bytes, within
budget. Logs: /tmp/showpilot-desktop-hydration-before.log,
/tmp/showpilot-desktop-hydration-after.log,
/tmp/showpilot-desktop-hydration-browser2.log,
/tmp/showpilot-desktop-hydration-full.log,
/tmp/showpilot-desktop-hydration-tsc2.log and
/tmp/showpilot-desktop-hydration-build.log.

This resolves the native hydration finding recorded with #216. Phase 2 remains
59/79 verified: the broader product-wide UX gate still needs its other checks.
No production deployment, native release or real-organization changes.

## Phase 2 operator labels and scheduled dashboard hydration, 2026-11-07

Show Flow now labels its panel layout and explains the presets in a keyboard
menu. Stored preset IDs and dimensions are unchanged. Reports spell out the two
manager roles, announce the selected note role, and wrap their 44px controls on
small screens. Report/debrief timing labels explain elapsed, planned and
over/under durations. The Owner label uses normal theme text instead of error
red, with a neutral avatar background.

The compiled-app copy rehearsal verifies layout keyboard selection and reload
persistence, manager note controls at 320/768/1440px, the Production Manager show
menu at 320/768/1024/1440px, report dates with named months, spacing in the four
reported phrases, named Settings spinbuttons and removal of the obsolete
Native/7 DAYS labels. Screenshots were inspected. A completed fixture rundown
also verifies the debrief timing labels.

That scheduled-show case exposed another hydration error: header times used the
server's local timezone on the server and the browser's timezone on the client,
while the countdown independently initialized Date.now on each side. The show
picker and call/start times now share the org timezone or a hydration-safe
device fallback. Dashboard clocks render their server snapshot until hydration,
then start ticking. The expanded browser rehearsal reports no runtime errors;
an SSR/hydration regression preserves the operator control DOM node despite
different server and browser clocks.

The navigation rehearsal passes all 21 sidebar routes and 13 Settings sections,
including selected-room restoration, direct-entry fallback and reachable Back
controls at 1440/1024/768/320px. Its initial Crew Check-in timeout was an outdated
heading assertion. A follow-up hit test found a closed dialog whose exit
animation was suspended in a background Chrome tab. The interactive rehearsal
now foregrounds the tab and waits within a fixed bound for pointer readiness.
It still fails on a genuinely blocked target.

Validation: 2,351 unit tests, 1,172 Worker tests, typecheck and production build
passed. Main entry: 551,805 raw / 174,519 gzip bytes. Logs:
/tmp/showpilot-copy-full2.log, /tmp/showpilot-copy-tsc3.log,
/tmp/showpilot-copy-build3.log, /tmp/showpilot-copy-browser3.log (scheduled-show
failure), /tmp/showpilot-copy-browser4.log (passed), and
/tmp/showpilot-copy-navigation.log. Screenshots:
/tmp/showpilot-copy-layout-768.png, /tmp/showpilot-copy-manager-notes-320.png,
/tmp/showpilot-copy-show-menu-320.png.

Phase 2 is 60/79 verified. Reports still needs its loading/retry, shared dialog,
keyboard and narrow-list work. Static follow-up also found that the first-session
onboarding checklist still suppresses failed reads and writes; that remains open
in the silent-failure ledger. No production deployment, native release or real
organization changes.


## Phase 2 Reports recovery, 2026-11-07

Reports now bounds detail reads and exports, exposes persistent errors with
Retry, and ignores late responses after changing or closing the selected report.
Exports fetch current saved notes; an aborted PDF cannot download after its
original window closes. The shared Dialog protects unsaved and unconfirmed
notes on Close, Escape, browser Back and route navigation. Each manager role
keeps its own draft, including through conflicts and lost save replies.

Migration `0074_report_note_recovery.sql` adds note revisions and actor-scoped
write receipts. It must follow 0073 before deploying this code. The receipt and
conditional save commit atomically. An exact replay returns its original outcome
and the latest note without applying the old text again. Changed request payloads
are rejected; concurrent first saves and stale revisions require review. A trigger
includes legacy note edits in revision checks. Current membership and role access
are checked on every request, including retries. This migration ran only in
local disposable fixtures; the production migration manifest is unchanged.

The list now has labeled search, 44px pagination, native report buttons for
keyboard activation, and cards below xl. Browser checks exposed two additional
problems: closing after changing breakpoints lost focus, and long titles could
hide Close in a short window. Focus now returns to the visible report button,
and the title scrolls within a bounded area while Close stays reachable.

Verification: nine new Worker cases and five component/PDF cases, 2,356 unit
tests, 1,181 Worker tests, typecheck and production build passed. The compiled
`smoke-reports-recovery.mjs` rehearsal uses real authentication and local D1.
It covers pagination at 320/768/1024/1440px, 320x480 long-title dialogs, keyboard
activation/focus return, read timeout and late replies, per-role drafts,
Escape/Back discard cancellation, a withheld committed save followed by a newer
save and exact Retry, explicit conflict review, actual PDF/CSV downloads with
fresh saved notes, and closing during export. Final storage has five receipts
and two notes; no runtime errors or outgoing emails. The existing operator-copy
browser regression also passed. Phone screenshots were inspected.

Logs: /tmp/showpilot-report-notes-before.log (four reproduced failures),
/tmp/showpilot-report-notes-after2.log, /tmp/showpilot-reports-ui-tests2.log,
/tmp/showpilot-reports-full2.log, /tmp/showpilot-reports-tsc4.log,
/tmp/showpilot-reports-build5.log, /tmp/showpilot-reports-browser6.log and
/tmp/showpilot-reports-copy.log. Main entry: 551,905 raw / 174,550 gzip bytes.
Screenshots: /tmp/showpilot-reports-list-320.png,
/tmp/showpilot-reports-notes-320.png and
/tmp/showpilot-reports-long-name-320-short.png.

Phase 2 remains 60/79 verified. This completes the Reports portion of the broad
loading/dialog/keyboard/narrow-screen requirements. First-session checklist
failures, assignment controls, and the remaining product-wide gates are still
open. No production deployment, native release or real-organization changes.


## Phase 2 first-session checklist recovery, 2026-11-07

The first-session checklist previously suppressed read and save errors, marked
items complete before saving, and hid immediately on dismissal. Three UI
regressions reproduced those failures. Reads now have an eight-second deadline
and visible Retry. Writes retain the confirmed checklist until acknowledgement,
with a ten-second deadline and an exact retry retained across navigation in an
account/org-scoped query cache. Failed dismissals stay recoverable, including
when the server saved the dismissal but its reply was lost.

Owner-only commands derive the personal preference key on the server. They reuse
the existing atomic settings receipt and compare-and-set helper. A revision token
inside each saved snapshot prevents a changed-then-restored checklist from making
an old request current again. Conflicts show the saved progress for review before
another change. Unreadable saved state is reported instead of overwritten with
an empty checklist. The public Settings key allowlist remains unchanged. The old
onboarding upsert helper had no remaining callers and was removed. No migration
is needed.

The widget has 44px buttons and links, visible focus, announced completion state,
and a bounded scrolling panel for short windows. The compiled browser rehearsal
uses real local authentication/D1 and withholds actual successful responses. It
passes read timeout/retry/late reply, a lost completion followed by a newer
uncheck, exact Retry after navigating away and back, stale-edit review, a lost
dismissal followed by navigation and Retry, and 320/768/1440px plus 320x480.
Six receipts and one personal record remain; no runtime errors or outgoing
emails. The 320px screenshot was inspected.

Validation: five UI and five real-auth Worker cases, ten existing settings-write
regressions, full 2,361 unit / 1,186 Worker tests, typecheck and production build
passed. The final Worker rerun also passed after TypeScript cleanup. Main entry:
551,911 raw / 174,531 gzip bytes. Logs:
/tmp/showpilot-first-session-before.log (three reproduced failures),
/tmp/showpilot-first-session-ui3.log, /tmp/showpilot-first-session-worker2.log,
/tmp/showpilot-first-session-full.log, /tmp/showpilot-first-session-tsc2.log,
/tmp/showpilot-first-session-build2.log and /tmp/showpilot-first-session-browser.log.
Screenshot: /tmp/showpilot-first-session-320.png.

Phase 2 remains 60/79 verified. This closes the specific checklist gap identified
in the operator-label pass; assignment controls and the broader requirements and
gates remain open. Nothing deployed or released, no real organization data changed.


## Phase 2 Timecode UI gate, 2026-11-07

`node apps/web/scripts/check-phase2-ui-gate.mjs` passes all five browser
rehearsals against the compiled app from 4a241fa, using disposable real-auth,
D1 and relay fixtures. The runner stops at the first failing rehearsal.

- Timeline: sorted rows, compensated next cue, actual running countdown,
  missed/failed attention list, target/tolerance/payload summaries, sticky
  transport at 1440x900 and 320x480, visible disconnect and no replay.
- Editing: inline validation, preserved cue identity/execution history,
  stale/offline draft retention, and a bounded narrow dialog.
- Fields and latency: device/action/tolerance choices, saved song/section
  choices, authoritative timing, and actual lyrics/stage output.
- Lyrics: Next, Previous and Clear work on operator and confidence displays;
  the lyric node stays mounted through slide changes.

The initial run found an obsolete empty-Songs test selector. The current
button is “Create manually”; the corrected runner passed all five checks.
Inspected `/tmp/showpilot-timeline-320.png`, `/tmp/showpilot-cue-edit-320.png`
and `/tmp/showpilot-lyrics-controls-confidence-320.png`. Results are in
`/tmp/showpilot-phase2-ui-gate2.log`. Local full suite at the tested application
commit passed 2,361 unit and 1,186 Worker tests, typecheck and production build.
Only scripts and evidence change here; no app code or dependencies changed.

Phase 2 is 61/79 verified. The 45-minute acceptance run and product-wide gate
remain open. No production deployment, migration, native release or real
organization/device commands were performed.


## Phase 2 assignment keyboard controls, 2026-11-07

The real browser reproduced Decline leaving focus behind and Cancel/Confirm
controls measuring 38px. Assignments now has visible focus styles on all
controls, focuses the optional note when opening Decline, restores focus to the
current Decline button on Cancel, and provides 44px targets. Long locations wrap
within narrow cards, and the confirmation buttons wrap instead of overflowing.
The first implementation tried to focus React's detached previous button; the
browser caught this, and the final implementation tracks the mounted button.

`smoke-assignment-keyboard.mjs` uses compiled Chrome, real authentication and a
disposable personal schedule. Enter/Tab accept, decline and cancel pass, along
with focus visibility, 320x480/768/1440px layouts and actual D1 response notes.
The other person's assignment remains unchanged; no emails are sent. Inspected
`/tmp/showpilot-assignment-decline-320.png`. Existing empty/unavailable and alert
rendering, response API and ownership checks are unchanged.

Final full suite: 2,361 unit and 1,186 Worker tests pass. Typecheck and production
build pass. Main entry: 551,911 raw / 174,541 gzip bytes. Logs:
`/tmp/showpilot-assignment-full2.log`, `-tsc2.log`, `-build2.log`, and
`/tmp/showpilot-assignment-keyboard-after2.log`. Baseline evidence is in
`/tmp/showpilot-assignment-keyboard-before2.log`.

Re-inspected the unchanged Reports/Audio keyboard buttons, Team tablist arrow,
Home and End behavior, and visible Team/Checklist/Incident row actions against
their recorded compiled-browser evidence. With assignment focus verified, the
named keyboard-blockers requirement is complete. Phase 2 is 62/79 verified.
Assignment response timeout/recovery is still a separate observed gap; this
patch does not claim the broad loading or mutation-recovery gate. No production
migration, deployment or release; no new Markdown files.


## Phase 2 missing display organizations, 2026-11-07

Timer and overlay treated unknown organizations as connection errors and kept
checking them. The display-session response now distinguishes a missing
organization from denied access. Both displays show “Organization not found”,
stop automatic checks and offer an explicit retry and home link. Oversized route
slugs never request authorization. Database outages remain retryable failures.
A missing organization never receives a cookie or display pass.

Validation: three reproduced UI failures pass, plus server cases for a missing
organization with an old valid pass and a database outage. Existing denial tests
now assert the explicit access-denied reason. Final full suite passes 2,366 unit
and 1,186 Worker tests; typecheck and build pass. Main entry: 551,911 raw /
174,518 gzip bytes.

`smoke-display-link-validation.mjs` uses anonymous Chrome and the real compiled
Worker. Timer and overlay each remain on the missing-organization view for 31
seconds with exactly one authority call and no output-data requests. Explicit
Retry, malformed route slugs, invalid passes and valid output all pass. Inspected
both 320x480 screenshots. Existing display-access regression passes scoped,
expired and mismatched credentials, protected projections and CORS checks.
The public check-in browser regression also passes identity reconfirmation,
persistent retry, late replies, later-checkout preservation, invalid orgs and
320/768/1440px; D1 records three receipts and leaves the other org unchanged.

Logs: `/tmp/showpilot-display-validation-full2.log`, `-tsc2.log`, `-build.log`,
`-browser.log`, `-access.log`, and `-checkin.log`. The initial full suite found two
old exact-object denial expectations; they now assert the new reason as well.
Phase 2 is 63/79 verified. The separate published Settings kiosk-link item is
still open. No deployment, migration, native release or new Markdown files.


## Phase 2 Settings kiosk display links, 2026-11-08

Access Tokens previously issued only lobby data tokens and offered no browser
display link. Operators can now choose Lobby app/data API, Stage/confidence or
Overlay. The latter two produce the matching protected display URL, a copy
control and “Open display to check”. The default lobby API behavior is retained.
Saved rows identify the purpose. Plaintext tokens and links stay in the creation
notice only and disappear on dismissal, navigation or reload.

Two baseline UI failures now pass; the token component suite has seven passing
cases, including scoped URLs, dismissal and the separate lobby API behavior.
Full suite: 2,369 unit / 1,186 Worker tests pass. Typecheck and production build
pass; main bundle 551,911 raw / 174,544 gzip bytes.

`smoke-kiosk-display-links.mjs` generates both links in the compiled Settings UI
and opens them in separate anonymous Chrome profiles. Actual stage text and
overlay graphics appear at their display routes. Credentials disappear from the
address bar and stay in HttpOnly cookies. Dismissal/reload removes secret fields;
revocation rejects the old link. D1 contains two hashed tokens. Controls fit at
320x480/768/1440px; inspected the narrow screenshot.

Logs: `/tmp/showpilot-kiosk-links-full2.log`, `-tsc.log`, `-build.log`, and
`-browser3.log`. The first suite/fixture attempts overlapped lid-triggered sleep
and timed out; the clean rerun passed. A script-only nested-quote error in the
second browser attempt was corrected before the final run. No timeouts were
increased. Phase 2 is 64/79 verified. No production deployment, migration,
native release or new Markdown files.

The separate 45-minute clock run stopped at minute 19 when macOS entered
Clamshell Sleep at 2026-11-07 22:52:19 America/Toronto. The last relay feed was
22:52:14; the relay correctly reported timecode lost. The run is not acceptance
proof. A new isolated run started at 2026-11-08 05:07:13 UTC with browser feed
and host-load diagnostics; its result remains pending.


## Phase 2 Crew status display, 2026-11-08

Renamed Show Board to Crew status across web navigation, Desktop auxiliary
windows, mobile actions and shared module metadata. Attendance labels now say
checked in/not checked in rather than online/offline. Kiosk metadata distinguishes
stage/confidence output from the lower-thirds overlay. Routes and permissions
keep their existing identifiers.

The populated browser check reproduced a clipped clock at 320px and a withheld
attendance read that never surfaced an error. Crew status now uses the shared
bounded read hook: eight-second deadline, timestamped error, Retry, retained
confirmed attendance, hidden-tab cancellation and failure backoff. No write is
introduced. The header fits narrow screens, every card states its attendance,
and the crew region supports keyboard scrolling. Both empty and populated pages
allow scrolling in short windows; footer actions have 44px minimum targets.

Validation: full web suite passes 2,369 unit and 1,186 Worker tests; typecheck and
production build pass. Main entry 551,939 raw / 174,557 gzip bytes. Mobile verify
passes iOS/Android bundles, web export, all 18 doctor checks and the polling
boundary. ARM Desktop cargo tests pass 24 tests, with one existing ignored test;
format check passes. Native bundle/release workflows were not run for this change.
The polling boundary assertion now recognizes the shared read hook; its existing
12 behavioral tests cover deadlines, cancellation, backoff and late replies.

`smoke-crew-status.mjs` exercises the compiled app with real authentication and
eight disposable crew records. It holds a real refresh reply through the deadline,
checks retained attendance and pending Retry, releases a fresh response and then
the late response, and verifies every card/footer target at 320x480, 390x844,
768x900 and 1440x900. Real PageDown scrolls the crew region. Normal and error phone
screenshots inspected. Seven empty-library flows also pass, including the direct
Team link and reachable 48px action at 320x480. That rehearsal initially sampled
Devices between server render and its first client refresh; it now counts after
the primary action is hydrated and enabled. No application behavior was weakened.
The navigation/handoff regressions passed earlier in this branch, covering 21
routes, 13 Settings sections, retained handoff errors and narrow navigation.

Logs: `/tmp/showpilot-crew-status-before.log` records both reproduced defects.
Final results: `/tmp/showpilot-crew-status-full4.log`, `-tsc3.log`, `-build3.log`,
`-after3.log`, `-empty2.log`, `-mobile-verify2.log`, `-native.log`,
`-navigation.log` and `-handoff.log`. Phase 2 remains 64/79 verified; this closes
the Crew status portion of the broader terminology/read-recovery requirements.
The 45-minute timing run remains pending in its isolated checkout. No production
deployment, migration or release; 20 necessary tracked Markdown files remain.


## Phase 2 navigation discovery, 2026-11-08

My assignments now has an account-menu entry. Signed-in crew-chat links resolve
to the existing Production Chat; guest passes retain their scoped entry points.
The sidebar explains which pages are disabled versus unavailable to the current
role, provides a visible scrollbar and keyboard scrolling, and gives its theme,
fullscreen and collapse buttons 44px targets. Its content is a React component,
so fullscreen's early return cannot conditionally skip its hooks.

Template Studio and the disabled Lower Thirds explainer highlight their parent.
Six hidden pages share a breadcrumb and an explicit parent Link: device details,
Song Studio, incident history, Template Studio, rundown PIN and the disabled
Lower Thirds page. Direct-entry Back works without history; device selection is
retained. Exact parent matching prevents two current-page announcements.

Verification uses the production build, actual authentication and disposable D1:

- Navigation discovery passes account entry, canonical chat, access explanations,
  collapsed/sidebar/fullscreen transitions, actual PageDown and 320/768/1440px.
- All six breadcrumb destinations pass hit-tested 44px Back controls and
  same-document parent rendering at those widths. The graphics case enters the
  protected route and proves the real cloud-disabled redirect. Screenshots were
  inspected, including 320x480.
- The broad audit passes 21 sidebar routes and 13 Settings sections, including
  sidebar visibility, previous-room restoration and direct-entry Back fallback,
  at 320/768/1024/1440px. The earlier seven-library rehearsal verifies the Crew
  status empty-state action links directly to Team.
- Chat regression passes three isolated rooms with 2,003 seeded messages, actual
  older-history retrieval, delayed-reply isolation, Retry, invalid-room recovery,
  SPA Back/Forward and narrow layout. Its pointer helper now waits for hydration;
  a prior run clicked a server-rendered recovery button before React attached it.
- Full web suite: 2,369 unit and 1,186 Worker tests passed. Typecheck and production
  build passed. Main entry is 552,717 raw and 174,997 gzip bytes; budget unchanged.

Evidence: `/tmp/showpilot-navigation-discovery-after5.log` covers the sidebar and
Template Studio; `/tmp/showpilot-navigation-hidden2.log` covers the six hidden
routes after correcting the test's expected rundown heading to the fixture show
name. Other logs are `/tmp/showpilot-navigation-discovery-audit2.log`, `-full4.log`,
`-tsc7.log`, `-build10.log`, and `/tmp/showpilot-navigation-chat-rooms2.log`.
Phase 2 is 65/79 verified. The 45-minute rehearsal is running separately in
GitHub Actions PR #225; it is not counted as passed. Schedule dialog conversion
and the remaining product-wide requirements are still open. Nothing deployed,
migrated or released; no new Markdown files were added.


## Phase 2 Schedule dialogs and hydration, 2026-11-08

Replaced Schedule's final hand-built modal wrapper with the existing Dialog.
All seven editors now trap focus, close on Escape, restore their opener, retain
an accessible close button while the form scrolls, and fit a 320x480 window.
Dialog controls are at least 44px high. Team-builder fields, the response filter,
and the mobile assignment editor have accessible names.

The browser baseline reproduced escaped focus, ineffective Escape, 32-41px
controls, and an Inventory close button outside the viewport. The repaired
`smoke-schedule-dialogs.mjs` passes all seven dialogs at 320x480, 768x900 and
1440x900, including Tab/Shift+Tab, focus return, labels and hit-tested controls.
Phone screenshots inspected. Fixtures send no external email.

That rehearsal also exposed three React hydration errors. Holding the actual
entry script showed server text `Thu, Jan 1` versus browser `Thu 1 Jan`, and the
same difference in the long date. `useDeviceLocale` now gives server and first
browser render the same locale, then uses the viewer's locale. Direct-entry
checks in British, US and Canadian English pass with zero runtime errors.

The other named modal families already use Dialog: Audio, Devices, Graphics,
Template Studio, Songs import, Chat share and Reports. Source audit reconfirms
those conversions and the shared Router error fallback. Explicit route error
handlers also provide Retry, including media output's reload recovery.
`smoke-route-loading.mjs` passes real loader/guard/download timeouts, repeated
Retry, cancellation, ignored late replies and reachable controls at 320px.

The build first exceeded its existing 175,000-byte gzip entry limit by 10 bytes.
Web Push subscription setup now loads after permission is granted; the prompt
still starts directly in the initiating click. Five tests cover prompt order,
denial, reusing subscriptions, org-scoped persistence, failure and Desktop bypass.
The limit is unchanged. Final main entry: 551,713 raw / 174,616 gzip bytes.

Full web suite: 2,374 unit and 1,186 Worker tests passed; typecheck and build passed.
Logs: `/tmp/showpilot-schedule-dialogs-before.log`, `-after3.log`, `-full3.log`,
`-tsc3.log`, `-build3.log`, `/tmp/showpilot-schedule-route-loading.log`, and
`/tmp/showpilot-schedule-hydration2.log`. Phase 2 is 66/79 verified. This closes
the named shared-dialog/route-error requirement; Schedule's remaining reads,
writes and full-page mobile work belong to the still-open broader requirements.
The long rehearsal is still running in PR #225. Nothing deployed or released.


### 2026-11-08: Schedule calendar navigation on phones and future months

The original calendar was hidden below lg. Its arrows changed local month state
without fetching shows, so dates beyond the initial window remained unavailable.
The validated viewed month now lives in the URL and loader dependencies. Queries
fetch the actual month plus any explicitly selected show/date, preserving org
scoping. Next/Previous, the direct month input and browser Back stay consistent.
Selecting a show also selects its month.

Phones have a calendar toggle. Date and navigation controls meet 44px and dates
have full spoken labels. A real screenshot exposed the Schedule title overlapping
header actions; the title now gets its own phone row, actions wrap at 44px, and the
phone header scrolls away instead of covering the calendar.

Validation:
- Full web suite: 2,385 unit and 1,186 Worker tests pass, including eleven new
  calendar selection, invalid-month and leap-year/window cases.
- Typecheck and production build pass. Main entry is 551,930 raw / 174,737 gzip
  bytes under the unchanged budget.
- `smoke-schedule-calendar.mjs` passes against real compiled Chrome/auth/D1 at
  320x480, 768x900 and 1440x900. January and February 2099 fixtures prove future
  reads, newly fetched dates, selected-show retention, direct month jumps,
  same-document Back and physical day selection. Controls do not overlap and
  the page does not overflow. Inspected the 320px calendar screenshot.
- All seven Schedule dialogs still pass at three widths and locales. The broad
  navigation audit passes all 21 routes and 13 Settings sections, now explicitly
  opening and measuring the phone calendar controls.
- No runtime errors or external emails in the browser rehearsals.

Logs: `/tmp/showpilot-schedule-calendar-before.log`, `-unit-before.log`,
`-full2.log`, `-tsc2.log`, `-build2.log`, `-after3.log`, `-dialogs.log`, and
`-navigation.log`. This is scoped calendar evidence. The broad responsive and
product-wide gates remain open; Phase 2 stays 66/79. Nothing deployed or released.


### 2026-11-08: Real long-run, device and lyrics acceptance

The 45-minute rehearsal passed on GitHub Actions run
[42454853635](https://github.com/reydisse/showpilot/actions/runs/42454853635),
PR #225 head `6a103a3f6da6b1a2b6dc1089065f377b6997fa2a`. The actual compiled
browser clock, authenticated Worker and RundownRelay ran for 2,710.336 seconds.
Rundown advances acknowledged once each at 2,100.020 and 2,700.020 seconds.
The script verifies the current item after each advance, stable execution IDs,
one attempt per cue, no premature execution and no browser errors. Across 530
samples, maximum clock drift from elapsed wall time was 0.156061 seconds.
No accelerated clocks or physical equipment were used.

Downloaded and inspected artifact `phase2-timecode-rehearsal-1`, ID 13608590801.
Local copy: `/tmp/showpilot-longrun-artifact-42454853635/timecode-longrun.log`.
Ordinary CI run 42454853508 also passed. Earlier interrupted local attempts remain
recorded as incomplete; this successful CI run supplies the long-run evidence.

The other two parts of this acceptance item were rerun on the current compiled
web build and a fresh Bridge build:
- `smoke-homeassistant-cues.mjs` passes browser-to-authenticated-equipment flow
  through real TimecodeRelay, BridgeRelay and compiled Bridge. The equipment is
  a local HTTP simulator. Saved cue acknowledgement, malformed-discovery Retry,
  removed-entity refusal and explicit execution Retry pass. Exactly two approved
  service POSTs, encrypted saved credentials, no returned target/token leaks,
  and 320/768/1440px controls.
- `smoke-lyrics-steps.mjs` passes operator and confidence Next/Previous/Clear
  after a successful lyrics cue. Correct lyric states appear while the confidence
  lyric DOM node stays mounted.

Logs: `/tmp/showpilot-phase2-device-bridge-build.log`,
`/tmp/showpilot-phase2-device-acceptance.log`, and
`/tmp/showpilot-phase2-lyrics-acceptance.log`. This verifies requirement
3277f632c1aea066, taking Phase 2 to 67/79. The overall Phase 2 gate remains open;
Phase 3 has not started. No production deployment, release or real-org writes.


### 2026-11-08: Recoverable rundown PIN verification

A held real verification reply reproduced a page stuck on Verifying. The inline
rundown Unlock dialog had the same unbounded request. Both now share
`useRundownPinVerification`: an eight-second deadline, timestamped error with
Retry, transport cancellation and request-generation checks. The PIN remains
available for explicit retry. Editing it, leaving the page or closing the dialog
invalidates the pending attempt, so a late valid reply cannot grant access.

The dedicated PIN page opens the rundown through app navigation. The inline
rundown dialog keeps the existing reload after Lock/Unlock, which reconnects its
current live socket with the new write authority. The short-phone check exposed
its 36px default button. Retry and Close now meet 44px; width and height stay
within the viewport and allow scrolling.

Four rendered tests verify timeout and late success, successful retry, unmount,
changed PIN, and actual Escape from the inline dialog. The real compiled-browser
rehearsal exercises both entry points against actual auth/D1/PIN verification,
including held valid replies, incorrect PIN, late replies after timeout and
Escape, cookie/authority changes, and successful reconnection. Page and dialog
recovery controls fit and are hit-testable at 320x480, 768x900 and 1440x900.
Both phone screenshots were inspected. No runtime errors.

Full suite: 2,389 unit and 1,186 Worker tests pass; typecheck and build pass.
Main entry: 551,944 raw / 174,737 gzip bytes, under the unchanged limit.
Logs: `/tmp/showpilot-rundown-pin-before.log`, `-full3.log`, `-tsc3.log`,
`-build3.log` and `-after4.log`. The first inline phone geometry check failed;
`-after4.log` proves the final control dimensions. This closes these PIN paths,
not the broad loading/UX gate. Phase 2 stays 67/79. Nothing deployed or released.


### 2026-11-08: Account downloads, recovery and responsive state

Pausing the actual Profile code download left an indefinite account spinner.
Profile, Notifications and their account-only loader now use the existing
12-second load deadline. A local boundary keeps the account header available,
shows a timestamped error and offers Retry. Every retry creates fresh lazy
instances, including a failed child. Late module completion cannot replace the
failed attempt before the operator retries. Back, Close and Retry meet 44px.

The first responsive rehearsal lost its Retry button when the viewport crossed
the phone breakpoint. Desktop and mobile sidebars had different child positions,
so React remounted the identity component and closed the account dialog. Stable
sidebar keys now preserve the open panel. The final browser test also retains
the exact profile input node and its unsubmitted name across all three widths.

Device-notification status setup now loads after mount, with a bounded check and
visible failure. It respects the actual subscription setup result instead of
calling delivery enabled whenever browser permission is granted. Six tests cover
undecided permission, scoped subscription setup without another prompt, failed or
denied setup, and native status success/failure. Permission requests from an
explicit Enable click retain their existing immediate user-gesture path.

Validation:
- Full suite: 2,395 unit / 1,186 Worker tests; typecheck passes.
- Final production build passes under the unchanged 175,000-byte gzip limit.
  Main entry: 552,909 raw / 174,980 gzip bytes. Account-only module setup is
  deferred, and recovery reuses the existing Button component.
- Compiled Chrome/auth/D1 checks separately pause ProfileModal,
  NotificationCenter and AccountPanels downloads. All time out, show a reachable
  error at 320x480/768/1440, retain the failed attempt after late completion, and
  recover without a document reload. A separate real network-failure case also
  recovers on Retry. Profile drafts and DOM identity survive resizing.
- Both phone error screenshots inspected. Zero runtime errors or captured emails.
- The broad navigation regression passes 21 routes and 13 Settings sections,
  including phone drawer behavior and preserved Settings Back navigation.

Logs: `/tmp/showpilot-account-loading-before.log`, `-full3.log`, `-tsc4.log`,
`-build5.log`, `-after3.log`, `-network2.log`, and `-navigation.log`. Earlier
build attempts exceeded the budget; only the final build is a pass. This covers
account code loading and notification-status setup, not every account request.
Inbox/count reads and account mutations remain in the broader recovery audit.
Phase 2 stays 67/79. Nothing deployed or released; 20 necessary Markdown files
remain, and no new Markdown file was added.


## Phase 2 notification inbox recovery — 2026-11-08

A retry of Mark all read could clear alerts that arrived after the first commit.
Three failing real-auth/D1 tests reproduced that and request-target reuse.
Migration `0075_notification_read_receipts.sql` records each action and applies
its read set in one transaction through an insert trigger. Replaying the request
only reads its receipt. Session and membership are checked at commit and replay;
receipts are scoped to organization and account and bound to the original target.
A failed update rolls back its receipt, so Retry can safely complete it later.
No production migration was applied.

The inbox now uses bounded, cancellable page queries. Failed initial reads show
an error and timestamp instead of claiming the inbox is empty; failed refreshes
and older-page loads retain confirmed data. Read commands have an eight-second
confirmation deadline and survive panel closure/navigation in the account-scoped
query cache. Retry sends the original request, while read-only Retry cannot
repeat a write. Pending state remains visible, late replies cannot hide failures,
and recovery/preferences/history controls have 44px targets. Desktop count events
continue to drive refresh; web polling pauses while hidden and coalesces requests.

Device notification setup now loads only in an open account menu, with bounded
module/status/permission operations. Permission requests still begin in the click
handler. The failure path no longer starts another unbounded permission read.
The browser rehearsal caught a module download during the dialog's closing
animation; the menu now requires an open dialog before mounting its controls.
Account/Profile share the identical initials calculation. The initial bundle is
smaller without changing the budget: 551,113 raw / 174,467 gzip bytes.

Verification:
- Final full suite: 2,400 unit and 1,194 Worker tests; typecheck and build pass.
- Eight new Worker cases cover same-timestamp arrivals after a committed action,
  changed targets, concurrent duplicate requests, transaction rollback, revoked
  membership/session and cross-account/workspace attempts.
- Compiled Chrome/auth/D1 tests initial and older-page timeouts, retained history,
  ignored late replies, exact mark-all retry after a committed response is lost
  and a new alert arrives, and individual read recovery after navigation.
- The same browser run withholds the device-control module, recovers it without
  reloading, then tests a stalled permission promise and failed permission retry.
- 320x480/768/1440 layouts pass. Both phone inbox screenshots inspected. Zero
  browser runtime errors and captured emails.
- Account download regressions pass held ProfileModal, NotificationCenter and
  AccountPanels requests plus actual Profile network failure. Draft and DOM
  identity survive resizing. Navigation passes all 21 routes and 13 Settings
  sections at 320/768/1024/1440 without a reload.

Logs: `/tmp/showpilot-notification-read-before.log` reproduces the original bug;
final evidence is `/tmp/showpilot-notification-full6.log`, `-tsc8.log`,
`-build7.log`, `-browser2.log`, `-account-regression.log`, and `-navigation.log`.
Earlier build attempts exceeded the budget and browser1 exposed the closing
animation download; neither is recorded as a pass.

Phase 2 remains 67/79. Sidebar unread/timezone requests, account mutations and
other product-wide recovery/UX gates still need work. Nothing deployed or
released. There are still 20 necessary tracked Markdown files; none was added.


## Phase 2 account notification status — 2026-11-08

The account menu could say "You’re all caught up" while its unread-count read
was still stalled. The compiled browser baseline reproduces this false zero.
The sidebar now distinguishes unknown, checking, confirmed and failed counts.
A count-only server function checks the signed-in member's workspace membership
and counts only their unread, undismissed alerts, without fetching message bodies.

The count controller loads after mount and bounds both download and requests to
eight seconds. It coalesces refreshes, pauses/cancels while hidden, ignores late
responses after cancellation and retains confirmed data on failure. A failed
count shows an explicit badge, failed-at time and Retry; the menu recovery scrolls
with its other controls on short phones. A confirmed count includes its check
time. Native events are refresh signals, not trusted count values, and a quiet
native controller falls back after one minute. Opening the actual inbox can
repair the sidebar count and cancels an older count read.

A rendered regression also exposed a pagination bug: loading an older page still
published the first page's older unread count. The inbox now publishes the latest
completed page's count and re-publishes a confirmed count on successful refresh,
even when its numeric value is unchanged.

Validation:
- Final full suite: 2,407 unit / 1,195 Worker tests; typecheck and build pass.
  Main entry is 552,476 raw / 174,991 gzip bytes under unchanged limits.
- Six count-controller tests verify timeout/abort, late completion, retained data,
  coalescing, hidden-tab cancellation/resume, native scope/fallback, inbox update
  precedence and disposal. Real auth/D1 checks count isolation, dismissed/read
  filtering, foreign workspaces and revoked membership.
- Compiled Chrome/auth/D1 rehearsals independently hold the actual count response
  and the controller module. Both reach timestamped failure and recover on Retry
  without reloading; late completion cannot dismiss the failure. A fresh inbox
  repairs the count. 44px recovery targets pass at 320x480/768/1440. Phone error
  screenshot inspected. No runtime errors or captured emails.
- The full inbox rehearsal still passes lost committed response plus a newer
  unread alert, exact retries across closing/navigation, pagination failures,
  late responses, module download recovery and permission failure.
- Broad navigation still passes 21 routes and 13 Settings sections at
  320/768/1024/1440 without a reload.

Evidence: `/tmp/showpilot-count-before.log` and `-pagination-before.log` reproduce
the two failures. Final checks are `-full2.log`, `-tsc3.log`, `-build2.log`,
`-browser2.log`, `-module.log`, `-inbox-regression2.log`, and `-navigation.log`.
The module/navigation runs exercised their unchanged code before the final
inbox count-publication adjustment; the count and full inbox browser runs were
repeated after that adjustment.

Phase 2 remains 67/79. The background notification timezone save still needs
bounded recovery and protection against an old retry replacing a newer device's
zone. Profile/sign-out mutations and native notification delivery's unbounded
requests/silent catch also remain in the wider audit. This change covers count
honesty and recovery, not all notification delivery. No deployment, release,
remote migration or real organization writes. Still 20 necessary tracked
Markdown files, with none added.


## Phase 2 notification timezone recovery — 2026-11-08

On `fix/notification-timezone-recovery`, replaced the silent background timezone
write with bounded reads and saves shared by the background indicator and account
menu. A failed save remains uncertain and keeps the exact request across panel
closure and account/workspace navigation. Retry confirms that request; it cannot
replace a newer device's saved timezone. A separate explicit device-timezone
choice uses the freshly confirmed revision. Failed refresh after acknowledgement
retries only the read. Initial loading never claims the workspace default.

Migration 0076 keeps the existing `app_setting` value and assignment-email reader
in place, backfills revision counters, and tracks older writers with triggers.
A D1 transaction binds each receipt to its account, workspace, request, zone and
expected revision. It checks live session/membership authority, commits the
receipt and setting together, and distinguishes applied, conflicting and
superseded requests. Revision history survives preference deletion/recreation.
Apply this migration before deploying the new server functions. No remote
migration was run.

Validation:
- Three baseline real-auth/D1 failures reproduced replay overwrite, stale revision
  and changed request reuse in `/tmp/showpilot-timezone-before.log`.
- Nine Worker regressions cover concurrent identical and different commands,
  stale revision/ABA, legacy writes, transaction rollback and revoked/cross-account
  authority. Five rendered tests cover read/write deadlines, late replies, shared
  background/menu writes, retained exact commands across scope changes, newer
  device protection, explicit revision-based replacement, failed refresh and
  mismatched acknowledgements.
- Full suite: 2,412 unit / 1,204 Worker tests pass. Typecheck and production build
  pass. Main entry 552,027 raw / 174,887 gzip bytes under unchanged limits.
- Compiled Chrome/auth/D1 rehearsal seeds a preference before migration 0076,
  confirms its preserved value/revision, sets an actual Toronto browser timezone,
  stalls real reads and committed writes, writes London from another authenticated
  client, retries the original command, and confirms London was preserved. An
  explicit fresh choice saves Toronto; its failed refresh recovers without another
  write. Recovery controls pass 44px/reachability at 320x480/768/1440. Phone failure
  screenshot inspected; no runtime errors or captured email.
- Account module regression passes held Profile, Notifications and AccountPanels
  downloads plus actual Profile network failure, explicit Retry without reload,
  and the same unsaved profile input across resizing. The first run exposed a
  test-interception edit error; correcting the conditional made the intended
  AccountPanels fault run. No app change was needed for that failure.
- Count recovery/retention/inbox repair and broad navigation across 21 routes,
  13 Settings sections and four widths still pass.

Evidence: `/tmp/showpilot-timezone-{ui1,full1,tsc2,build1,browser1,
account-regression2,count-regression,navigation}.log`; scripts
`smoke-notification-timezone.mjs`, `smoke-account-panel-loading.mjs`,
`smoke-account-notification-status.mjs`, and `smoke-navigation-audit.mjs`.
PR #232 CI passed (run 42464323074). Opened queued count change as draft #233;
its CI run 42465690902 is still pending as this entry is recorded.

Phase 2 remains 67/79. Profile edits, avatar upload, password-reset requests,
sign-out and native notification delivery still have unbounded operator paths;
these and the remaining broad audit prevent closing the gate. No deployment,
release, real-org writes or new Markdown files. Twenty necessary tracked Markdown
files remain.


## Phase 2 confirmed sign-out and recovery — 2026-11-08

On `fix/account-sign-out-recovery`, both account-menu and profile sign-out now
share a retained, account-scoped attempt. Reads and revocation have one eight-second
deadline. Errors show a timestamp and Retry instead of closing the account menu.
Retries check current session authority first; an already-ended session needs no
second write. A changed sign-in requires reviewing the current account. Late reads
cannot start a write after timeout; late acknowledgements cannot navigate. Confirmed
sign-out clears private query/mutation state and loads the login document afresh.
The existing two-tap confirmation expires after four seconds and pending attempts
coalesce. Recovery survives menu closure and switching account views.

Root cause extended to the server: the installed Better Auth sign-out endpoint
caught session-deletion failure and returned success while clearing the cookie.
A ShowPilot endpoint override now retains Better Auth's origin checks, signed
cookies, adapter deletion hooks and relay revocation. It checks deletion before
clearing cookies, returns an error when revocation cannot be confirmed, and rejects
an expected-session mismatch. Existing clients without the optional session ID
continue to sign out. Other devices' sessions remain active. This application uses
email/password authentication and database sessions; no provider-logout flow is
configured or added here.

Validation:
- Baseline real-auth/D1 tests reproduced two failures: database deletion failure
  returned 200 and an old confirmation ended a newer session. The browser baseline
  showed the account menu disappearing after a 503 with no recovery; authentication
  remained active. Baseline logs are `-before2.log` and `-browser-before.log` below.
- Four real-auth/D1 tests now pass: failed deletion retains cookies for Retry,
  session mismatch rejection, harmless duplicate/lost-response retries preserving
  other sessions, legacy compatibility, and foreign-origin rejection.
- Seven rendered tests cover response errors, read/write deadlines and abort,
  late-response rejection, no late write after a timed-out read, retained commands
  across unmount/account changes, read-only recovery of a lost success, changed
  session recovery, confirmation expiry, duplicate clicks and malformed replies.
- Full suite: 2,419 unit / 1,208 Worker tests pass. Typecheck and production build
  pass. Main entry 551,726 raw / 174,749 gzip bytes under unchanged limits.
- Compiled Chrome/auth/D1 tests pass account-menu HTTP failure, profile stalled
  write, lost committed reply and profile stalled session read. Recovery survives
  closing/changing views; late replies do not navigate. Retrying a lost committed
  reply sends no second revocation. Confirmed logout reaches the login document
  and the original session is revoked. Error/Retry fits at 320x480/768/1440.
  Menu and profile phone screenshots inspected; no runtime errors or email.
- Account download regression passes held Profile, Notifications, AccountPanels
  and the new SignOutControl chunk, plus a real Profile network failure. Retry
  recovers without losing the profile input node/draft during resizing. Navigation
  passes 21 routes/13 Settings sections at 320/768/1024/1440 without reload.

Evidence: `/tmp/showpilot-signout-{before2,worker2,ui1,tsc2,full1,build1,
browser-before,browser1,account-regression1,navigation}.log`. Rerun with
`smoke-account-sign-out.mjs`, `smoke-account-panel-loading.mjs` and
`smoke-navigation-audit.mjs`. An initial Worker run had a test syntax typo; a later
version used thrown framework API errors that produced unhandled-rejection reports.
The final endpoint uses explicit HTTP failure responses, matching existing auth
endpoint overrides; the final suite reports no such errors.

PR #233 CI passed in run 42465690902, so the previously queued timezone branch
opened as draft #234. Its main CI is still pending while recording this entry.
Phase 2 remains 67/79. Profile name/photo saves, reset-email requests, native
notification delivery and the remaining broad audit are still open. No deployment,
release, migration, real-organization write, paid service or new Markdown file.
Twenty necessary tracked Markdown files remain.


## Phase 2 profile save and recovery — 2026-11-08

On `fix/account-profile-recovery`, profile reads, image preparation, name/photo
saves and reset-email requests have bounded recovery. Name drafts and prepared
photos survive panel closure; timed-out replies cannot replace current state.
Errors include a timestamp and explicit Retry. A reset-email retry explains that
it requests another link and waits for a 60-second cooldown. Empty name drafts do
not claim to be saved, and conflicts display the saved name beside the draft.

The baseline reproduced an old name request overwriting a newer name. A second
compiled auth/R2 baseline showed that uploading a replacement photo changed the
bytes behind the published URL before the profile update succeeded. Migration
0077 adds account revisions, legacy-writer triggers and atomic request receipts.
Name/photo writes check the session and expected account; exact retries cannot
replace a newer revision. Photos use content-addressed immutable paths. An
explicit “Use selected photo” action reapplies the retained bytes against the
current revision. Failed storage/publication leaves the current photo unchanged.
Account deletion removes versioned photos. Web/mobile URL handling accepts both
legacy and versioned paths; mobile profile mutations otherwise retain their
existing behavior and still need the broader recovery audit.

Validation:
- Eight real-auth/D1/R2 profile cases cover concurrent requests, exact replays,
  conflicting payloads, legacy ABA updates, transaction rollback, failed storage
  and failed publication, account/session boundaries, body limits and origins.
  Account deletion verifies version cleanup without deleting another user's photo.
- Nine rendered panel cases cover read/write/preparation deadlines, late replies,
  retained drafts and bytes across closure, typing during saves, read-only refresh
  retry, explicit photo conflict recovery, reset cooldown and truthful empty input.
- Final full suite: 2,429 unit / 1,216 Worker tests pass. Web/mobile typechecks and
  production build pass. Main entry 551,757 raw / 174,785 gzip bytes, under the
  unchanged limits.
- Compiled Chrome/auth/D1/R2 passes migration backfill, actual canvas preparation,
  immutable published bytes, lost committed replies, exact retries preserving
  newer profiles, explicit selected-photo reuse, refresh-only recovery and reset
  resend after cooldown. Two emails were captured locally; none were delivered.
  Recovery controls fit 320x480/768/1440, with inspected phone screenshots and no
  runtime errors or document reload. Empty-draft and saved-name comparison checks
  pass against the final build.
- Account-panel download/network regressions pass all five scenarios, retaining
  the exact profile input node and draft across resizing. Navigation passes
  21 routes and 13 Settings sections at 320/768/1024/1440 without reload.

Evidence: `/tmp/showpilot-profile-{before,photo-before,worker1,ui3,
ui-review-before,full2,tsc9,mobile-tsc2,build2,browser5,
account-regression1,navigation}.log`. Rerun `smoke-account-profile.mjs`,
`smoke-account-panel-loading.mjs` and `smoke-navigation-audit.mjs` with
`SHOWPILOT_SMOKE_RUNTIME=miniflare`. Initial browser checks were corrected to
wait for the acknowledged save and target the profile file input rather than the
chat attachment input; the final run passes. Typecheck also caught and corrected
a test helper's widened command discriminant. The final UI review reproduced and
fixed the false Saved label and missing saved-name comparison.

PR #234 is green (run 42466651442), and #235 is green (run 42467842084:
CI 13m23s, native Rust 4m28s). Phase 2 remains 67/79; this is scoped profile
evidence, not completion of the product-wide gate. Native notification delivery,
schedule/assignment recovery and the remaining broad audit are still open.
No deployment, release, remote migration or real-organization write. Twenty
necessary tracked Markdown files remain; no new Markdown file was added.


## Phase 2 desktop notification recovery — 2026-11-08

On `fix/desktop-notification-recovery`, a stalled context/inbox/native-permission
request releases the poll after eight seconds. Failures show a timestamp and
Retry in the desktop status bar; polling also retries automatically. Delivery
checkpoints each accepted notification, so a failure later in a batch cannot
repeat earlier deliveries. Memory history takes precedence when localStorage
writes fail. This fallback only guarantees deduplication for the current delivery
lifetime; it cannot provide persistence while storage is unavailable.

The root controller owns delivery and React context carries its status. Keeping
this in the account panel would stop it on closure/navigation; a module-global
store would introduce another shared state owner. The native loop is loaded only
for the desktop main window, with a bounded module-start error and Retry. Web and
public display windows do not load it. Inbox replies include their account and
workspace identity, which must match the context before history or native output
is touched. No inbox item is marked read merely because a desktop alert is sent.

Listener registration has a deadline. Late registrations are retired; retirement
failures are surfaced and removal is retried. A retired callback becomes inert
before native removal completes. Native permission replies cannot send an alert
after its attempt expires. Notification actions use the existing validated route
mapping and still navigate after a stalled native-focus request. Permission UI
says “Allowed by system settings” rather than implying delivery succeeded.

Validation:
- The baseline rendered tests reproduced a permanently locked poll after a hung
  request and a successful delivery missing from history after the next failed.
- Ten rendered controller cases and thirteen runtime cases pass. They cover read
  and context deadlines, late reply rejection, duplicate retry coalescing, partial
  delivery, memory fallback, changed accounts, listener retirement/retry, inert
  retired callbacks, native permission cancellation and signed-out web rendering.
- Final full suite: 2,440 unit / 1,216 Worker tests pass. Typecheck passes. Production
  build passes; the main entry is 549,032 raw / 173,556 gzip bytes under unchanged
  limits. Formatting afterward changed no behavior; the final suite/typecheck pass.
- Compiled Chrome/auth/D1 with the actual Tauri JavaScript API and simulated IPC
  passes held module download, inbox and native permission recovery,
  retired listener cleanup, per-alert checkpoints, storage-failure memory history,
  and notification navigation when native focus never replies. Existing baseline
  alerts are not replayed; three new alerts are delivered once to the simulated
  constructor and all four inbox records remain unread. No runtime errors.
  This does not claim an actual OS notification was displayed.
- Retry controls fit 320x480/768/1440 after the responsive sidebar transition
  settles; module and delivery failure screenshots were inspected. The first
  screenshot check captured the transition and was tightened before final evidence.
  A script-only ID capture initially confused Tauri's numeric OS identifier with
  the notification record ID; the final rehearsal keeps them separate.
- Account-panel download/network/draft preservation passes all five cases.
  Navigation passes 21 routes and 13 Settings sections at four widths.

Evidence: `/tmp/showpilot-desktop-notification-{before,ui3,full2,tsc4,build1,
browser3,account-regression,navigation}.log`. Rerun
`smoke-desktop-notification-recovery.mjs` with
`SHOWPILOT_SMOKE_RUNTIME=miniflare`; native IPC is deliberately simulated.
PR #236 is green in run 42469875367 (CI 15m23s, native Rust 3m9s).
Phase 2 remains 67/79. Schedule-provider saves still have an unhandled rejection
and no request deadline; schedule/assignment recovery and the broader gate remain
open. No deployment, release, remote migration, real-organization write, or new
Markdown file. Twenty necessary tracked Markdown files remain.

### Scheduling source recovery — Phase 2 partial evidence (2026-11-08)

Branch: `fix/schedule-provider-recovery`, based on the green desktop notification
recovery change. The old source form threw an unhandled rejection, offered no
Retry, and discarded its platform/URL draft on close. Real D1 regressions also
showed that an old retry replaced a newer administrator's source, and Prisma's
ignored transaction left the platform changed after the URL update failed.

The dedicated source command now commits its receipt, three settings, and
revision in one native D1 batch. Fresh session and scheduling permission checks
are repeated at the database boundary. Request IDs bind the reviewed revision,
account, organization and normalized configuration; an exact retry reports the
current source without replaying an older write. A changed source requires an
explicit reviewed save with a new request. The obsolete optional workspace
terminology mutation is removed from this endpoint; Workspace Settings remains
its separate permission boundary and is linked from the form.

Migration `0078_schedule_provider_recovery.sql` backfills revision metadata and
tracks inserts, updates and deletes of the existing source settings. Apply it
before deploying this code. Old writers still advance the revision. A code-only
rollback can leave these triggers and receipt records in place. This migration
has only run in disposable local/test databases; the remote manifest is unchanged.

The shared Dialog editor keeps drafts and unresolved attempts per account and
organization across close and SPA navigation. Reads and writes have 8-second
deadlines, timestamped errors and Retry; a late reply cannot settle an expired
attempt. A confirmed write has a separate 12-second Schedule refresh deadline,
and refresh retry never sends the write again. Closed panels retain an attention
message. The saved source and retained draft are visible after a conflict.
Controls are labeled and at least 44px; the short-window body scrolls while the
close button stays accessible.

Validation:
- The original compiled browser baseline and two real-auth/D1 regressions failed
  for the reported behaviors before the fix.
- Fifteen Worker cases cover replay, concurrent commands, conflict review,
  payload reuse, partial-write rollback, legacy edit/delete ABA changes,
  session/member/deletion authority changes at commit, account/org boundaries,
  invalid URLs, obsolete terminology input, and organization cascade deletion.
- Ten rendered UI cases cover read/write/refresh deadlines, late replies,
  exact retry after navigation, refresh-only retry, local validation, the latest
  typed character, pristine refresh versus retained drafts, and account isolation.
- Final full suite: 2,450 unit / 1,231 Worker tests pass. Web typecheck passes.
  Production build passes: 548,865 raw / 173,474 gzip main-entry bytes, under the
  unchanged limits. The test-helper-only unsupported `exact` option was removed
  before the final full suite/typecheck; route JSX formatting changed no behavior.
- Compiled Chrome/auth/D1 rehearsal passes a held initial read, HTTPS validation,
  a committed source write with a lost response, a newer source saved through the
  real RPC, Workspace Settings navigation with the draft retained, exact retry
  preserving that newer source, and explicit reviewed replacement. Focus returns
  to Manage source on close. No runtime errors or emails.
- Dialog checks pass at 320x480, 768x1024 and 1440x1000. Phone/tablet screenshots
  were inspected. The first script sampled immediately after viewport resize;
  waiting for the actual layout to settle resolved that observation failure.

Evidence: `/tmp/showpilot-provider-{worker-before2,worker1,ui1,full2,tsc6,
build2,browser3}.log`. Rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-schedule-provider-recovery.mjs`.
PR #237 is fully green in run 42471324112 (CI 13m0s, native Rust 4m7s).
Phase 2 remains 67/79. Reminder delivery results are still ignored by the
Schedule callers, and assignment/read recovery plus the broader UX gate remain
open. No production deployment, release, remote migration, real-organization
write or new Markdown file. Twenty necessary tracked Markdown files remain.

### Scheduling reminder recovery — Phase 2 partial evidence (2026-11-08)

Branch: `fix/schedule-reminder-recovery`, based on the green source-form change.
The compiled baseline confirmed an unhandled bulk reminder rejection and no
Retry. A real D1 regression also confirmed that losing an email-provider reply
deleted the link that could already be in the recipient's inbox.

Migration `0079_schedule_invitation_delivery.sql` adds immutable delivery
attempts and scoped bulk-request receipts. Apply it after 0078 and before this
code. Frozen email bodies, including their invitation links, are encrypted using
the existing credential vault and a delivery-specific authenticated scope. The
public access table still stores only the token hash. The existing
`CREDENTIAL_ENCRYPTION_KEYS` keyring must remain available; retain keys needed by
stored attempts. No remote migration or secret change was performed.

The shared sender retains prepared links, reuses the frozen email/provider key,
and reports email acceptance separately from durable app invitations. Sending
has a lease, an 8-second provider deadline, and an explicit uncertain result for
a lost reply. Accepted requests never resend. Retry stops after 23 hours, within
[Resend's documented 24-hour idempotency window](https://resend.com/changelog/idempotency-keys).
App invitation IDs are stable per delivery; retry does not reset a read inbox
item or repeat its push. Authorization and assignment identity are checked before
dispatch. A guarded timestamp update cannot mark edited assignment fields as
invited after a late reply; duplicate unguarded updates were removed from web,
copy-team and mobile callers. Receipt tables remain until their related
assignment, crew, organization or actor is deleted, according to their foreign
keys. Existing previously issued links are unchanged.

The web single/bulk controls now keep the same request across navigation and
retry, show per-recipient failures and app/email outcomes, and use a 15-second
request deadline. Bulk retries keep the original target set and skip accepted
emails. Schedule refresh has a separate bounded retry that never sends mail.
Expired or changed requests require an explicit reviewed new send. Existing web
reminder RPCs were removed after migrating their callers. Mobile callers share
the link-preservation and guarded timestamp behavior, but their reminder UI and
retained request flow remain a separate open item.

Validation:
- Baselines: the compiled Schedule button threw without a Retry; the D1 link
  record disappeared after a simulated accepted email's reply was lost.
- Fourteen new Worker cases cover frozen payload/key/link replay, ciphertext at
  rest, definite versus uncertain failure, concurrent execution, recipient
  changes, the retry window, provider timeout/late acknowledgement, authority,
  frozen bulk selection, accepted-email and app-inbox deduplication, account/org
  boundaries, and a late acknowledgement after an assignment edit. That final
  case failed before the timestamp guard and caller cleanup.
- Six rendered control cases cover retained requests, late replies, partial
  delivery, refresh-only retry/deadline, explicit new sends and account isolation.
- Full suite passes: 2,456 unit / 1,245 Worker tests. Web typecheck passes.
  Production build passes, including after formatting: 548,654 raw / 173,401 gzip
  main-entry bytes, under unchanged limits.
- Compiled Chrome/auth/D1 with the isolated email provider passes mixed
  acknowledgements, a held RPC reply, navigation away/back, exact retry, an
  invitation opened through the real public portal RPC after its email reply
  was lost, and definite-rejection recovery. Ten captured attempts represent
  six explicitly requested accepted emails over two rounds; the first recovery
  only calls the provider for the one uncertain email and replays its original
  key/body. Accepted recipients are not resent. No external email was sent.
- Recovery controls fit 320x480/768x1024/1440x1000; the phone screenshot was
  inspected. No browser runtime errors. Source-form regression also passes.
  Its prior email-count assertion checked a function's arity instead of captured
  records; it now enables email capture and awaits the actual empty record list.
  An initially misplaced fixture option was corrected before that final pass.

Evidence: `/tmp/showpilot-reminder-{before,browser-before,worker2,command1,ui1,
late-before,full2,tsc5,build3,browser1}.log` and
`/tmp/showpilot-provider-regression2.log`. Rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-schedule-reminder-recovery.mjs`.
PR #238 is green in run 42473246999 (CI 15m5s, native Rust 4m11s).
Phase 2 remains 67/79. Assignment creation/edit/removal, mobile recovery and the
broader product gates remain open. No deployment, release, production migration,
real-organization write or external email. Twenty necessary tracked Markdown
files remain; none were added.

### Assignment save recovery — Phase 2 partial evidence (2026-11-08)

Branch: `fix/schedule-assignment-recovery`, based on the green reminder change.
The original real-auth/D1 regressions reproduced duplicate positions on create
retry and an older edit replacing newer notes. The web create, team, edit and
remove controls now use one strict command path. The previous web save/delete
RPCs were removed after their callers were migrated.

Migration `0080_schedule_assignment_recovery.sql` must follow 0079 before this
code is deployed. It adds per-assignment revisions, deletion tombstones and
actor/org-scoped request receipts. Database triggers include legacy/mobile writes
and crew responses; invitation-only timestamps do not invalidate an edit.
Receipts and assignment writes commit in one D1 batch. The write rechecks session,
permission, organization, show, crew and the reviewed revision. Deleting and
recreating an ID does not revive an old removal request. Replacing a declined
person preserves their original response and consumes its revision so competing
replacements cannot both succeed. Receipts and tombstones persist until their
organization is removed; deleting an actor also removes their request receipts.

Automatic invitations reuse the save request and the shared frozen delivery
record. A retry can recover delivery without adding another position or repeating
an accepted email. A later assignment change prevents an old request from sending
its invitation. Responses expose save and email outcomes separately.

The shared editor retains drafts and frozen requests per account, organization
and editor across in-app navigation. Reads have an 8-second deadline, saves a
15-second deadline, and schedule refresh a separate 12-second deadline and retry.
A team retry only submits unconfirmed rows or unresolved invitations. Conflict
review retains the operator's draft and requires another explicit save/removal.
The current response is shown before removal, and replacing confirmed crew still
requires confirmation. Controls have labels and 44px targets; the dialog scrolls
inside short screens and restores focus to its opener when that opener remains.
Draft notifications are synchronous for controlled inputs, including typing
immediately followed by Submit.

Validation:
- Fifteen real-auth/D1 Worker cases pass: duplicate and concurrent creates,
  stale/concurrent edits, changed-back legacy writes, deletion/recreation,
  declined replacement history, crew-response preservation, timestamp-only
  updates, account/permission/org boundaries, transaction rollback, permission
  revocation during a save, invitation recovery and later reassignment, venue
  call-time conversion, and show changes during the transaction.
- Eight rendered editor cases pass: navigation and late replies, partial teams,
  preserved conflict drafts, read deadlines, refresh-only retry, reviewed
  removal, account isolation, and invitation retry. Initial cases caught batched
  draft notifications losing the last input before Submit; synchronous draft
  subscriptions fixed that failure.
- Full web suite: 2,464 unit / 1,260 Worker tests pass. Web typecheck passes.
  Production build passes at 548,437 raw / 173,296 gzip main-entry bytes, within
  unchanged 600,000 / 175,000 limits.
- Compiled Chrome/auth/D1 passes a held successful create reply, closing and
  navigating away/back, exact retry with one persisted position and one captured
  email, stale edit and deletion review, and partial team retry. The original
  invitation is not resent. Recovery controls fit 320x480, 768x1024 and
  1440x1000; the phone screenshot was inspected. No browser runtime errors and
  no external mail. The fixture intercepted its one email.

Evidence: `/tmp/showpilot-assignment-{before,worker2,ui1,ui2,full1,tsc4,build1,
browser1}.log`. Rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-schedule-assignment-recovery.mjs`.
PR #239 is green in run 42475607115 (CI 15m16s, native Rust 4m37s).
Phase 2 remains 67/79. Background roster reads, copy-team, show-detail mutations,
mobile recovery and the broader product gates remain open. No production
deployment, release, remote migration or real-organization write. Twenty
necessary tracked Markdown files remain; none were added.

### Roster reads and team-copy recovery — Phase 2 partial evidence (2026-11-08)

Branch: `fix/schedule-roster-recovery`, based on the green assignment change.
The compiled baseline showed that a rejected roster poll left the old crew list
without a failure notice or Retry. Two real-auth/D1 baselines showed that changing
the source roster broke copy recovery and that an uncertain copied invitation
was retried with a different email body and delivery key.

Schedule now uses the existing bounded operator reader for its roster. It keeps
confirmed rows visible with a timestamped failure and Retry, aborts stalled reads
after eight seconds, pauses hidden polling, prevents overlap, and rejects stale
replies after a show/account change or a newly confirmed loader snapshot. The
polling-boundary check follows this shared reader instead of requiring the old
inline interval implementation.

Migration `0081_schedule_copy_recovery.sql` must follow 0080 before deployment.
A team copy freezes source rows and creates every target position in the same
D1 batch as its scoped request receipt. The transaction rechecks permission,
source/destination ownership, destination date, stopped state, empty roster and
crew ownership. Concurrent copies cannot both populate an empty destination.
A retry uses the original rows even if the source changes, preserves later target
edits/deletions, and reuses the original invitation attempts. Copying still resets
responses and notes, preserves departments and call times, and includes open
positions. A blocked request needs an explicit reviewed new request. Receipts
persist until their organization or actor is removed. No remote migration ran.

The web Copy team control retains its request per account/org/destination across
navigation and keeps recovery available after the target fills up. It reports
copied positions, changed targets and per-recipient delivery separately. Saves
have a 15-second deadline; refresh has a separate 12-second deadline and retry.
A regression caught overlapping clicks on Review another copy starting multiple
refreshes; a synchronous check of the current attempt now prevents an older
review from clearing a newer copy. The legacy web copy RPC was removed after
migrating its sole caller.

Validation:
- Ten Worker cases cover frozen source replay, exact uncertain invitation replay,
  concurrent copies, later target edits/deletion, live-show blocks, response
  resets, account/permission/org boundaries, changed request selection,
  transactional rollback, guard changes during the batch, and empty/open rosters.
- Four roster-reader and six copy-control cases pass, including loader snapshot
  retirement, account/show isolation, deadlines, navigation retention, partial
  delivery, refresh-only retry and double-click review exclusion.
- Final full suite passes: 2,474 unit / 1,270 Worker tests. Web typecheck passes.
  Production build passes at 548,443 raw / 173,272 gzip main-entry bytes, within
  unchanged limits.
- Compiled Chrome/auth/D1 roster rehearsal passes rejection, eight-second read
  timeout, late-response rejection and Retry while keeping the original rows.
  No mail was produced.
- Compiled copy rehearsal holds a successful RPC reply, changes the source roster,
  navigates away/back, and recovers the same three copied positions. Four captured
  email attempts represent three accepted emails; only the uncertain recipient
  replays its original key. A later target edit survives an exact replay.
- Both recovery controls fit 320x480, 768x1024 and 1440x1000 with real hit tests.
  Phone screenshots were inspected. The first layout check sampled during the
  sidebar's closing transition; the final scripts wait for the hidden drawer to
  leave the viewport and verify the button at the click point. No browser runtime
  errors or external email.

Evidence: `/tmp/showpilot-roster-{before,ui1,full2,tsc4,build2,browser2}.log`,
`/tmp/showpilot-copy-{before,worker1,review-before,ui2,browser2}.log`. Rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-schedule-roster-recovery.mjs`
and `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-schedule-copy-recovery.mjs`.
PR #240 is green in run 42477242271 (CI 14m58s, native Rust 3m54s).
Phase 2 remains 67/79. Show creation/detail/removal, mobile recovery, other retained
form refresh concurrency and the broad product gates remain open. No production
deployment, release, remote migration or real-organization write. Twenty necessary
tracked Markdown files remain; none were added.

### Schedule refresh ownership, Phase 2 partial evidence (2026-11-08)

Branch: `fix/schedule-refresh-races`, based on `fix/schedule-roster-recovery`.
Repeated Retry clicks could start two refreshes before React rendered the pending
state. Three rendered component baselines reproduced this in assignment editing,
scheduling-source settings and reminders. An older refresh could also replace a
newer attempt or restore a cache entry removed at sign-out.

The shared `refreshRetainedResult` claims the current account/org request before
awaiting work. Only the exact pending cache object can finish the transition.
Assignment, source, reminder and team-copy controls use it, with a 12-second
refresh deadline and live-state checks before clearing a reviewed result.
A refresh-only retry does not repeat the accepted mutation or its invitation.

Verification:
- All three race baselines failed before the fix and pass now. Four additional
  QueryClient tests cover synchronous exclusion, cache removal, a newer command,
  and deadline recovery with a late completion. All 37 focused cases pass.
- Full suite passes: 2,481 unit and 1,270 Worker tests. Web typecheck passes.
  Production build passes at 548,443 raw / 173,274 gzip main-entry bytes, below
  unchanged limits.
- Existing compiled Chrome/auth/D1 rehearsals for source settings, assignments,
  reminders and team copy all pass at 320, 768 and 1440 pixels. They preserve
  original requests across navigation, newer edits and accepted email delivery.
  No runtime errors or external email. The double-click races themselves are
  verified by rendered component tests; these browser runs are regressions.

Evidence: `/tmp/showpilot-refresh-races-{before,ui1,full1,tsc1,build1,provider1,
assignment1,reminder1,copy1}.log`. Rerun the four
`apps/web/scripts/smoke-schedule-*-recovery.mjs` scripts with
`SHOWPILOT_SMOKE_RUNTIME=miniflare` after building.
Phase 2 remains 67/79. Show creation/detail/removal, mobile recovery and broad
product gates remain open. No production deployment, release, remote migration
or real-organization writes. Twenty necessary tracked Markdown files remain.

### Atomic show creation receipts, Phase 2 partial evidence (2026-11-08)

Branch: `fix/show-creation-recovery`, based on the green refresh change.
Three real-auth/D1 baselines reproduced duplicate web creation on exact retry,
retry rejection after a later title edit, and recreation of a deleted show.
The web validator dropped request IDs; the shared helper compared retries with
mutable show fields and wrote the show and its items in separate transactions.

Migration `0082_show_creation_recovery.sql` must follow 0081 before deployment.
A show creation now commits its actor/org/request receipt, stopped show, clean
rundown items and storage marker in one D1 batch. The receipt records the original
selection and survives show deletion. Exact retries preserve later target edits
and need not reread a changed or deleted source. Reusing the ID with different
input or an account is rejected. A request without an ID still creates a new show;
the four web forms still need retained request IDs and bounded recovery controls.
This change completes the shared server prerequisite, not those form flows.

The transaction checks fresh session/membership authority, the source and venue
timezone, and the current plan's remaining show slots. Parallel creators cannot
both take the last slot. Failed batches leave neither a partial show nor a
receipt. Malformed inventory content reports an error instead of silently seeding
an empty rundown. Native HTTP and web RPC now use one input contract, including
explicit timezones; native had previously dropped that field. Existing prices
and plan limits are unchanged.

Verification:
- Eighteen real-auth/Worker cases cover original-request recovery, changed payloads,
  account/org boundaries, identical concurrent requests, concurrent capacity,
  inventory defaults and timezone conversion, clean cloned execution state,
  changed/deleted sources, later target edits, deletion, batch rollback, permission
  revocation during preparation, malformed inventory, full-plan replay, and paid
  or active/expired trial capacity. These replace four mocked helper tests.
- Seven native adapter cases pass, including explicit timezone forwarding and
  rejection of invalid date/time/timezone/request IDs before writing.
- Final full suite: 2,478 unit and 1,288 Worker tests pass. Web typecheck and
  production build pass. Main entry is 548,443 raw / 173,274 gzip bytes, within
  unchanged limits. Migration manifest audit passes with 0082 pending.
- `smoke-show-creation-recovery.mjs` passes against the actual compiled app,
  authenticated web/native endpoints, D1 and RundownRelay. It discards the first
  create result, recovers one original show, preserves later title/item edits,
  shares the receipt through the native adapter, and refuses recreation after
  real show deletion. Its first run omitted the operator load/seed handshake
  before editing a newly created relay room; the final script includes that
  handshake. This is an endpoint rehearsal, not a rendered form test.
- The existing compiled team-copy browser rehearsal also passes, including the
  newly created target, navigation recovery, later edits, no duplicate accepted
  invitations and 320/768/1440 controls. No external email or runtime errors.

Evidence: `/tmp/showpilot-creation-{before,worker2,mobile1,full2,tsc3,build1,
smoke1,smoke2,copy-regression1,migrations}.log`. Rerun the new creation script and
`smoke-schedule-copy-recovery.mjs` with `SHOWPILOT_SMOKE_RUNTIME=miniflare` after
building. #242 is green in run 42479836231, CI 10m33s and native Rust 4m39s.
Phase 2 remains 67/79. Creation-form recovery, show edit/removal recovery, mobile
UI recovery and the broad product gates remain open. No production deployment,
release, remote migration or real-organization write. Twenty necessary tracked
Markdown files remain; none were added.

### Retained show creation forms, Phase 2 partial evidence (2026-11-08)

Branch: `fix/show-creation-forms`, based on the green atomic-creation change.
Two rendered baselines reproduced a draft disappearing after unmount/remount
and an indefinitely pending creation. All four web creation callers now use
`useShowCreation`. Schedule, Rundown and dashboard planning share one labeled
form; the dashboard's quick-copy card uses the same request/recovery controller.
A source audit finds the shared hook as the only web caller of createNextService.

Drafts and exact requests remain in the account/org/entry query cache across
navigation. Creation and request review have 15-second deadlines. Opening the
confirmed show is a separate operation with a 12-second deadline; its retry
never creates another show. Completion checks the exact cache owner so a cleared
account, newer attempt or abandoned page cannot receive an old result. Closing
the form remains available while saving. Inputs and recovery controls have
44-pixel targets. Inventory default times convert from venue time into the
explicit timezone shown in the draft. Dashboard planning scrolls within 70dvh.

Migration `0083_show_creation_review.sql` must follow 0082. Edit request first
settles the original request at the server: an existing creation stays intact;
a pending request gets a cancellation receipt that prevents its delayed creation
from writing. Only a confirmed cancellation or removed show unlocks a new request.
Failed/timed-out review retains the original command. An existing legacy show
without a matching receipt cannot be cancelled through this path. This is request
cancellation, not deletion of a created show. No remote migration ran.

Rundown opening now bounds the current-write wait and read, checks cancellation
before changing selection, and reports opening failure to the retained creation.
The live-output boundary test uses the remaining date-change handler as its end
marker after removing the old create handler; its no-publish assertion remains.

Validation:
- Sixteen rendered form/controller tests pass, including the two failing baselines,
  exact retry after navigation, single in-flight request/review, account isolation,
  cleared-cache protection, preparation/open/review deadlines, late replies,
  safe edited-request recovery and timezone conversion.
- Twenty-two creation Worker cases pass, including the prior 18 and four new
  review/cancellation cases. A creation paused before its batch cannot commit
  after review cancels it; completed and deleted creations return their actual
  outcomes. Review checks account/payload ownership and rolls back failed batches.
- Full suite passes: 2,492 unit / 1,292 Worker tests. Web typecheck and build pass.
  Main entry is 548,458 raw / 173,301 gzip bytes, below unchanged limits.
  Migration manifest audit passes with 0083 pending.
- Actual compiled Chrome/auth/D1/relay rehearsal passes draft restoration after
  navigation, a held successful creation reply, exact original retry and opening
  one show. Schedule then reviews a request held before delivery, fences that
  delayed write, and creates exactly one show from the edited request. There are
  no browser runtime errors. These mutation checks exercise Rundown and Schedule.
- Dashboard planning separately passes close/reopen draft retention and reachable
  layout. Recovery/modal and dashboard controls pass actual hit tests at 320x480,
  768x1024 and 1440x1000. The phone screenshots were inspected. The quick-copy
  card uses the tested controller; this run does not claim a separate browser
  mutation through that card.

Evidence: `/tmp/showpilot-create-form-{before,ui2,worker1,full1,full2,tsc3,build1,
browser1,browser2,migrations}.log`. The first full run stopped at the obsolete
boundary marker; the final full run passed. Rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-show-creation-forms.mjs`
after building. #243 is green in run 42485679947, CI 14m28s and native Rust 4m13s.
Phase 2 remains 67/79. Show details/deletion, inventory and mobile recovery plus
the broad product gates remain open. No production deployment, release, remote
migration or real-organization writes. Twenty necessary tracked Markdown files
remain; none were added.


### Show metadata commit guard, Phase 2 partial evidence (2026-11-08)

Branch: `fix/show-metadata-version-guard`, based on `fix/show-creation-forms`.
Five real D1/relay baselines reproduced stale metadata acceptance. A direct
writer could edit, delete, reschedule or begin deleting a show after the form's
version read but before the relay committed. A command whose fields matched the
live room also bypassed a saved-version check. This affects the shared Schedule
web/native save helper, which previously discarded the version it read.

The helper now sends the exact stored timestamp to the serialized relay command.
The metadata UPDATE compares that version, show ID, organization and service
date, and refuses a deletion tombstone. A failed comparison writes no rows,
restores the room state, leaves the revision and recent command IDs unchanged,
and returns a conflict through HTTP or a socket command result. Explicitly
requested fields are checked even when they equal the room's current values;
omitted fields remain untouched. Legacy SQLite timestamps still accept an
ISO-equivalent form version because the actual stored representation is forwarded.
The no-relay fallback also refuses shows being deleted. Error response bodies
are cancelled before throwing so failed saves do not retain relay requests.

Validation:
- Fourteen focused Worker cases pass, including the five failing baselines,
  restart persistence after rejected commits, fresh unchanged/partial saves,
  legacy timestamp formatting, invalid versions, fallback protection and a real
  socket conflict followed by a successful retry with the same rejected command ID.
- Full suite passes: 2,492 unit / 1,305 Worker tests. Web typecheck and production
  build pass. Main entry remains 548,458 raw / 173,301 gzip bytes under unchanged
  limits. The first focused fix run exposed an unconsumed error response delaying
  eviction; the final suite includes the response cleanup and passes.
- Compiled web/native adapters with real local authentication, D1 and RundownRelay
  pass successful saves, stale form rejection, a stale command sent directly to
  the relay, and preservation of the newer saved title. This is an endpoint
  rehearsal, not a browser layout or physical device test.

Evidence: `/tmp/showpilot-meta-version-{before,worker1,debug,worker2,worker3,
full1,tsc1,build1,smoke1}.log`. Rerun the endpoint rehearsal after building with
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-show-metadata-version.mjs`.
No migration is required. Phase 2 remains 67/79. Retained detail drafts, recovery
from lost successful save replies, deletion lifecycle races, inventory/mobile
forms and broad product gates remain open. No production deployment, release,
remote migration, real-organization writes or new Markdown files.


### Retained show details and save recovery, Phase 2 partial evidence (2026-11-08)

Branch: `fix/show-details-recovery`, based on the green metadata version guard.
The compiled baseline reproduced a successful Schedule save whose exact retry
failed as a stale edit. The form also kept its draft only in component state and
closed before its page refresh had succeeded.

Schedule show details now retains the draft, original version and request in an
account/org/show query entry across navigation. Saving and request review have
15-second deadlines; refreshing a confirmed save has its own 12-second deadline.
Expired requests abort their browser fetch. Labels name the operation that timed
out. Synchronous ownership of the actual cache entry prevents repeated clicks,
late results, cleared accounts and newer work from claiming each other's result.
A failed refresh retries only the refresh. Closing the modal stays available.
Fields and recovery controls have 44-pixel targets and show the draft timezone.

Migration `0084_show_details_recovery.sql` records the actor, original input and
outcome in the same D1 transaction as the metadata edit. Exact retries acknowledge
that outcome, including later changes and deletion, without writing the show
again. The transaction checks membership/session, show/date/version and deletion
state. Review can cancel an undelivered request before the draft becomes editable.
Conflicts show the current details and require an explicit choice to retain edits
against that version or use current details. Refresh is not offered as an implicit
way to discard a conflicted draft. Delete remains disabled while a save is unresolved.

The new internal operation runs in the existing serialized rundown writer. A small
DO intent, written before the D1 transaction, repairs a committed edit if DO state
persistence fails. Recovery reads current database rows rather than replaying old
fields. It preserves the live revision after an already-persisted intent fails to
clear. Member/session checks run when the relay processes the request and again in
the committing transaction. Unexpected persistence errors are recorded internally;
the form receives recovery instructions. Existing native calls still use the prior
version-guarded metadata path; native draft/request retention remains open.

Validation:
- Eighteen real-auth/D1/relay Worker cases pass: exact retries, later changes,
  deletion, cancellation fencing, duplicate saves, account/payload mismatch,
  stale conflicts, commit races, permission revocation, D1 rollback, DO persistence
  and intent-cleanup failures across restart, queued review, changed timezone
  settings, internal authentication and input validation.
- Thirteen rendered editor cases pass: draft retention, latest input, one pending
  operation, deadlines/aborted fetch, exact retry after navigation, no background
  navigation, separate refresh retry, review fencing, conflict choices, removed
  shows, account isolation and late results after cache removal.
- Final full suite passes: 2,505 unit / 1,323 Worker tests. Web typecheck and build
  pass. Main entry is 548,801 raw / 173,455 gzip bytes under unchanged limits.
  Migration manifest audit passes with 0084 pending; no remote migration ran.
- Compiled authenticated endpoint rehearsal recovers a lost successful save with
  one durable receipt. The existing web/native version-guard rehearsal also passes.
- Final compiled Chrome/auth/D1/relay rehearsal passes draft retention through
  navigation, held-success exact retry, cancellation of a request held before
  delivery, a newly reviewed save, and explicit review of a real competing relay
  edit before replacement. Retry and conflict controls pass actual hit tests at
  320x480, 768x1024 and 1440x1000. Phone screenshots were inspected. No browser
  runtime errors occurred. Retention is across SPA navigation, not hard reloads.

Evidence: `/tmp/showpilot-show-details-{before,worker1,worker2,ui1,ui2,ui3,full1,
full2,full3,tsc1,tsc2,tsc3,tsc4,tsc5,build1,build2,smoke1,browser1,browser2,
native-regression1,migrations}.log`. The first editor test run exposed use of the
proposed cache object instead of QueryClient's structurally shared stored object;
all ownership checks now use the actual stored claim. Rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-show-details-recovery.mjs`
and `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-show-details-form.mjs`
after building. #245 is green in run 42488482641, CI 15m34s and native Rust 4m42s.
Phase 2 remains 67/79. Deletion lifecycle/recovery, inventory, mobile recovery and
broad gates remain open. No production deployment, release, remote migration or
real-organization writes. Twenty necessary tracked Markdown files remain.


### Show deletion lifecycle, Phase 2 partial evidence (2026-11-08)

Branch: `fix/show-deletion-lifecycle`, based on #246. That PR is green in
run 42490726010: web CI 15m51s, native Rust 4m00s.

Three real-auth/D1/relay baselines reproduced a completed deletion retry failing
as "Show not found", Start and deletion both being accepted, and a retired show
accepting a late stage message after restart. Five additional baselines reproduced
late direct snapshot writes recreating output records after deletion.

Migration `0085_show_deletion_lifecycle.sql` adds an organization/show deletion
journal with reversible preparation, accepted cleanup and a completed receipt.
Preparation atomically checks membership/session, the reviewed show version and
persisted stopped state, then blocks new show/child/snapshot writes in D1. The
serialized rundown writer checks its actual timer and persists a reversible fence.
A refusal or permission loss before acceptance releases preparation. Transport
failure retains it for an authorized retry. Once accepted, timecode and matching
rundown rooms retire before the existing graph cleanup commits in one D1 batch.
The completed receipt survives removal, so both web and native retries confirm the
original deletion. Every retry checks current permission. A permanent rundown
retirement flag rejects late commands across eviction; unrelated legacy rooms are
preserved. Relay requests have five-second deadlines even when abort is ignored.

Validation:
- 27 real-auth/D1/relay cases pass: lost replies, Start race, persisted and actual
  live timers, malformed timer state, duplicate deletion, prepare/purge failures,
  permission loss, atomic cleanup rollback, stale confirmation, account/tenant
  isolation, late show/child/snapshot writes, more than 128 storage keys, complete
  graph cleanup, same-date siblings, unrelated legacy rooms and relay restart.
- Two transport tests pass, including a request that ignores abort and whose late
  response is still cancelled. The old five mocked deletion tests were replaced
  by stronger real Worker coverage of their original behaviors.
- Final full suite passes: 2,502 unit / 1,350 Worker tests. Web typecheck and
  production build pass. Main entry remains 548,801 raw / 173,455 gzip bytes under
  unchanged limits. The migration manifest audit passes with 0085 pending.
- The compiled web/native endpoint rehearsal passes first deletion, exact retry
  after a lost reply, one completed receipt and a native retry of that deletion.
  Its first run exposed a rehearsal timestamp interpreted in the host timezone;
  the fixture query now returns explicit UTC, matching the application's DTO.
  This is an endpoint rehearsal, not a new UI or physical-device claim.

Evidence: `/tmp/showpilot-show-delete-{before,worker1,worker2,snapshot-before,
worker3,full1,full2,tsc1,tsc2,build1,migrations,smoke1,smoke2}.log`. After building,
rerun `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-show-deletion-recovery.mjs`.
Phase 2 remains 67/79. Deletion form deadlines/retained recovery, inventory and
mobile forms, plus the broad product gates remain open. No production deployment,
release, remote migration or real-organization writes. Twenty necessary tracked
Markdown files remain; this change adds none.


### Schedule deletion recovery controls, Phase 2 partial evidence (2026-11-08)

Branch: `fix/show-deletion-controls`, based on #247. That PR is green in
run 42492846712: web CI 15m32s and native Rust 3m57s.

A compiled Chrome baseline held deletion before delivery. After 17 seconds the
original modal still had a disabled Delete button and no retry. Its progress was
component-local, and the old success callback closed the form before refreshing.

Schedule now retains deletion progress per account, organization and show in its
query cache. Confirmation captures the show name and metadata version; approval
closes only that show's details form. A named progress card stays available even
when the deleted show disappears from the list. Requests have a 15-second deadline
and abort their fetch; an unconfirmed result retains the original command for
Retry deletion. Refresh has a separate 12-second deadline and never deletes again.
Late replies cannot replace newer work, recreate a cleared cache, refresh another
account or close another form. Confirmation abandoned during navigation sends
nothing. Details saves and deletion have synchronous mutual guards. Retention is
across SPA navigation, not hard reloads.

A structured rejected response is limited to a deletion that was not accepted.
It asks the operator to refresh and confirm again, preserving the original target
on screen. Two additional failing Worker baselines showed why cleanup refusal
must remain unconfirmed after acceptance, including an overlapping retry. The
coordinator now preserves recovery in those cases and recognizes a completion
that lands between its initial receipt and show-row reads. Native endpoints keep
the same success contract and share the server protections.

Validation:
- Thirteen rendered progress cases pass: explicit/cancelled/abandoned confirmation,
  repeated clicks, timeout and aborted transport, exact retry across navigation,
  confirmation while away, separate bounded refresh, account and cache isolation,
  out-of-order shows, rejection versus uncertainty, and details/deletion exclusion.
  The existing thirteen details-editor cases remain green.
- All 31 real-auth/D1/relay deletion Worker cases pass, including four new response
  classification cases. Full suite passes: 2,515 unit / 1,354 Worker tests.
- Typecheck and production build pass. Main entry is 548,792 raw / 173,452 gzip
  bytes under unchanged limits. No new migration; this depends on pending 0085.
- Final compiled Chrome/auth/D1/relay rehearsal passes Cancel sending nothing,
  withheld delivery and successful replies, recovery after navigation and after
  row removal, three identical request payloads with one completed receipt,
  a real competing metadata edit rejecting stale confirmation, and a fresh
  confirmation succeeding. Recovery controls pass actual hit, text containment
  and 44-pixel checks at 320x480, 768x1024 and 1440x1000. Phone screenshots were
  inspected. No browser runtime errors and no document reload occurred.
- Compiled web/native deletion retry endpoint rehearsal remains green.

Evidence: `/tmp/showpilot-show-delete-ui-before2.log` and
`/tmp/showpilot-show-delete-controls-{ui1,ui2,worker1,rejection-before,worker2,
full1,full2,tsc1,tsc2,tsc3,build1,build2,browser1,browser2,endpoints}.log`.
The first focused UI test needed its repeated-click event held on the same DOM
button; typecheck also required distinct confirming/deleting union variants.
Final checks include both corrections. Screenshots:
`/tmp/showpilot-delete-{retry,rejected}-{320,768,1440}.png`.
Rerun after building with
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-show-deletion-form.mjs`.
Phase 2 remains 67/79. Inventory/mobile recovery, product-wide label/viewport and
terminology sweeps, the owner-provided Founding Member deadline and broad gates
remain open. No production deployment, release, remote migration or real-org
writes. Twenty necessary tracked Markdown files remain; none were added.


### Inventory request and form recovery, Phase 2 partial evidence (2026-11-08)

Four real-auth/D1 baseline failures reproduced duplicate creation on exact retry,
failed acknowledgement of a completed archive, late archive retries undoing a
restore, and stale archive requests changing a newer row. Compiled Chrome also
reproduced loss of an inventory draft when closing and reopening the dialog.

Migration 0086 adds org/request receipts that commit atomically with inventory
changes and survive item removal. Every attempt verifies the current session,
actor and schedule permission; the transaction rechecks membership and the exact
source or inventory version. Replays read the receipt before mutable sources.
They preserve later restores and edits, reject changed request payloads, and
cannot recreate a removed item. A review records cancellation when the original
request has not arrived, fencing later delivery. Invalid source snapshots produce
visible errors instead of silently creating an empty rundown. New snapshots reset
runtime fields and receive new item identities. Existing native create and
archive/restore endpoints use the same writer; older native state-change requests
receive a stable request ID derived from their actor, item, desired state and
reviewed version. Native request bodies and success responses stay compatible.

The web form retains drafts and exact requests per account and organization
through dialog closure and SPA navigation. Saves/reviews have 15-second deadlines;
refresh has a separate 12-second deadline and never repeats a confirmed mutation.
Late results cannot restore cleared account work or refresh another screen.
Archive requires confirmation with a scope note; restoration remains direct.
Unavailable selected sources remain visible and require an explicit replacement.
Fields have labels, controls have 44-pixel targets, long names wrap and narrow
forms use one column. Confirmed writes keep Inventory open and refresh its list.
Retention covers SPA navigation, not a hard reload.

Validation:
- Full web suite: 2,530 unit / 1,373 Worker tests passed, including 19 real-auth/D1
  inventory cases. Cases cover transaction rollback, commit-time source/row and
  membership races, concurrent apply/review, numeric legacy timestamps, template
  removal, item removal, cross-account/org attempts and actual native endpoints.
- Twelve hook cases and three rendered editor cases cover exact retries,
  retained drafts, bounded write/refresh, cache/account isolation, cancellation,
  conflicts, explicit archive confirmation, missing sources and view-only access.
  Four native adapter unit cases also pass. Final focused rerun: 19 tests green.
- Web typecheck and production build pass. Main entry: 549,525 raw / 173,749 gzip
  bytes, within unchanged limits. Migration 0086 is local-only and must be applied
  before deploying this branch. No production migration manifest was changed.
- Compiled Chrome with real auth and disposable D1 passes draft retention across
  navigation, lost-success create retry with one item/receipt, cancellation before
  delivery, a fresh reviewed submission, archive cancellation sending nothing,
  lost archive reply retry and restore. Retry/add controls pass actual hit tests,
  text containment and 44-pixel checks at 320x480, 768x1024 and 1440x1000. All form
  inputs have labels. Phone screenshots were inspected; no runtime errors or
  document reload occurred. Inspection also caught generic timeout wording,
  now replaced with an inventory-specific unconfirmed-result message.

Evidence: `/tmp/showpilot-inventory-{before,worker1,worker2,browser-before,ui1,
ui2,ui3,full1,tsc2,tsc3,tsc4,tsc5,build1,build2,browser1,browser2}.log`.
The first UI run exposed an overly strict assertion that a cleared query cache
must stay absent, although the mounted blank form correctly reseeds it. Typecheck
also found unused route helpers and a test DOM cast; all were corrected.
Rerun after building:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-show-inventory-form.mjs`.
Screenshots: `/tmp/showpilot-inventory-{retry,form}-{320,768,1440}.png`.

The preceding PR #248 is green: CI 42494452050, web 10m6s / native Rust 4m30s.
Phase 2 remains 67/79. Native form recovery, remaining product-wide controls,
loading, terminology and viewport audits, the owner-provided Founding Member
closing date and broad gates remain open. No deployment, release, remote
migration or real-org writes. Twenty necessary tracked Markdown files remain;
none were added.


### Native inventory recovery, Phase 2 partial evidence (2026-11-08)

Three rendered native-sheet baseline failures reproduced draft loss on close,
archive sending immediately without confirmation, and editable fields while a
save was unresolved. The actual native component is transpiled for these tests;
native rendering boundaries are replaced without replacing its state logic.

The native sheet now retains drafts and exact commands per account/workspace in
Query, locks edits until a request is confirmed or reviewed, and separates write
recovery from refresh recovery. Commands/reviews expire after 15 seconds and
refresh after 12 seconds. Native schedule reads also have a 10-second transport
and response-body deadline. Closing or unfocusing a screen retains late outcomes
without refreshing that screen; cleared caches and changed accounts cannot be
repopulated by old results. Archive requires explicit native confirmation with a
scope note and the reviewed item version. Abandoned confirmation sends nothing.
Unavailable sources remain selected until explicitly replaced. Buttons wrap,
mini-buttons and the close control have 44-pixel targets, fields have labels, and
the Inventory opener has a button role. Disabled archive/restore controls dim.

New `/api/mobile/v1/schedule/inventory/command` and `/review` endpoints return the
full receipt and current item through the shared 0086 writer. They check the
selected workspace and actor as well as current membership. Native receipt parsing
preserves applied/conflict/superseded/cancelled/removed outcomes. The application
uses these endpoints; old server routes remain for already-installed builds.
Unused native client wrappers were removed. Both new endpoints are registered
in the native parity contract list. No new migration; this depends on 0086.

Validation:
- Twenty native hook/form tests pass for retention, synchronous duplicate-click
  claims, exact retry, cancellation, separate refresh, timeout/abort, scope/cache
  isolation, unavailable sources, native confirmation and abandoned confirmation,
  and late results while unfocused. An initial test run mixed web/native React
  dispatchers; the fixture now runs the unchanged hook with one React/Query pair.
- All 22 real-auth/D1 inventory Worker cases pass, including actual native
  command/review routes, cancellation before delivery, preservation of a later
  restore, stale versions, actor/workspace mismatch and revoked membership.
- Full web suite: 2,550 unit / 1,376 Worker tests. Web and native typecheck pass;
  web production build passes at 549,525 raw / 173,749 gzip main-entry bytes.
- Native verification passes typecheck, lint with warnings only, Expo doctor,
  iOS/Android Hermes exports, web export and polling checks. The final native
  bundles are 5,481,631 bytes for iOS and 5,480,735 for Android, below the
  unchanged 6,500,000-byte budget.
- Compiled endpoint rehearsal uses real auth/D1 and the native receipt parser.
  Create/archive replay, current-state review, late archive after restore,
  stale-version conflict, cancellation before delivery, a fresh reviewed command,
  account/workspace checks, anonymous denial and the schedule read pass. The first
  run lost a local socket on its final schedule read; the identical isolated
  rerun passed without an application or probe change.
- Exported Expo web renders the actual native sheet, hook and API client against
  disposable local data. Draft close/reopen, held-success retry, locked fields,
  one item, review before delivery and a new request after review pass. A confirmed
  write followed by an injected schedule-read failure offers Refresh inventory;
  recovery sends no second write. Final actual hit/text/44px checks cover Retry,
  Review and Close at 320/768/1440 pixels. Final phone/tablet screenshots were
  inspected, and there were no browser runtime errors. The first run found
  the missing Inventory button role; screenshot review also caught the 42-pixel
  close target. Both were fixed. This is Expo web rendering and native bundle
  verification, not an iOS/Android device UI rehearsal.

Evidence: `/tmp/showpilot-native-inventory-{before,ui1,ui2,ui3,mobile-tsc1,
web-tsc1,worker1,full1,build1,verify1,verify2,verify3,verify4,endpoints1,endpoints2,
browser1,browser2,browser3,browser4}.log`. After building, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-inventory-recovery.mjs`
and, after `pnpm --filter @showpilot/mobile verify`,
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-inventory-form.mjs`.
The browser redirects all API traffic to local fixtures and blocks other external
requests. Screenshots are `/tmp/showpilot-native-inventory-{320,768,1440}.png`.

Preceding PR #249 is green: CI 42496644950, web 13m9s / native Rust 3m55s.
Phase 2 remains 67/79. Other native schedule/profile/reminder recovery, remaining
product-wide control and loading audits, the owner-provided Founding Member
closing date and broad gates remain open. No production deploy, release, remote
migration or real-org writes. Twenty necessary tracked Markdown files remain.


### Phase 2 native schedule reminder recovery (2026-11-08)

The native reminder route bypassed the durable web reminder request. A real D1
regression reproduced five sends after retrying a two-recipient request and adding
a third assignee: both original invitations were resent and the new assignee was
included. The route now uses the shared 0079 receipt/outbox path. The new native
`/api/mobile/v1/schedule/reminders` endpoint validates actor and workspace and
returns each recipient's delivery state. The native client uses that endpoint;
unused count-only client wrappers were removed. Installed clients' old routes
remain supported, but builds without a request ID still need an app update for
exact-request retry. No new migration; 0079 remains required.

Native Schedule retains attempts by account, organization and selection across
screen navigation. Duplicate presses claim work synchronously. Retry uses the
same command and recipients, while an explicit new reminder uses a fresh ID.
Accepted, rejected, uncertain, expired and changed results remain visible per
recipient; accepted email is not described as received. A confirmed delivery with
a failed schedule read offers a separate Refresh action. Send and refresh are
bounded to 15 and 12 seconds, including transports that ignore cancellation.
Late responses cannot restore cleared account work or refresh an unrelated screen.
Results remain visible if the original row disappears. Retention is in the active
app's query cache, not durable storage across process termination.

The generic native deadline helper now serves both inventory and reminders;
inventory's existing behavior tests still pass. Narrow Schedule headers move
44px action buttons below the title, accounting for font scale, instead of
splitting the title. Reminder controls have inline progress, wrapped text and
44px-or-larger targets. The progress panel is outside conditional assignment rows.

Validation:
- Twenty-two new native hook/component cases pass, including per-target parallel
  completion, exact retry, partial delivery, separate refresh, timeout/focus/cache
  handling, expired/changed review and absent-target results. Eight real-auth/D1
  reminder Worker cases pass, including the new and installed-client routes,
  frozen recipients, stable delivery identity, and permission/actor/org denials.
- Full web suite passes 2,572 unit and 1,379 Worker tests, including a second full
  run after the header correction. Web/native typecheck and production web build
  pass. Main entry remains 549,525 raw / 173,749 gzip bytes (175,000 gzip budget).
- Native verification passes lint (warnings only), doctor 18/18, polling and
  contract checks, and iOS/Android/web exports. Final Hermes sizes: iOS 5,499,560,
  Android 5,498,699 bytes; unchanged limit 6,500,000.
- Exported Expo web with the actual native hook/API, real local auth/D1, and
  locally captured email passes lost-success retry, stable invitation token and
  provider key, no repeat of accepted delivery, rejected recipient detail,
  explicit new sends, and read-only refresh recovery. Retry hit/text/target checks
  and header layout pass at 320/768/1440 pixels with no browser runtime errors.
  Final phone/tablet screenshots were inspected. The first screenshot review
  found the title squeeze and led to the header fix. The next probe needed to
  wait for React Native's resize-driven action relocation; the final run passed.
  This proves exported Expo behavior, not physical iOS/Android device UI behavior.

Evidence: `/tmp/showpilot-native-reminder-{before,worker1,worker2,hooks1,tsc1,
web-tsc1,full1,full2,build1,verify1,verify2,browser1,browser2,browser3}.log`.
After web build and mobile verify, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-reminder-recovery.mjs`.
Screenshots: `/tmp/showpilot-native-reminder-{320,768,1440}.png`.

Preceding PR #250 is green: CI 42499053947, web 12m36s / native Rust 4m32s.
Phase 2 stays 67/79: other native schedule/profile recovery and product-wide
loading/control audits remain, as do the owner-provided Founding Member closing
date and broad gates. No deployment, release, remote migration, real-org write
or external email. Twenty necessary tracked Markdown files remain.


### Phase 2 native team-copy recovery (2026-11-08)

A real native-route/D1 regression reproduced a failed exact retry: after copying
one position, adding a source position made the old endpoint return 409 instead
of recovering the original copy. That endpoint rebuilt its expected rows from
the current source and used index-derived target IDs. It now delegates to the
shared 0081 copy receipt and invitation outbox. Non-UUID request identities from
installed clients get a deterministic scoped UUID; the adapter reads the stored
show/date selection before mutable source/target data. Changed or removed copied
positions produce an explicit review error for count-only clients, without
recreating rows or resending their invitations.

The updated app uses `/api/mobile/v1/schedule/copy-team` for full per-position
results. Requests validate actor, workspace, dates and source ordering, then use
the same authorized writer. Copy confirmations show both show names and dates,
the position count and invitation scope, with an explicit Cancel action. The
confirmation clears when Schedule loses focus. Results remain above the show
list even after copying removes the row's Copy button. Unknown sends retain the
original command; retries cannot include newly added source positions. Accepted,
uncertain, rejected, open and changed positions have distinct text. A failed
read after a confirmed copy offers Refresh without copying or sending again.
Another copy requires review, a fresh ID, and an empty, stopped destination.

Copy and reminder hooks now share the bounded retained-request owner rather than
duplicate its cache, account, focus and response-correlation logic. Sends have a
15-second limit and refreshes 12 seconds; late responses cannot restore cleared
account data or refresh another screen. Results persist across navigation in the
active app cache, not across app process termination. The old count-only native
copy client parser was removed. Full details require the updated app. No new
migration; this path depends on existing 0081 and its earlier assignment/outbox
migrations.

Validation:
- Thirteen new copy hook/component cases pass, covering retained commands,
  uncertain invitation retry, blocked/changed copies, explicit fresh requests,
  refresh-only recovery, abandoned confirmations and visible per-position errors.
  All 22 native reminder cases remain green through the shared-owner refactor.
- Fourteen real-auth/D1 copy Worker cases pass. Native coverage includes installed
  route source changes and later target deletion, full-result uncertain delivery
  with stable provider identity/body, no deleted-row revival, and anonymous,
  actor/workspace, future-source and revoked-permission denial. Existing atomic
  copy/concurrency and receipt tests remain green.
- Final full suite: 2,585 unit / 1,383 Worker tests. Two old fake-SQL unit cases
  initially failed because the adapter now delegates; they now verify stable
  identity, receipt selection and delegation, while real D1 verifies transactions.
  Final web typecheck/build pass; main entry remains 549,525 raw / 173,749 gzip.
- Native verification passes typecheck, lint with warnings only, doctor 18/18,
  polling and contract checks, and iOS/Android/web exports. Final Hermes bundles:
  iOS 5,513,910 / Android 5,512,941 bytes, below the unchanged 6,500,000 budget.
- Exported Expo app against real local auth/D1 and captured email passes Cancel
  without writes/mail, lost-response exact retry, source-roster freeze, stable
  invitation token/provider key, no repeated accepted delivery, per-position
  rejection, read-only refresh recovery and the nonempty-target guard. Retry
  hit/text/44px checks pass at 320/768/1440 pixels with no browser runtime errors.
  Screenshots were inspected; wording now distinguishes copied invitations from
  reminders. The initial rehearsal hit the fixture's three-show Free-plan limit;
  the final fixture uses its local paid-plan setting. No plan limit was changed.
  The reminder browser rehearsal also passes after the shared-owner refactor.
  These are exported Expo rehearsals, not physical iOS/Android UI verification.

Evidence: `/tmp/showpilot-native-copy-{before,worker1,worker2,ui1,reminders1,
mobile-tsc1,web-tsc1,web-tsc2,full1,full2,full3,full4,build1,build2,verify1,
verify2,verify3,browser1,browser2,browser3,reminder-browser}.log`.
After web build and mobile verify, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-copy-recovery.mjs`
and `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-reminder-recovery.mjs`.
Final copy screenshots: `/tmp/showpilot-native-copy-{320,768,1440}.png`.

Preceding PR #251 is green: CI 42500905406, web 10m23s / native Rust 3m56s.
Phase 2 remains 67/79. Native assignment/team-builder draft and save recovery,
other native profile/schedule paths, the remaining product-wide audits, owner
Founding Member deadline and broad gates remain open. No production deployment,
release, remote migration, real-org writes or external email. Twenty necessary
tracked Markdown files remain.

## Phase 2 follow-up: native assignment draft and save recovery (2026-11-08)

On `fix/native-assignment-recovery`, the actual native assignment sheet first
failed two regressions: closing/reopening discarded the draft, and submitted
fields stayed editable while a save was unconfirmed. The editor now retains
account/workspace/editor-scoped drafts and exact requests across screen closure.
Schedule exposes resume controls independently of the selected date or surviving
show/position rows. Fields lock while results are unconfirmed, current details
are loading, or a destructive confirmation is open. Explicit Finish removes a
settled editor; unsent drafts have confirmed discard. This cache survives screen
navigation, not sign-out or process restart; the editor states that limit.

Native create/edit/delete now use the existing 0080 assignment receipts and
revision checks, with full invitation results from the 0079 outbox. Retry keeps
the original command, position and invitation identity. A new review command
records a conflict receipt for an unapplied request before unlocking its draft,
so a late original request cannot apply afterward. Already-applied review recovers
the original receipt and may retry the same invitation; it is explicitly different
from read-only refresh. Revision conflicts preserve typed fields until the user
loads current details. Missing positions are not recreated. Current-detail reads
return venue timezone for ISO-to-wall-time conversion. Confirmed crew replacement,
removal and draft discard use inline confirmations with Cancel. Replacement of a
declined assignment preserves that original response and is described as a new
replacement position.

Writes/reviews use the shared 15-second deadline, refresh uses 12 seconds, and
current-detail reads use 8 seconds. Late reads, abandoned focus/account callbacks
and cleared caches cannot overwrite new drafts. The installed-client backend
routes remain for compatibility; unused current-client edit/delete wrappers are
removed. Team builder still uses the older create flow and remains separate work.
No migration is added; existing 0079/0080 and their prerequisites are required.

Validation:
- Sixteen new native hook/component cases pass, including both reproduced
  failures, exact retry, cancellation review, partial delivery, refresh-only
  recovery, revision conflict, removed rows, ignored transport deadlines, blur,
  account-cache clearing, global resume, Finish/discard and scoped confirmations.
- Twenty-three real-auth/D1 assignment Worker cases pass, including eight new
  native-route cases: review-before-create/edit/delete, review after uncertain
  delivery with identical provider request, concurrent review/write, versioned
  edit/delete/tombstones, read timezone/revision, anonymous/actor/org/revocation
  denial. One initial fixture omitted app_setting.id; the corrected fixture passes.
- Final full suite: 2,601 unit / 1,391 Worker tests. Web typecheck and build pass;
  main entry remains 549,525 raw / 173,749 gzip bytes under unchanged budgets.
- Final mobile verification passes typecheck, lint with warnings only, doctor
  18/18, polling/contracts and all three platform exports. Hermes bundles are
  iOS 5,538,999 / Android 5,538,006 bytes against the unchanged 6,500,000 limit.
- Exported Expo editor against disposable real auth/D1 passes retained drafts,
  locked fields, exact retry without duplicate positions, refresh without writes,
  review fencing delayed delivery, conflict preservation, explicit current-detail
  review and confirmed removal. Retry/review/close controls pass visible text,
  reachability and 44px checks at 320/768/1440 pixels. Final phone/tablet screenshots
  were inspected; recovery text is 13px. Zero browser runtime errors. Team-copy
  and reminder browser rehearsals also pass after the shared request-owner change.
  These are exported Expo checks, not physical iOS/Android UI verification.

Evidence: `/tmp/showpilot-native-assignment-{before,mobile-tsc1,ui1,ui2,hooks1,
worker1,worker2,web-tsc1,web-tsc2,full1,full2,build1,verify1,verify2,browser1,
browser2,copy-browser,reminder-browser}.log`. After web build and mobile verify,
rerun `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-assignment-recovery.mjs`.
Final screenshots: `/tmp/showpilot-native-assignment-{320,768,1440}.png`.

Preceding draft PR #252 is green (CI 42502924082, web and native Rust).
Phase 2 remains 67/79. Team-builder and other native profile/schedule recovery,
product-wide audits, the owner Founding Member deadline and broad gates remain
open. No production deployment, release, remote migration, real-org writes or
external email. Twenty necessary tracked Markdown files remain.

## Phase 2 follow-up: native team-builder recovery (2026-11-08)

On `fix/native-team-builder-recovery`, the actual sheet first failed two tests:
closing discarded selected people/roles, and Create sent invitations without
review. The old parent also used one unbounded Promise.all, losing per-person
results when any request failed and conflating refresh failure with write failure.

Team drafts now belong to the account/workspace/show and remain reachable from
Schedule after closure or date changes. Selected people stay visible when their
roster contact is unavailable. Review names the show/date, department, people and
roles; Cancel sends nothing. Fields lock during review and unconfirmed work.
Finish removes settled work; unsent draft discard requires confirmation. The UI
states that local drafts survive navigation, not sign-out or process restart.

Each selected position gets a frozen UUID command using the existing assignment
receipt API. Results distinguish saved, unapplied, changed and unconfirmed rows,
with invitation delivery status. Retry sends only unresolved rows with their
original commands and preserves accepted invitations. Review uses the existing
cancellation receipt for undelivered requests; late arrivals cannot create those
positions. Editing after review retains only unapplied positions, so successful
creates are not repeated. Row requests have a 12-second bound inside the shared
15-second group envelope; refresh has its own 12-second bound and never writes.
No backend route or migration was added. The last old current-client assignment
create wrapper/result schema was removed; installed-client backend routes remain.

The compiled browser exposed an additional resume-list bug. The list subscribed
to a cache version but read its rows separately; React Compiler cached the empty
list. An explicit useMemo/version dependency still cached the populated list,
as confirmed by inspecting the generated module. The shared retained-draft list
now supplies actual, referentially stable draft arrays through useSyncExternalStore.
Both native team and individual-assignment resume lists use it. The final compiled
rehearsal verifies addition, edited labels and removal, beyond uncompiled hook tests.

Validation:
- Nineteen new native hook/component cases pass, including both original failures,
  partial/exact retry, uncertain delivery, cancellation review, refresh-only
  recovery, deadlines/late replies, actor/request mismatch, abandoned focus,
  account-cache clearing, live resume-list updates, unavailable contacts and Finish.
- Twenty-six real-auth/D1 assignment Worker cases pass, including three new team
  cases: committed reply loss, review-before-delivery and late-arrival fencing,
  stable uncertain invitation recovery and no revival of a removed successful row.
- Final full suite: 2,620 unit / 1,394 Worker tests. Web typecheck/build pass; main
  entry remains 549,525 raw / 173,749 gzip bytes within unchanged budgets.
- Final mobile verification passes typecheck, lint with warnings only, doctor
  18/18, polling/contracts and iOS/Android/web exports. Hermes: iOS 5,561,400 /
  Android 5,560,448 bytes, below the unchanged 6,500,000 budget.
- Exported Expo team builder against real disposable auth/D1 and captured mail
  passes retained selection, Cancel without writes/mail, visible partial results,
  exact unresolved-only retry, stable provider key/token, accepted mail not repeated,
  refresh without mutations, late-request cancellation and editing only unapplied
  positions. Retry/review/close controls pass 44px, reachability and text checks at
  320/768/1440 pixels. Phone/tablet screenshots inspected; no runtime errors.
  Final individual-assignment, copy and reminder browser regressions also pass.
  These are Expo export checks, not physical iOS/Android UI verification.

Evidence: `/tmp/showpilot-native-team-{before,tsc1,forms1,hooks1,worker1,web-tsc1,
web-tsc2,web-tsc3,full1,full2,full3,build1,verify1,verify2,verify3,browser1,
browser2,browser3,assignment-browser,assignment-browser2,copy-browser,
copy-browser2,reminder-browser,reminder-browser2}.log`.
The first two team browser attempts expose the compiled resume-list failures;
`browser3` verifies the final fix. After web build and mobile verify, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-team-recovery.mjs`.
Final screenshots: `/tmp/showpilot-native-team-{320,768,1440}.png`.

Preceding draft PR #253 is green (CI 42504988679; web 11m12s / Rust 3m50s).
Phase 2 remains 67/79. Other native profile/schedule recovery, product-wide audits,
the owner Founding Member deadline and broad gates remain open. No production
release/deployment, remote migration, real-org writes or external email. Twenty
necessary tracked Markdown files remain.

### Native show-creation recovery, 2026-11-08

Branch: `fix/native-show-creation-recovery`, stacked on
`fix/native-team-builder-recovery`. Three native creation forms previously kept
local drafts, allowed ambiguous retry after a failed reply, and offered no
separate recovery for a failed list refresh after successful creation. The new
native recovery endpoint initially failed its adapter test with 404.

Schedule, Shows, and the rundown now use one retained account/workspace creation
form. Closing or navigating preserves fields, source identity and venue timezone
for the signed-in app session. A pending or unconfirmed command locks its fields;
Retry original creation sends the same request. Review original creation uses the
existing 0082/0083 receipt and cancellation fence before offering Edit unapplied
draft. A created or removed result cannot create again. A failed refresh keeps the
confirmed result and offers Refresh only. Mutation/review deadlines are 15 seconds;
refresh is bounded at 12 seconds. Explicit discard is limited to unsent drafts.

All three current callers migrated; the duplicate Shows/rundown forms and old
native create wrapper were removed. The installed-client server route remains.
The two new native endpoints require original actor/request identity and current
schedule permission, and delegate to the existing atomic creation/review helpers.
There is no new migration. Source choices never silently turn into blank shows
when the list changes. Inventory defaults and same-day copy remain available.

The compiled browser rehearsal exposed a real rundown-entry failure: the relay's
initial null location made creation validation fail before live sync connected.
The rundown now uses the loaded show's location until the relay supplies a string.
An explicitly typed initial draft prevents the fallback branch from bypassing type
checking through an array index. The new-show control also meets 44px/12px targets.

Validation:
- Nineteen added native adapter/hook/form cases pass. They cover retained fields
  and sources, immutable/exact retry, 15s/12s deadlines, failed refresh without a
  repeated mutation, review before editing, deleted shows, inactive owners, late
  replies, account/workspace separation, identity mismatch, global resume and
  explicit discard. Existing inventory/assignment/team form cases pass.
- Twenty-eight real-auth/D1 creation Worker cases pass, including six new native
  cases for receipt replay, venue timezone, cancellation-before-delivery, removal,
  changed payload, create/review races and current tenant/permission checks.
- Final full suite: 2,639 unit / 1,400 Worker tests. Web typecheck and production
  build pass. Main entry remains 549,525 raw / 173,749 gzip bytes within unchanged
  budgets.
- Final native verification passes typecheck, lint with existing warnings only,
  iOS/Android/web exports, Expo doctor 18/18, polling and API contracts. Hermes:
  iOS 5,561,207 / Android 5,560,287 bytes, below the unchanged 6,500,000 budget.
- Exported Expo app against disposable real auth/D1 passes all three creation
  entries, close/reopen and cross-route retention, frozen source, a committed but
  lost response with exact retry, refresh-only recovery, cancellation of an
  undelivered request, late-arrival rejection, fresh reviewed creation, and
  same-day rundown copying with next-hour defaults. Recovery controls pass 44px,
  text and reachability checks at 320/768/1440 pixels. Phone/tablet screenshots
  inspected. No browser runtime errors. The compiled team-builder regression also
  passes partial/exact retry and cancellation recovery at those widths.
  Expo export evidence does not establish physical iOS/Android UI behavior.

Evidence: `/tmp/showpilot-native-show-{before,hooks1,hooks2,worker1,worker2,tsc1,
tsc2,tsc3,web-tsc1,web-tsc2,web-tsc3,full1,full2,build1,verify1,verify2,
browser1,browser2,browser3,team-browser}.log`. Browser1 needed an unambiguous
modal-button selector; browser2 caught the null-location failure; browser3 proves
the final behavior. Final screenshots: `/tmp/showpilot-native-show-{320,768,1440}.png`.
After web build and mobile verify, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-show-creation.mjs`.

Preceding draft PR #254 is green (CI 42506636275; web 16m27s / Rust 3m43s).
Phase 2 remains 67/79. Native show editing/deletion, other mutation recovery and
product-wide gates remain open. There was no production deployment/release,
remote migration, real-org write or external mail. Twenty necessary tracked
Markdown files remain.


### Native Schedule show edit/delete recovery, 2026-11-08

Branch: `fix/native-show-edit-delete-recovery`, stacked on
`fix/native-show-creation-recovery`. Schedule previously held show edits only in
the open sheet, coupled saves to refresh, and deleted through a one-shot alert
without a retained original request or reviewed version. Both new native command
adapter tests initially failed with 404.

Schedule now retains edit/delete drafts and immutable requests per account,
workspace and show for the signed-in app session. Edit and delete share one slot,
so a new action cannot replace an unresolved change. Closing the sheet preserves
its fields and request. Resume remains above the list even after deletion removes
the row. Retry sends the original payload; edits can also review the existing
receipt/cancellation fence before allowing changes. A confirmed change with a
failed list refresh offers Refresh only. A conflict keeps the draft, and replacing
it requires an explicit Load current confirmation. Deletion previews its scope,
requires confirmation and the reviewed version, and cannot be discarded while its
outcome is unknown. Command/review deadlines are 15 seconds, refresh 12 seconds,
and explicit current-show reads 8 seconds.

New native adapters delegate to the existing edit receipt and deletion lifecycle.
They bind actor, organization, show and request identity and recheck current
permissions. Current-show reads recheck permission after fetching the snapshot.
A reproduced server bug also misclassified expired authentication as a definitive
deletion rejection after purge had already started. That now remains unconfirmed
until the original account can retry the existing journal. Installed-client
server routes remain available; obsolete current-native wrappers and the old
Schedule edit sheet were removed. Rundown metadata editing keeps its separate
PIN/revision path and remains follow-up work. There is no migration.

Validation:
- Twenty-one new native hook/form cases pass, plus related inventory, assignment
  and team form regressions. They cover exact retry, shared edit/delete ownership,
  unknown outcomes, deadlines, failed refresh, explicit current reads, cancellation,
  focus/account changes, identity mismatches and retained drafts.
- Fifty-nine real-auth/D1/relay Worker cases pass, including ten added cases for
  native commands/reads and expired authentication after accepted deletion.
- Full suite: 2,660 unit / 1,410 Worker tests. Web typecheck and production build
  pass. Main remains 549,525 raw / 173,749 gzip bytes within unchanged budgets.
- Native verification passes typecheck, lint with existing warnings, all three
  exports, Expo doctor 18/18, API contracts and polling checks. Hermes is
  5,585,330 bytes on iOS and 5,584,398 on Android, below the 6,500,000 limit.
- The compiled Expo app against disposable real auth/D1 passes close/resume,
  competing-action retention, committed-but-lost reply with exact retry, refresh
  failure without repeat mutation, review cancellation of a delayed save,
  conflict preservation and explicit reload, deletion confirmation cancellation,
  resume after the row disappears, and exact deletion retry to completed cleanup.
  Controls pass 44px, text-fit and reachability checks at 320/768/1440 pixels.
  Phone/tablet screenshots inspected; zero browser runtime errors.
- The compiled creation regression passes all three entry points, cross-route
  retention, exact retry, refresh recovery, review cancellation and same-day copy.
  Expo web checks do not establish physical iOS/Android UI behavior.

Evidence: `/tmp/showpilot-native-show-edit-{before,worker1,worker2,worker3,
hooks1,web-tsc1,web-tsc2,web-tsc3,native-tsc1,full1,build1,verify1,browser1,
creation-browser}.log` and `/tmp/showpilot-native-show-delete-auth-before.log`.
Screenshots: `/tmp/showpilot-native-show-{edit,delete}-{320,768,1440}.png`.
After web build and mobile verify, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-show-management.mjs`.

Preceding draft PR #255 is green (CI 42508833299, web 16m13s / Rust 3m10s).
Phase 2 remains 67/79; these are partial product-wide gate results. Other native
mutations and the broad UX checks remain open. No production deployment, release,
remote migration, real-org write or external mail. Twenty necessary tracked
Markdown files remain.


### Personal assignment response recovery, 2026-11-08

Branch: `fix/personal-assignment-response-recovery`, stacked on
`fix/native-show-edit-delete-recovery`. Real D1 tests reproduced two failures:
responding could return 409 after actually saving because the assignment revision
trigger increased D1's changed-row count, and a response could confirm Camera
duties after the operator reviewed Audio when those duties changed between read
and write. The original mocked response tests did not exercise that trigger.
A further real Schedule read exposed different response-version tokens for the
same timestamp stored as a number or ISO string.

Migration `0087_personal_assignment_response.sql` adds actor/workspace/request
receipts. The receipt and response now commit in one transaction, guarded by the
current membership/session/email and the exact assignment, show-time, duration,
crew-owner and settings snapshot. The closing deadline is checked at commit.
Exact retries recover their outcome; they cannot apply an older response over a
later edit or recreate a removed assignment. Review records a cancellation before
an undelivered response can apply. Scheduler notifications use a stable receipt
key and once-only inbox insertion. Notification push remains best effort and is
not represented as delivered by the response result. Response-version tokens now
normalize equivalent timestamp representations.

The existing mobile response route accepts the current client's complete request
identity and reviewed revision. Installed clients keep their original response
shape and receive the same atomic checks, but cannot recover an exact receipt
without a client request identity. The old internal response writer was removed.
This migration has only been applied in disposable tests, not production.

Native Schedule keeps decline notes and original response requests per account,
workspace and assignment for the signed-in app session. Accept remains a direct
action. Decline opens a retained note above the list. Pending or unknown responses
lock notes and opposite actions; Retry sends the same payload, while Review can
cancel a delayed response before editing. A confirmed response with failed refresh
offers Refresh response status without another mutation. Conflict recovery keeps
the note until explicit review of current duties. Notes require explicit discard,
and confirmations cancel on focus loss. Recovery remains accessible across date
navigation and after an assignment leaves the list. Response controls meet 44px;
commands/reviews are bounded at 15 seconds and refresh at 12 seconds.

Validation:
- Eighteen real-auth/D1 Worker tests pass: first response with revision triggers,
  exact retry, cancellation before delayed delivery, replay after later edits or
  removal, concurrent opposing responses, changed payload rejection, changed
  assignment/show/timezone/duration/crew ownership, revoked membership at commit,
  closed windows, actor/request identity, installed-client shape, one scheduler
  notification across replay/review, and the version returned by Schedule with
  actual stored show times. Seven mocked response cases were replaced with these
  database tests; the eight existing Schedule/bootstrap boundary cases remain.
- Seventeen native hook/form cases pass, covering retained notes, exact retry,
  opposite-action locks, 15s/12s deadlines, refresh-only recovery, cancellation
  before editing, explicit current-version adoption, reply identity checks,
  account/focus isolation, late completion, explicit discard and retention beyond
  the default query garbage-collection window. Eight version tests pass, including
  the new numeric/SQL-text/ISO equivalence regression.
- Full suite: 2,671 unit / 1,428 Worker tests. Web typecheck and production build
  pass. Main remains 549,525 raw / 173,749 gzip bytes within unchanged budgets.
- Native verification passes typecheck, lint with existing warnings, all three
  exports, Expo doctor 18/18, API contracts and polling. Hermes: iOS 5,613,923 /
  Android 5,613,023 bytes, below the unchanged 6,500,000-byte limit.
- Compiled Expo app with disposable real auth/D1 passes accepted-but-lost replies
  for both Accept and Decline, exact retries, retained decline note across dates,
  review cancellation and late-arrival rejection, a fresh reviewed response,
  failed-refresh recovery and explicit discard. Controls pass 44px, text-fit and
  reachability checks at 320/768/1440. Phone/tablet screenshots inspected; zero
  browser runtime errors. The compiled show edit/delete regression also passes.
  Expo web evidence does not establish physical iOS/Android UI behavior.

Evidence: `/tmp/showpilot-personal-response-{before,before2,worker1,worker2,
worker3,worker4,tsc1,tsc2,tsc3,tsc4,native-tsc1,hooks1,hooks2,full1,build1,
verify1,browser1,show-browser}.log`. Worker2 exposed a fixture field error;
worker3 reproduced the timestamp mismatch; worker4 and the final suite pass.
Screenshots: `/tmp/showpilot-personal-response-{accept,decline}-{320,768,1440}.png`.
After web build and mobile verify, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-personal-response.mjs`.

Preceding draft PR #256 is green (CI 42510725988, web 16m34s / Rust 4m44s).
Phase 2 remains 67/79. Follow-up inspection found the public crew invitation
response still rejects `meta.changes !== 1`; reproduce and repair that separate
portal path next. Native provider/roster/rundown editing and broad product gates
also remain open. No production deployment/release, remote migration, real-org
write or external mail. Twenty necessary tracked Markdown files remain.

### Phase 2 follow-up: public crew response recovery

The public invitation reproduced the same false failure as the native response:
D1 assignment-revision triggers make `meta.changes !== 1` reject a committed
response. Public and authenticated responses now use one transactional writer,
with separate authority adapters and receipt stores. Migration 0088 adds receipts
scoped to the access record and request ID, without storing the raw link token.
Exact retries recover the original outcome; review can cancel a request before a
late delivery applies. Revision, full assignment/show timing snapshot, response
window and current link authority are checked at commit. Invalid expiry strings
now fail closed. Calendar reads use the same authority check in a server-only
module, including a final check before returning data.

The invitation retains each assignment's note and immutable response separately.
Unknown outcomes offer Retry/Review; saved outcomes have separate refresh recovery.
Refresh reads data in place, preserving a confirmed result on read failure. Back,
assignment switching and reopening retain notes; replacing reviewed details or
discarding an unfinished draft requires explicit confirmation. Commands/reviews
are bounded at 15 seconds and refresh at 12 seconds.

Validation:
- Full web suite: 2,687 unit / 1,444 Worker tests. Web typecheck and production
  build pass. Main: 549,593 raw / 173,783 gzip bytes, within unchanged budgets.
- Twenty-one public-link Worker cases and eighteen personal-response cases pass,
  including commit races, expired/revoked/invalid links, cross-crew/org isolation,
  separate link receipts, cancellation, replay after edits/deletion, once-only
  scheduler notification and calendar authorization. Sixteen hook/component tests
  cover retention, exact retry, reply identity, deadlines, token isolation,
  confirmation scope, failed refresh and invalid input without losing the note.
- Compiled anonymous Chrome + disposable D1 passes lost-reply retry, note retention
  across assignments/Back, confirmed-result preservation during failed refresh,
  refresh without another write, review cancellation before delayed delivery and
  a fresh edited response. Recovery controls are reachable at 320/768/1440 with
  44px targets and no horizontal overflow. Phone/tablet screenshots inspected;
  zero runtime errors. Compiled native personal-response regression also passes.
  Existing Expo web export was reused; this is not physical-device verification.

Evidence: `/tmp/showpilot-crew-portal-{before,worker1,worker2,hooks1,hooks2,
full1,full2,tsc3,tsc4,build1,build2,browser1,browser2,native-browser}.log`.
The first build caught a server/client import boundary; the calendar extraction
fixes it. First typecheck caught an unsupported test option. The first browser
run caught a test proxy dropping serialization headers; browser2 passes with
original response headers preserved. Screenshots:
`/tmp/showpilot-crew-portal-{unknown,refresh,cancelled}-{320,768,1440}.png`.
After web build, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-crew-portal-response.mjs`.

Preceding draft #257 is green (CI 42512531198, web 16m40s / Rust 4m21s).
Phase 2 remains 67/79; these checks do not close the product-wide gates. Native
provider/roster/rundown editing and broader UX checks remain. No production
migration, deployment/release, real-org write or external email. Twenty necessary
tracked Markdown files remain.

### Phase 2 follow-up: native scheduling-source recovery

Compiled Expo reproduced closing/reopening Schedule settings resetting the
selected provider and removing entered fields. The old native API wrote three
settings directly, without the web editor's request identity or reviewed revision.

The native editor now retains its draft and original request by account and org,
with a Resume action on Schedule. It loads the current source before editing,
keeps controls frozen while an outcome is unknown, retries the same request,
and separates confirmed saves from refresh failures. Loading current settings or
discarding a draft requires confirmation. Reads, writes and refreshes have
8s/15s/12s deadlines; late reads and results cannot replace another account's
work. Platform fields use the existing theme, wrap on phones and have 44px or
larger controls. The old sheet, unbounded save helper and client wrapper were
removed.

Native GET/POST now call the existing canonical scheduling-source reader/writer,
including fresh authority, atomic revision checks and request receipts. Installed
clients retain their response shape and use guarded writes, but require an app
update for client-owned request IDs and reviewed revisions. Scheduling-source
changes no longer alter workspace language, including legacy requests. No new
migration is required.

Validation:
- Full web suite: 2,701 unit / 1,449 Worker tests; web typecheck/build pass. Main
  remains 549,593 raw / 173,783 gzip bytes within unchanged budgets.
- Thirty focused provider/workspace Worker cases pass, including six new native
  HTTP cases: exact replay, superseded saves, conflicts, changed request payload,
  actor/org/permission denial, invalid URLs and installed-client/workspace
  behavior. The prior mocked legacy-workspace case moved to real auth/D1.
- Fourteen actual native-hook cases pass: retained drafts, exact retry, independent
  deadlines, refresh-only recovery, conflicts, explicit adoption/discard, identity
  checks, late completion, account/focus isolation and selection of account IDs
  when component props contain extra fields.
- Native verify passes typecheck, lint with 17 existing warnings, iOS/Android/web
  exports, Expo doctor 18/18, contracts and polling. Hermes: iOS 5,631,064 /
  Android 5,630,144 bytes, below the unchanged 6,500,000-byte limit.
- Compiled native editor + disposable real auth/D1 passes initial-read retry,
  close/reopen retention, lost-reply exact retry, refresh without another write,
  concurrent-source conflict, explicit current-source adoption, failed reload
  preserving the draft and confirmed discard. Controls pass 44px/reachability
  and no page overflow at 320/768/1440; phone/tablet screenshots inspected; zero
  runtime errors. This run removes the browser-only AbortSignal convenience
  method to check the native abort path. The compiled personal-response regression
  also passes. Expo web is not physical-device proof.

Evidence: `/tmp/showpilot-native-provider-{before,before2,worker1,worker2,
hooks1,hooks2,props-before,full1,full2,web-tsc1,web-tsc2,tsc1,tsc2,build1,
verify1,verify2,verify3,browser1,browser2,personal-browser}.log`.
The first browser run of the replacement editor caught extra component props
being spread into a strict command; the added regression reproduces it, and the
hook now selects account identity explicitly. Browser2 passes. Screenshots:
`/tmp/showpilot-native-provider-{unknown,refresh,conflict}-{320,768,1440}.png`.
After web build/mobile verify, rerun
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-schedule-provider.mjs`.

Preceding draft #258 is green (CI 42514502837, web 16m27s / Rust 3m8s).
Phase 2 stays 67/79. The native roster still removes settled mutation records and
allows an uncertain request to be discarded after a read without fencing a late
write; reproduce that next. Rundown metadata and product-wide gates remain.
The Founding Member closing date/timezone is still awaiting the owner's answer.
No production deployment/release, remote migration, real-org write or external
mail. Twenty necessary tracked Markdown files remain.

### Phase 2 follow-up: native crew roster draft and request recovery

The previous note overstated mutation-cache removal. The original native mutation
tests pass: the initial failed request remains in TanStack's mutation cache.
The reproduced bug is the old `Review stored crew` path: it reads the roster and
then drops the uncertain request, although a delayed write can still arrive.
A real D1 regression reads an empty roster, delivers the original create later,
and observes a new crew row. Reading alone cannot settle that request.

The native crew editor now retains create/edit/delete drafts and frozen requests
by actor, organization and crew slot. Closing or navigating away keeps work while
the signed-in app session remains alive. Edit and delete share the same profile
slot, so opening a different action cannot replace an unresolved request. Resume
controls remain visible when the roster read fails or a deleted row disappears.
Review records either the existing result or cancellation under the original
request ID before a late write can apply. A cancelled request requires explicit
editing before a fresh ID is created. Confirmed saves have a separate refresh-only
path. Loading current details explicitly replaces the draft and adopts its latest
profile revision; failed reads leave it intact. Delete, draft discard and draft
replacement require inline confirmation.

Migration `0089_crew_request_review.sql` adds applied/cancelled outcomes to the
existing atomic crew receipt. Existing receipts default to applied. Install it
before deploying code that reads those outcomes. It has only been applied to
local fixtures. Web and installed-client writers retain their response contract
and honor a cancelled request. Native command/review/profile routes validate
actor and org identity, preserve photo validation, and check current session,
permission and organization-deleting state at commit and receipt-read boundaries.

Verification on `fix/native-crew-roster-recovery`:

- Full web suite: 2,728 unit and 1,467 Worker tests pass. Web typecheck passes.
- Web production build passes, main 549,593 raw / 173,783 gzip bytes; the gzip
  budget remains 175,000.
- Thirty-two actual native-hook/photo cases cover retained drafts, exact retries,
  cancellation, fresh IDs, refresh-only recovery, offline errors, 15s command/review,
  12s refresh, 8s current-read and 10s photo deadlines, late replies, identity and
  profile mismatch, account/focus isolation, explicit adoption and shared slots.
- Thirty-two real auth/D1 cases include installed-client compatibility, concurrent
  send/review, cancellation before create/update/delete, stale revisions, receipt
  replay, badge reuse and actor/session/org-deleting races at review commit/reply.
- Native verify passes typecheck, lint with 17 existing warnings, all three
  exports, Expo doctor 18/18, contracts and polling. Hermes iOS 5,645,103 /
  Android 5,644,231 bytes, below the unchanged 6,500,000-byte budget.

- Compiled Expo web against disposable real auth/D1 passes failed-roster retry,
  navigation away/back with a retained draft, lost create/delete acknowledgements
  and exact retries, refresh-only recovery, cancellation before a held request is
  delivered, stale-profile conflict, explicit current-profile adoption, failed
  adoption preserving the draft, and confirmed delete/discard. Roster actions
  with long names/badges and recovery/delete controls remain reachable at
  320/768/1440 with 44px targets and no page overflow. Phone roster and tablet
  confirmation screenshots inspected; zero runtime errors. Expo web is not
  physical-device evidence. Re-run after web build/mobile verify with
  `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-crew-roster.mjs`.

Evidence: `/tmp/showpilot-native-crew-{before,read-before,worker1,worker2,worker3,
hooks1,full1,web-tsc1,web-tsc2,tsc1,build1,build2,verify1,verify2,verify3,
browser1,browser2}.log`. The first two Worker failures were fixture reads of a
revision absent from Prisma's DTO; those fixtures now use the roster DTO. Initial
build verifiers still expected the replaced mutation/editor paths; they now check
the shared authority helper and retained hook. The first browser run passed
create retry/cancellation and caught a missing org query parameter in its simulated
second-operator request. The app transport already includes that parameter.

Preceding draft #259 is green (CI 42520870786, web 16m53s / Rust 2m39s).
Phase 2 remains 67/79; these checks do not close the product-wide UX gate.
The next native gap is Rundown's metadata editor: its local request ID and fields
reset on close, it permits changed fields under the same request ID after an
uncertain reply, and its save reads the current relay revision rather than the
revision reviewed in the draft. Preserve the separate rundown:edit/PIN authority
when reproducing and fixing that path. The Founding Member closing date/timezone
still awaits the owner's answer. No production deployment, release, remote
migration, real-org write or external mail. Twenty necessary Markdown files remain.

### Phase 2 follow-up: native Rundown details recovery

Two tests of the original native sheet reproduced lost drafts after close/remount
and fields remaining editable after an uncertain save. Its parent also supplied
the latest relay revision on each save rather than the revision the operator
reviewed, and the sheet reused one request ID for later edited contents. A failed
background show read removed the entire Rundown screen and any open editor.
The main show read also had no deadline.

The replacement retains actor/org/show drafts and frozen save commands in the
query cache while the signed-in session remains alive. An authoritative read
captures the metadata version, relay revision, service date and timezone together.
Retry sends exactly that command. Review recovers its receipt or cancels it before
late delivery. Current details replace a draft only after explicit confirmation;
failed reads preserve the draft. Conflicts require loading the current revision,
and cancelled commands require explicit editing before creating another request
ID. Confirmed outcomes have a separate refresh-only action. The main show read is
bounded at ten seconds, attempts while offline rather than pausing indefinitely,
and shows Retry. A failed background refresh keeps the loaded screen/editor with
an error. Show cache keys include the actor; PIN unlock writes that exact key.

The new native entry point uses the existing serialized relay writer, atomic
`show_details_request` receipts and durable D1-to-relay recovery intent. It
preserves `rundown:edit` and technical-manager PIN access through a separate
internal authorization entry point. Session, role, operational grants, the PIN
setting and organization deletion are checked at commit. The reviewed relay
revision must still match for a fresh save; exact replay does not apply an older
payload again. Schedule callers retain `schedule:manage` and their existing
fingerprint/receipt format. No migration is added. The obsolete native metadata
client wrapper is removed; the existing server endpoint remains available to
installed clients.

Final verification: both full-suite runs pass 2,753 unit and 1,481 Worker tests, including 22 actual
native-hook cases, three actual-sheet cases and fourteen new real auth/D1/relay
cases. The existing 23 shared show-details Worker cases also pass. Tests cover
exact retries, cancellation, revision conflicts, superseded results, account/show
isolation, late completions, grant revocation, PIN rotation/configuration at
commit, actor mismatch and relay eviction. The first PIN case exceeded Vitest's
5s default because it performs several full-strength derivations; its bound is
30s, matching the existing PIN authority tests. No cryptographic work factor was
changed. Web typecheck and build pass; main remains 549,593 raw / 173,783 gzip
bytes, under the unchanged 175,000-byte budget.

Native verify passes typecheck, lint with 17 existing warnings, all three exports,
Expo doctor 18/18, contracts and polling. Hermes iOS 5,662,254 / Android 5,661,339
bytes, under the unchanged 6,500,000-byte limit. Current-details reads have an 8s
deadline, save/review 15s and refresh 12s. Header action targets are 44px and wrap
on narrow screens. Authentication redirects precede a disabled query's pending
state, so signed-out navigation cannot be trapped by that query.

Evidence: `/tmp/showpilot-native-rundown-{details-before,form1,hooks1,worker1,
worker2,web-tsc1,web-tsc2,web-tsc3,web-tsc4,web-tsc5,tsc1,tsc2,full1,full2,
build1,verify1,verify2,verify3,browser1,browser2}.log`. The first compiled-browser
attempt reached the real relay and recovered the initial details read, then
stopped because its selector expected the raw label instead of the workspace's
rendered “Service title.” The selector is corrected in the rerun.

The second compiled Expo web rehearsal passes against isolated real auth, D1
and the Rundown relay. It verifies a stalled initial show read reaches Retry,
details-read recovery, draft retention through navigation, exact retry after a
lost response, refresh failure preserving the editor, cancellation before late
delivery, a second operator causing a revision conflict, explicit adoption of
current details, failed adoption preserving the draft, and confirmed discard.
Widths 320, 768 and 1440 have no horizontal overflow, with 44px header/recovery
actions and zero runtime errors. Inspected the 320px header and refresh-failure
screenshots and the 768px conflict screenshot. Artifacts are
`/tmp/showpilot-native-rundown-{header,unknown,refresh,conflict}-{320,768,1440}.png`.
Expo web does not establish physical-device behavior. Re-run after web build and
mobile verify with
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-rundown-details.mjs`.

PR #261 CI 42524889710 passed Rust but failed two native-details authority
matrix cases at Vitest's 5s default. Both verify the full 210,000-iteration PIN;
the neighboring passing cases took 4.843s and 4.932s, and the failed cases took
5.248s and 5.139s. There is no event waiter in these tests. The matrix now uses
the same explicit 30s budget as the other PIN authority case. Application
request deadlines and cryptographic work factors are unchanged. All fourteen
native-details Worker cases pass with Istanbul coverage, and web typecheck
passes. Evidence: `/tmp/showpilot-pr261-{ci-failed,pin-coverage,pin-tsc}.log`.
Full CI must pass on the updated head before opening the next PR.

Preceding draft #260 is green (CI 42522683978, web 13m57s / Rust 4m30s).
Phase 2 remains 67/79. Broader UX and physical-device gates remain open, and the
Founding Member closing date/timezone still awaits the owner's answer. No
production deployment, release, remote migration, real-org write or external
mail. Twenty necessary tracked Markdown files remain.

### Phase 2 follow-up: shared template save and deletion receipts

The installed native template-save endpoint bypassed the web writer. It returned
success for any existing template ID without checking contents, and its upsert
could recreate a deleted template or overwrite a concurrent save. Three real
mobile API/D1 regressions reproduced changed-content acknowledgement, deleted
copy resurrection, and missing shared receipts. The first deletion fixture used
the wrong HTTP route; after correcting it to POST /remove, the actual late-save
regression failed with 201 instead of 409.

Native saves now call the same immutable create writer as web saves. Exact
replay preserves timestamps and content. A changed name or changed source
snapshot under the same request ID receives an explicit conflict. Successful
installed-client response fields remain available. Existing legacy IDs are not
silently adopted as proof of a matching request.

Two additional real API regressions showed that legacy templates without receipts
could still be recreated after either web or native deletion. Both deletion
entry points now use one transaction to record removal when no receipt exists
and delete the template. Existing save receipts are retained. A delete arriving
before its save also fences that ID; other organizations remain independent.
The same app_setting storage is used, so no migration is needed. Existing
rundown-edit/PIN authorization remains at each entry point; this change does not
claim new commit-time authority checks.

Twenty focused real auth/D1 tests pass: eleven native endpoint cases and nine
shared create/delete cases, including exact retry, changed source, concurrent
writers, native/web interoperability, legacy deletion through both clients,
receipt/delete rollback, deletion before delivery, org isolation, and unknown-role
rejection. The role-change fixture initially expected 403, but its unsupported
viewer role fails identity normalization and returns 401. This case does not
establish session revocation.

The compiled Worker rehearsal passes against disposable local auth and D1:
immutable replay, changed contents rejected, deletion retained after late retry,
delete before delivery, and exactly one winner from twelve competing names.
Run `SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-template-save.mjs`
after the web build. This is API/storage evidence, not a native UI rehearsal.
Web typecheck and build pass; main remains 549,593 raw / 173,783 gzip bytes under
the unchanged 175,000-byte gzip limit.

Evidence: `/tmp/showpilot-native-template-save-{before,before2,worker1,worker2,
worker3,unit1,tsc1,tsc2,tsc3,full1,full2,build1,build2,smoke1}.log` and
`/tmp/showpilot-native-template-legacy-before.log`. Final full suite passes 2,753 unit and 1,495 Worker tests, 4,248 total.
The preceding draft #261 has a green Rust job; its main CI job is still running
in CI 42524889710. No new PR is opened until that gate is green.

The template form's retained draft, frozen source snapshot, authoritative review,
and load/delete recovery UI remain unfinished. This shared storage fix is a
prerequisite, not completion of the template workflow or product-wide UX gate.
Phase 2 remains 67/79. No deployment, release, remote migration, real-org write
or external mail. Twenty necessary Markdown files remain.

### Phase 2 follow-up: native template draft and save recovery

Three tests of the original native template sheet reproduced loss of the draft
name after close, editable fields after an uncertain save, and a new request ID
after reopening. The former endpoint also read the live source again on every
retry, so it could not recover the exact copy the operator had reviewed.

The native form now retains an actor/org/show draft and a complete reviewed copy
of the title, start time and items. Later live changes do not change that copy.
Save freezes a strict command; Retry sends it unchanged, and Review either
recovers its result or cancels it before late delivery. Editing after cancellation
is explicit and starts a fresh ID. Source replacement and unsent draft discard
require confirmation. A confirmed save has separate list-refresh recovery.
The original draft remains reachable from the show after navigation.

Migration 0090 adds org-cascaded template_save_request receipts. The native
command/review entry points verify actor and show identity and preserve rundown
editing/PIN access. Session, role, grants, PIN configuration and organization
deletion participate in the commit guard. The receipt, immutable copy and
installed-client fence commit atomically. Review never binds the template copy
for insertion, so it can cancel a copy too large for a database value. Existing
web and installed-client creation/deletion use the same digest/fence protocol.
No remote migration was run.

Invalid reviewed copies show a recoverable error instead of throwing or silently
refusing Save. Item bounds match the relay; duplicate IDs are rejected. The
3,250,000-byte mobile request limit is checked with UTF-8 accounting before a
command is frozen, preserving oversized drafts for correction. Save/review are
bounded at 15s, list refresh at 12s, and the list read at 10s. Template list errors
have Retry and do not render the empty-state message. Query keys include the
actor, and a disabled permission-gated query no longer leaves a resume view
showing a permanent spinner.

The compiled Expo web rehearsal uses real isolated auth, D1 and WebSockets. It
passes a stalled initial list read, navigation retention, an actual rundown item
changing at another operator while the reviewed copy stays frozen, a lost reply
and exact retry, failed refresh and refresh-only recovery, cancellation before
late delivery, a saved copy removed before review, explicit copy adoption and
discard, and 320/768/1440px controls with no horizontal overflow or runtime errors.
Inspected the 320px unknown/refresh states and the 768px cancellation state.
Re-run after web build and native verify with
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-template-recovery.mjs`.
Screenshots: `/tmp/showpilot-native-template-{unknown,refresh,cancelled}-{320,768,1440}.png`.
Expo web is not physical-device evidence.

Verification history: the initial native typecheck exposed the distinction
between incoming item timestamps and the normalized saved copy; the input and
output types are now separate. A test-fixture PIN parameter initially lacked its
header forwarding and failed web typecheck; that fixture now exercises the real
PIN path. Full-suite run 2 hit a 429 in the unrelated Stream fixture's login. Its
random address pool allowed collisions; a monotonic fixture-only address now
isolates every login, with all 21 Stream recovery cases passing. Production rate
limits are unchanged. A size-limit test caught the generic error message still
being used for an oversized copy; it now reports the size error explicitly.

Evidence: `/tmp/showpilot-native-template-form-{before,unit1}.log`,
`/tmp/showpilot-template-recovery-{worker1,worker2,worker3,unit2,unit3,unit4,
web-tsc1,web-tsc2,web-tsc3,web-tsc4,web-tsc5,native-tsc1,native-tsc2,
full1,full2,full3,full4,verify1,verify2,verify3,build1,build2,browser1,browser2,
stream-fixture}.log`. Final verification is recorded below.

Preceding #261 is green at b276c44b in CI 42525948014, web 11m35s / Rust 4m52s.
Draft #262 contains the shared storage prerequisite and is green at 5e6d488c
in CI 42527003570, web 14m20s / Rust 3m3s. Template load/previous-show
replacement and delete recovery controls still use the older flow and remain
next work; this does not close the product-wide gate. Phase 2 remains 67/79.
The Founding Member closing date/timezone still needs the owner's answer.
No production deployment, release, remote migration, real-org write or external
mail. Twenty necessary Markdown files remain.

Final local verification: 343 unit files / 2,777 tests and 136 Worker files /
1,512 tests pass (4,289 total). Web typecheck and production build pass; main
549,593 raw / 173,783 gzip bytes remains below the unchanged 175,000-byte budget.
Mobile verify passes typecheck, lint (17 existing warnings), iOS/Android/web
exports, Expo Doctor 18/18, API/store contracts and polling boundaries. Hermes
bundles are 5,680,695 bytes iOS and 5,679,746 bytes Android.

Final compiled-browser run 4 passes all recovery scenarios at 320/768/1440px
with zero runtime errors. The final web export includes two copy-only corrections
(singular item count and a conflict message without an internal request ID);
the six actual-form tests pass after those changes. Logs:
`/tmp/showpilot-template-recovery-{copy-unit,copy-export,browser3,browser4}.log`.

## Phase 2 follow-up: reviewed native rundown replacement

Branch: fix/native-rundown-replacement-recovery, based on #263 (633eae2e).
#263 is green in CI 42528526616: web 11m38s and Native Rust 3m37s.

The actual native template sheet reproduced two failures before the change:
its React Native Alert produced no visible confirmation in the web export, and
a second attempt after a lost response generated a different replacement ID.
The parent also supplied the latest relay revision on each attempt, while the
server reread the source. Together these could make a retry replace changes made
after the original operation. Baseline: /tmp/showpilot-template-load-before.log,
two failed assertions against the real sheet, with native rendering boundaries
stubbed.

Template and previous-show loading now capture a reviewed source and target
snapshot before confirmation. The form shows the destination, source, item count,
show title, start time (with the organization timezone), venue and timing reset.
The draft and immutable command survive navigation. Explicit source reread is
separate from exact retry and review/cancellation; a confirmed result has its own
refresh-only recovery. Selecting Load scrolls to the confirmation. A show must
be stopped and its reviewed metadata version and relay revision must still match.

Migration 0091 adds immutable rundown_replacement_request outcomes. The existing
serialized show relay owns replacement writes. One guarded D1 batch commits the
receipt, rows, stopped timer, metadata and row-storage marker. A small DO intent
recovers the current committed D1 state after a crash between D1 and DO storage;
it never replays the old source payload. Item rows are separately bound rather
than packed into one large database value. Existing metadata, PIN and permission
guards are reused, and unrelated lyrics, stage messages and output settings are
preserved. Old installed-client endpoints remain; the current native callers
use the new reviewed replacement contract.

Focused verification includes late delivery after cancellation, changed target
revision and metadata, atomic rollback, relay eviction recovery, changed body
under an old ID, concurrent save/review, removal, current PIN rotation at commit,
cross-org source isolation and a 500-item replacement with 4,000-character notes.
Native hook/form checks cover source and actor reply identity, read/save/refresh
deadlines, late responses after navigation, locked uncertain requests, explicit
reread after cancellation and refresh-only retry. The first Worker attempt used
the generic internal-request helper on an unsupported dedicated route; the
fixture now uses the real dedicated secret-header contract. A read-contract test
also exposed the native live-item revision field being required for an immutable
copy; copy item validation now shares the existing bounds without requiring that
unrelated live-item revision. The existing template-save validation is preserved.

Full verification and compiled browser evidence are recorded below once terminal.
Template deletion recovery is still outstanding; this narrow change does not
close the product-wide UX gate or reduce the Phase 2 count from 67/79. The owner
still needs to supply the Founding Member offer closing date/timezone. No remote
migration, deployment, release, external mail or real-org writes. Twenty necessary
Markdown files remain.

Compiled-browser run 1 found a real integration failure: templates saved by the
actual save API include createdAt/updatedAt. The new stored-template reader had
inherited the strict command schema and rejected those storage metadata keys.
The Worker fixture now includes the real persisted shape and reproduced the 503
before the fix. Stored-template parsing now strips unrelated storage metadata;
replacement commands remain strict. Browser run 2 then passed stalled reads,
navigation retention, lost replies, exact retry preserving a newer operator edit,
refresh-only recovery, cancellation before late delivery, and conflict requiring
explicit rereview at 320/768/1440px, with no runtime errors. Inspected the narrow
review/uncertain states and tablet cancellation state. Final read responses also
carry private/no-store headers, and retained-replacement row buttons visibly dim.

A final numeric timestamp regression reproduced a second 503: the shared snapshot
reader accepts numeric millisecond updatedAt values, but the new writer initially
advanced them with julianday(updatedAt), which only handled the text case. Its
SQL now explicitly converts numeric milliseconds with unixepoch before advancing
the version, matching the existing show-inventory writer's handling. The older
show-details and ordinary relay timestamp-update expressions still need a
separate follow-up audit; this change does not claim those are repaired.

Intermediate full suites pass 2,791 unit / 1,529 Worker tests. The added numeric
metadata-version regression brings the final Worker expectation to 1,530; final
results are recorded only after the running checks finish. Mobile verify 2 is
green: typecheck, lint (17 existing warnings), all three exports, Expo Doctor 18/18,
contracts and polling boundaries. iOS Hermes is 5,698,195 bytes, Android 5,697,287.
Web main remains 549,593 raw / 173,783 gzip bytes against the unchanged budgets.
Expo web evidence is not a physical-device run.

Evidence prefix: /tmp/showpilot-template-load-, including before, form1, unit1,
unit2, worker1–6, stored-metadata-before, timestamp-before, full1–4, web-tsc1–7,
native-tsc1–2, build1–4, verify1–2 and browser1–2 logs. Rehearsal command after
web build/mobile export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-rundown-replacement.mjs`.
Screenshots: /tmp/showpilot-native-replacement-{reviewed,unknown,refresh,cancelled}-{320,768,1440}.png.

Final verification: full run 4 passes 345 unit files / 2,791 tests and 137 Worker
files / 1,530 tests (4,321 total), including the numeric timestamp regression.
Web typecheck 7 and production build 4 pass. Compiled-browser run 3 passes all
scenarios above against the final server build and mobile export, including the
private/no-store header assertion and dimmed retained-action buttons. There are
zero runtime errors. The final screenshots use the paths above; browser log is
/tmp/showpilot-template-load-browser3.log. No broader gate is claimed complete.

### Phase 2 follow-up: replacement request boundaries and coverage

PR #264's first CI run, 42530711027, passed all 2,791 unit and 1,530 Worker
tests but failed the unchanged relay function coverage floor: 329/366 functions,
89.89%, below 90%. The missing new function was the invalid-JSON handler on the
replacement endpoint. Seven boundary cases now verify malformed JSON/schema
bodies, a missing internal credential, and commands for another organization or
show. Rejected calls leave rundown metadata, items, revision, timer state and
replacement receipts unchanged. The response clock is asserted as a number rather
than compared with an earlier sample. No app behavior or coverage floor changed.

The full coverage run passes 2,791 unit / 1,537 Worker tests, 4,328 total. Relay
function coverage is now 330/366, 90.16%. All measured coverage groups pass:
timecode statements/branches/functions/lines 92.44/90.57/91.56/95.09;
relays 86.47/84.19/90.16/92; devices 64.55/49.88/62.9/67.19. Web typecheck passes.
Evidence: /tmp/showpilot-pr264-{ci-failure,boundaries1,coverage2,tsc2}.log and the
CI coverage artifact from that run. The initial boundary test assertions compared
the sampled timer serverTime; the final assertions exclude only that clock from
exact equality. That was a fixture assertion error, not a product regression.

A separate full run on the timestamp follow-up exposed a fixture login returning
429 before a moderation test ran. Eight random-address login fixtures now use a
shared sequential address allocator; the previously corrected Stream fixture uses
it too. Real auth and production rate limits remain enabled and unchanged.

Timestamp attribution correction: the installed Prisma adapter writes ISO-offset
text, confirmed by a real Prisma create/read. The numeric millisecond regression
explicitly seeds that supported representation in D1. It does not demonstrate
that the current Prisma adapter writes numeric values. Earlier test and evidence
wording has been corrected. No deployment or broad Phase 2 gate closure.

### Phase 2 follow-up: rundown timestamp versions

Seven regressions reproduced failed numeric-timestamp writes and false metadata
conflicts. The installed Prisma adapter writes ISO text with a `+00:00` suffix;
its value and the equivalent ISO `Z` value must match. Numeric milliseconds are
an explicitly seeded supported storage representation, not evidence that the
current Prisma adapter writes numbers. The earlier replacement evidence and test
title have been corrected accordingly.

The shared SQL expression handles numeric milliseconds and date text and advances
future versions by one millisecond per write. Schedule/rundown details, ordinary
relay item/timer and metadata writes, replacement, and inventory use it. Metadata
commands compare instants, then bind the exact stored value in the final atomic
WHERE guard. A concurrent Prisma edit still produces a conflict. Numeric wire
versions remain rejected. SQLite CURRENT_TIMESTAMP text is interpreted as UTC.

Focused verification passes 115 Worker tests, including 14 new timestamp cases.
Full run 1 reached 2,791 unit passes and 1,543 Worker passes, but one moderation
fixture login returned 429 before exercising the feature. Random IP selection
could collide across logins. Eight remaining randomized login fixtures now use a
shared sequential test-address allocator; the previously fixed stream fixture
uses the same helper. Production throttling is unchanged. Full run 2 passes
2,791 unit / 1,544 Worker tests, 4,335 total. Web typecheck 3 passes.

Production build 1 passes with the unchanged main bundle, 549,593 raw / 173,783
gzip bytes. The compiled Worker rehearsal uses isolated real auth, D1 and relay
for numeric, Prisma-style ISO-offset and SQLite UTC rows. It passes detail saves,
exact replay, stale-version rejection, metadata edits and timer start/stop version
advancement. Command after web build:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-rundown-timestamp-versions.mjs`.
Evidence: /tmp/showpilot-timestamp-{worker2,full1,full2,tsc3,build1,smoke1}.log.
No production deployment or migration. Phase 2 remains 67/79; this is a narrow
save-reliability correction, not completion of a product-wide gate.

Timestamp follow-up after merging the replacement CI correction: full coverage
run 3 passes 2,791 unit / 1,551 Worker tests, 4,342 total, and typecheck 4 passes.
Relay coverage is statements 86.48%, branches 84.22%, functions 90.16%, lines
92.01%; all three coverage groups pass unchanged thresholds. No app source
changed during this merge, so the compiled timestamp rehearsal and build above
still cover the final implementation. Evidence:
/tmp/showpilot-timestamp-coverage3.log and /tmp/showpilot-timestamp-tsc4.log.
PR #264's new CI run is 42532247791 at 00dcd104. The timestamp PR remains held
until that run is green.


### Phase 2 CI follow-up: isolate native PIN authority cases

PR #265 run 42533504976 passed 2,791 unit tests and 1,550 Worker tests, but
`native-rundown-details.worker.test.ts` timed out after 30 seconds in the test
combining missing PIN, wrong PIN, valid read, valid save, and schedule denial.
Native Rust passed in 4m36s. No next PR was opened after that failure.

Split the independent authority paths into four integration cases. Each still
uses real authentication and the production 210,000-iteration PIN verifier;
valid read and save still traverse their actual HTTP/relay/database checks.
The existing 30-second PIN-case deadlines remain unchanged. Rejected writes
also assert that neither show metadata nor a receipt was written. This changes
test organization only, not production authority or cryptographic work factors.

Validation on the isolated #265 branch: full coverage run passes 2,791 unit
and 1,554 Worker tests (4,345 total); web typecheck passes. All unchanged
coverage floors pass: relays 86.51% statements / 84.25% branches / 90.16%
functions / 92.01% lines. Evidence: /tmp/showpilot-pr265-coverage1.log and
/tmp/showpilot-pr265-tsc1.log. The next PR remains held for GitHub's rerun.

### Phase 2 follow-up: retained native template deletion

The actual native sheet regression reproduced a missing confirmation in the web
export: Delete only called Alert, which rendered no actionable confirmation there.
Deletion also used an unbounded callback and a refetch that could return an error
without throwing. Closing lost the pending action and a failed refresh could hide
whether deletion had already succeeded.

The sheet now shows a visible danger confirmation naming the selected template
and item count, with Keep template before submission. Confirmed requests retain
the original template/account/org/show identity across panel and route navigation.
The show screen exposes Resume template deletion. A lost reply or the 15-second
request deadline leaves a visible uncertain result and exact-target retry. Once
acknowledged, only the list refresh is retried, with its own 12-second deadline.
The retained request prevents loading/deleting the same stale list entry again.
Template metadata labels now have a 12px floor. The old page callback and Alert
path were removed.

Deletion reuses immutable template IDs and the existing deletion fence; it does
not need a new migration or cancellation receipt. Cancellation is offered before
submission, not claimed after an uncertain reply. Retrying cannot resurrect the
template or delete a different copy. Current client replies carry the original
request identity; installed clients' empty request bodies remain supported.
Both web and mobile callers now supply current actor/session/PIN authority to
the shared atomic delete. Membership, grants, session expiry, organization
deletion and PIN changes are guarded in the database transaction.

Verification: the baseline actual-sheet test fails on the old confirmation.
Seven sheet tests and five hook tests pass, including retained exact retry,
request/refresh deadlines, account changes, duplicate clicks and mismatched
replies. Worker coverage adds seven cases for retained API identity and authority
changes at commit; existing receipt, rollback, cross-org and concurrent save/
delete cases still pass. Full suite passes 346 unit files / 2,800 tests and 139
Worker files / 1,558 tests, 4,358 total. Web typecheck 2 and build 1 pass. Main
bundle remains 549,593 raw / 173,783 gzip bytes against unchanged budgets.

Mobile verify 1 passes typecheck, lint with 17 existing warnings, iOS/Android/web
exports, Expo Doctor 18/18, API/release contracts and polling boundaries. Hermes
is 5,709,166 bytes on iOS and 5,708,250 on Android. The compiled Expo web rehearsal
uses real isolated authentication, D1 and relay traffic. At 320/768/1440px it
passes visible confirmation, keeping without deleting, a committed deletion with
held reply, the request deadline, navigation retention, exact retry, refresh-only
recovery, preserving another template and preserving the show. Zero runtime
errors. Inspected the 320px confirmation and uncertain-result screenshots.
This is not a physical-device run.

Rehearsal after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-template-delete.mjs`.
Evidence: /tmp/showpilot-template-delete-{before,form1,hook1,worker1,worker2,full1,tsc2,build1,verify1,browser1}.log.
Screenshots: /tmp/showpilot-native-template-delete-{confirm,unknown,refresh,confirmed}-{320,768,1440}.png.
No deployment, remote migration or product-wide gate closure. Phase 2 remains
67/79. The timestamp PR is still held until #264's CI rerun passes; this deletion
follow-up stays behind that change in the stack.

Stack gate update: #264 is green at 00dcd104 in run 42532247791: web CI 14m42s,
Native Rust tests 4m25s. Draft timestamp PR #265 is now open at db426401, with
run 42533504976 queued. The template deletion implementation is pushed at
d3bb2fc7; its PR remains held until #265's current-head checks pass.

### Phase 2 follow-up: native rundown removal, clear and undo

The native item sheet regression reproduced the missing visible confirmation:
Delete immediately called its parent, which depended on Alert. The parent also
sent timer-stop separately from remove-item. That could stop a different item
if another operator advanced the show. Clear rundown had the same Alert-only
confirmation and no retained acknowledgement.

The item sheet now captures the current item and relay revision for review,
names the item, explains whether removal stops its timer, and offers Keep item.
A revision change requires explicit review again. Missing items or lost editing
access block submission. Clear rundown names the show and item count, explains
that it stops the timer and has no undo, and requires re-review after a change.
The header actions wrap on narrow screens and their targets are at least 44px.

The native change endpoint authenticates the current account, org and show,
then dispatches the original request ID and frozen revision to RundownRelay's
existing normal /command path. The relay rechecks live session, membership,
grants and PIN authority. Removal, timer effects, clear and undo remain on the
existing single writer; no internal-secret bypass or new migration was added.
The separate timer-stop was removed. Exact retries use the original revision;
even after the bounded command-ID history expires, an old request cannot change
a newer rundown. An accepted retry says Action accepted rather than claiming
that the current state still matches an old action.

A retained request survives screen navigation within the app session. Mutation
confirmation has a 15-second deadline; refresh has a separate 12-second deadline
and a rundown-specific error. Uncertain requests offer exact retry. Confirmed
actions retry only refresh. Other destructive actions wait until the result is
resolved. Accepted removal offers Undo within 30 seconds of the original
submission, using the relay's existing undo record and current reviewed revision.
Undo restores an item without restarting its timer; the relay enforces expiry.

Focused verification: seven actual-sheet tests, seven native hook tests, and ten
real-relay Worker tests pass. These cover keeping without sending, changed
revision re-review, removed items, lost editing access, current-item atomic stop,
advance/removal races, restore without restart, expiry after eviction, exact
replay after another operator restores, a retry older than the command history,
clear-all, revoked sessions/membership, PIN verification and identity scoping.

Full run 4 passed all 2,814 unit tests but had six Worker timeouts while coverage
and exports competed for the machine, including #265's original PIN case. After
merging the independently verified PIN repair, full run 5 ran without competing
builds and passed 348 unit files / 2,814 tests plus 140 Worker files / 1,571 tests,
4,385 total. Web build 4 passed with the unchanged 549,593 raw / 173,783 gzip main
bundle. Final web typecheck 5 passes. Native verify 6 passes typecheck, lint
with 17 existing warnings, iOS/Android/web exports, Expo Doctor 18/18, release/API
contracts and polling boundaries. Hermes is 5,730,690 bytes on iOS / 5,729,761 on
Android. Screenshot review caught disabled move buttons looking active during
confirmation; the final export includes their corrected disabled appearance.

Compiled-browser runs 1 and 2 pass with real isolated authentication, D1 and relay
traffic. Run 2 additionally rejects wrong-account, wrong-show and missing-revision
HTTP commands without changing the rundown. At 320/768/1440px both runs cover
visible confirmation, Keep without dispatch, active-item atomic removal, Undo
without restart, explicit re-review after a change, a committed action with held
reply, the 15-second deadline, screen navigation, exact retry after another
operator restores the item, refresh-only recovery, and confirmed clear-all.
No runtime errors. Inspected final 320px item confirmation and the clear/uncertain
screenshots. This is an Expo web rehearsal, not a physical-device run.

Rehearsal after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-rundown-change.mjs`.
Evidence: /tmp/showpilot-rundown-change-{before,unit3,worker2,worker3,full4,full5,tsc5,build4,verify6,browser1,browser2}.log.
Screenshots: /tmp/showpilot-native-rundown-change-{confirm,unknown,refresh,clear}-{320,768,1440}.png.
Phase 2 remains 67/79; these are focused controls, not a product-wide gate result.
No deployment, migration, release or new Markdown file. Twenty necessary tracked
Markdown files remain. #265's repaired head 9812e235 is running CI 42535312517;
Rust is green (4m45s), web is pending, and the next PR is held.


Stack gate update: repaired timestamp PR #265 is green at 9812e235 in run
42535312517 (web CI 15m43s, Native Rust 4m45s). Draft template-deletion PR #266
is open at 8e941d36, based on fix/rundown-timestamp-versions. The verified native
rundown removal/clear/undo implementation is pushed at 03ecdeaf; its PR waits
for #266's current-head CI. Phase 2 remains 67/79.

### Phase 2 follow-up: native transport expiry

Four actual native-hook regressions reproduced missing relay-clock expiry,
connected state remaining hydrated after disconnect, a rejection notice erased
by the next state snapshot, and a Next command replayed after reconnect beyond
its useful window. Native transport commands now capture the reviewed revision,
local submission time and a fixed five-second relay-clock deadline. New controls
are blocked while disconnected; an old transport command is dropped instead of
replayed after its window. The original deadline stays fixed if clock alignment
changes on reconnect. Existing relay expiry and deduplication enforcement is
unchanged. Non-transport edit handling has not been replaced by this change.

Command errors are separate from connection status and remain visible until
explicitly dismissed. Malformed acknowledgements do not confirm a request.
Unconfirmed counts appear in the show header; transport controls wait for
acknowledgement. Closing/error/timeout immediately marks state unhydrated, and a
socket that has opened but not hydrated is no longer labelled Live sync. A
mismatched-show snapshot cannot enable command dispatch.

Ten focused native-hook tests pass. Full suite passes 349 unit files / 2,824 tests
and 140 Worker files / 1,571 tests, 4,395 total. This includes the existing real
relay test that rejects expired HTTP/socket controls and acknowledges an already
applied retry. Web typecheck 2 passes. Native verify 2 passes typecheck, lint
with 17 existing warnings, all three exports, Expo Doctor 18/18, API/release
contracts and polling boundaries. Hermes is 5,734,506 bytes on iOS / 5,733,609 on
Android. No web production source changed in this follow-up.

Compiled-browser runs 1 and 2 pass against real isolated authentication, D1 and
relay traffic at 320/768/1440px. The rehearsal withholds Next before delivery,
checks that controls disable while unconfirmed, waits for expiry and reconnect,
proves the native client does not replay it, then delivers the original command
to the real HTTP relay and verifies an expired rejection without advancement.
A new snapshot preserves the notice; explicit dismissal clears it and a fresh
Next works. A Pause with a lost acknowledgement remains visibly uncertain even
though hydration correctly shows the paused state; it is not replayed.
Zero runtime errors. This is not a physical-device rehearsal.

The first 320px screenshot exposed cramped custom adjustment buttons and 40px
targets. Timer adjustment controls now wrap as pairs, the custom field wraps
above its buttons where necessary, and adjustment/mode targets are at least
44px. Run 2 also checks every adjustment button's bounds, text fit and target
height at all three widths. Inspected the final 320px screenshot.

Rehearsal after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-transport-safety.mjs`.
Evidence: /tmp/showpilot-native-transport-{before,unit1,unit2,unit3,full1,tsc2,verify2,browser1,browser2}.log.
Screenshots: /tmp/showpilot-native-transport-{expired,uncertain}-{320,768,1440}.png.
Phase 2 remains 67/79. The native Reset button still needs visible confirmation;
its stopped-show reset currently dispatches directly. Authentication/socket
handshake deadlines, stale read-only native status, and native editor draft/
acknowledgement handling remain separate open work. No product-wide gate closure,
deployment, migration or release. #266 CI 42536611342 is pending; Rust passed
4m43s. Later PRs remain held.


### Phase 2 follow-up: native timing reset confirmation

The compiled baseline reset a paused show immediately and failed the visible
confirmation assertion. Native Reset now opens a compact modal at the operator's
current position. It names the show, counts the items and explains that actual
start/end times and elapsed timing will be cleared, items will become upcoming,
and the items/show details will remain. Keep timing does nothing. Reset is
blocked while playing; a changed revision requires another explicit review.
The final screenshot review removed a stretching scroll container and fade so
the complete warning and both 44px buttons appear immediately at 320px.

Reset uses the retained rundown request lane, with a 15-second mutation deadline,
a 12-second refresh deadline, and the original request ID/revision across route
navigation and retry. The existing relay remains the revision-checked single
writer. An acknowledged retry checks the original outcome without resetting a
later run. Refresh recovery does not repeat the command. Confirmation copy
reports acceptance without claiming that later operator changes were undone.

The new /reset native endpoint requires rundown:control, preserving Production
Manager access. The /change endpoint still requires rundown:edit. Each endpoint
rejects actions belonging to the other, checks current membership, session,
identity and show scope, and uses the normal relay authority/PIN path. No internal
credential, schema migration or new reset semantics were introduced.

Full suite passes 349 unit files / 2,828 tests and 141 Worker files / 1,579 tests,
4,407 total. Four new sheet cases cover confirmation/Keep, revision review,
playing and lost access. Four new real-relay cases cover timing-only reset,
playing/stale rejection, deduplication after eviction with a later run, and
control-only Production Manager authority. Four real-auth route cases verify
Production Manager reset, edit-command rejection, scope validation and revoked
permission. The route fixture initially assumed revision zero; reading the real
initialized relay revision fixed that fixture assumption. Web typecheck 2 and
production build 1 pass. Main client remains 549,593 raw / 173,783 gzip bytes,
within the unchanged budgets.

Final native verify 3 passes typecheck, lint with 17 existing warnings, all three
exports, Expo Doctor 18/18, API/release contracts and polling boundaries. Hermes
is 5,740,624 bytes on iOS / 5,739,744 on Android. Focused sheet rerun 2 passes all
11 cases after the modal layout adjustment. Compiled Expo web rehearsals 1 and 2
pass with real disposable auth, D1 and relay traffic. Final run 2 covers Keep,
playing rejection, revision review, preserved item titles/notes/assignees, reset
timing, lost reply, navigation retention, exact retry after a later paused run,
and refresh-only recovery at 320/768/1440px, with zero runtime errors. Inspected
the final 320px confirmation and refresh screenshots. This is not a physical
phone or tablet run.

Rehearsal after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-rundown-reset.mjs`.
Evidence: /tmp/showpilot-native-reset-{before,unit1,unit2,worker1,worker2,full1,tsc2,build1,verify1,verify2,verify3,browser1,browser2}.log.
Screenshots: /tmp/showpilot-native-reset-{confirm,unknown,refresh}-{320,768,1440}.png.
Phase 2 remains 67/79. Authentication/socket handshake deadlines, stale read-only
native status and editor draft/acknowledgement recovery remain open. No deployment,
release or remote migration. Twenty necessary tracked Markdown files remain.

Stack gate: #266 at 8e941d36 is green in run 42536611342, web 17m36s and Rust
4m43s. Draft #267 is open at 03ecdeaf, based on fix/native-template-delete-recovery,
and run 42538227541 is pending. Later PRs remain held until that head is green.


### Phase 2 follow-up: native connection deadlines and last-known state

Seven native-hook regressions reproduced indefinite authentication, a socket
that never opens, an open socket that never hydrates, wrong-show and malformed
hydration, an error without a close event, and stale hydration on backgrounding.
A connection attempt now has a 12-second deadline through its first valid state.
Native cookie/PIN reads have a separate 10-second deadline and retain the normal
headers. Cancelled or late credential reads cannot create a socket. Every attempt
has a generation; late authentication and old socket callbacks cannot replace
its successor. Retirement detaches the socket before closing it, clears deadlines
and immediately disables live controls even if the platform never emits close.
Automatic backoff remains, with an explicit Retry live connection control.

Socket open alone no longer means connected. A valid same-show/date snapshot
completes the handshake. Malformed and wrong-room state reconnects without
replacing the previous valid snapshot. Existing transport expiry, reviewed
revision, command deduplication, unconfirmed counts and persistent notices stay
in place. Backgrounding invalidates hydration immediately; foregrounding starts
a fresh attempt. This change does not add a post-hydration heartbeat deadline.

Rundown, Live Show and Chat distinguish cached state from live state. Reconnecting
keeps the last relay snapshot instead of falling back to older HTTP data. The
rundown and Live Show clocks stop advancing while disconnected; their status is
LAST KNOWN rather than NOW LIVE/LIVE. Stage messages also lose their live label.
Chat separates its own connected room from an unavailable live-show status.
Connection errors and Retry appear together. Operational status labels are at
least 12px, and the Live Show connection row wraps the date below its status on
narrow screens.

The first compiled browser run also reproduced a cold /live-show navigation
redirecting to organization selection before the saved organization finished
loading. useMobileBootstrap now exposes that pending state and Live Show waits
for it before deciding to redirect. Initial workspace-access failures expose an
error and retry; cached workspace data is not discarded for a background error.

Twenty-one native relay-hook tests and seven native auth-transport tests pass.
The full suite passes 350 unit files / 2,846 tests and 141 Worker files / 1,579
tests, 4,425 total, including final semantic run 3. Web typecheck 2 passes. Final
native verify 3 passes typecheck, lint with 17 existing warnings, all three exports,
Expo Doctor 18/18, API/release contracts and polling boundaries. Hermes is
5,746,794 bytes on iOS / 5,745,953 on Android. Web production source did not
change; the Reset follow-up's compiled Worker is reused by the rehearsal.

Compiled Expo web run 1 passed the rundown deadline/retry path then exposed the
cold Live Show redirect. Runs 2 and 3 pass real disposable auth, D1 and relay
traffic at 320/768/1440px. Final run 3 withholds hydration, checks the deadline,
blocked controls, a frozen last-known clock and absence of NOW LIVE, then proves
explicit retry hydrates real state and a fresh Pause reaches the relay. Direct
Live Show and Chat navigation show honest cached state while their rundown
socket is silent, and restore live labels only after retry receives valid state.
Status labels meet 12px, Retry meets 44px, viewport bounds pass, and there are zero
runtime errors. Inspected final 320px Live Show/Chat screenshots and the rundown
failure screenshot. This is not a physical-device rehearsal.

Rehearsal after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-live-connection.mjs`.
Evidence: /tmp/showpilot-native-connection-{before,unit1,unit2,unit3,full1,full2,full3,tsc1,tsc2,mobile-tsc1,verify1,verify2,verify3,browser1,browser2,browser3}.log.
Screenshots: /tmp/showpilot-native-connection-{timeout,live-stale,chat-stale}-{320,768,1440}.png.
Phase 2 remains 67/79. Remaining connection work includes detecting a silent
socket after successful hydration: the existing relay ping does not return a
liveness reply. Native editor acknowledgement/draft recovery, ProPresenter
command recovery and the broader product checks remain open. No deployment,
release, migration or new Markdown file; twenty necessary tracked Markdown files
remain.

Stack gate: #267 at 03ecdeaf is green in run 42538227541, web 17m42s and Rust
4m39s. Draft transport-expiry PR #268 is open at 1f3139e4, based on
fix/native-rundown-command-recovery. Run 42539873974 is pending; Rust passed
4m55s. Reset is committed and pushed at 126e3e65. Its PR waits for #268's green
head; later PRs remain held. Prepared bodies are /tmp/showpilot-native-reset-pr.txt
and /tmp/showpilot-native-transport-pr.txt.


### Phase 2 follow-up: native rundown heartbeat

Six focused native regressions reproduced a socket staying hydrated after its
initial state when replies stopped, accepting no fresh proof of liveness, and
missing a newer revision. Four real-relay baseline cases also failed because
pings had no reply or did not enforce display expiry. The native rundown now
sends a unique bounded heartbeat ID every 20 seconds and waits at most eight
seconds for its matching reply. A missing reply retires the connection, marks
timing last known, disables controls and exposes Retry. A matching reply for the
wrong show/date or an invalid revision also retires the connection. A revision
newer than the last received snapshot reconnects for fresh state instead of
claiming synchronization. Old replies cannot satisfy a newer heartbeat, and
retiring/retrying/backgrounding clears the old deadline.

RundownRelay returns only type, the bounded heartbeat ID, show ID, date and
revision. It checks existing member read leases and display expiry first. No
operator payload, PIN, session data or full state is echoed. Legacy pings without
an ID remain one-way. Invalid IDs are ignored; heartbeats do not change rundown
revision. The same behavior survives Durable Object eviction. Read-only fixtures
prepare their room through a real authorized operator read before testing
heartbeats: observe access intentionally cannot initialize/relabel a room.

Twenty-nine native relay-hook tests pass, including eight new heartbeat cases.
Six real-relay heartbeat cases pass, covering control/observe/display replies,
eviction, invalid IDs, legacy pings, and expired member/display sessions. Full
suite passes 350 unit files / 2,854 tests and 142 Worker files / 1,585 tests,
4,439 total. Web typecheck 1, production build 1 and native verify 1 pass. Main
client remains 549,593 raw / 173,783 gzip bytes within unchanged budgets. Native
verification includes lint with 17 existing warnings, iOS/Android/web exports,
Expo Doctor 18/18, API/release contracts and polling boundaries. Hermes is
5,747,849 bytes on iOS / 5,746,985 on Android.

The compiled Expo web rehearsal passes real isolated authentication, D1 and relay
traffic at 320/768/1440px. It waits through two healthy idle heartbeat cycles on
one socket, verifies matching distinct IDs, drops all incoming traffic after an
external Pause, and verifies the deadline, disabled controls and frozen last-known
clock. Explicit Retry loads that Pause, and a fresh operator Resume succeeds.
Dropping only state broadcasts then advancing externally produces a missed-
revision warning from a real heartbeat; Retry loads the new current item. No
automatic transport command is sent during either recovery. The single Resume
is the only client mutation. Zero runtime errors. Inspected final 320px silent-
connection and missed-update screenshots. This is not a physical-device run.

Rehearsal after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-rundown-heartbeat.mjs`.
Evidence: /tmp/showpilot-native-heartbeat-{before,worker-before,unit1,worker1,worker2,full1,tsc1,build1,verify1,browser1}.log.
Screenshots: /tmp/showpilot-native-heartbeat-{silent,missed}-{320,768,1440}.png.
Deploy the matching relay backend before distributing a native build that expects
heartbeat replies. No deployment, release or migration was performed here.

Phase 2 remains 67/79. The rundown's post-hydration liveness gap is covered by
this change; native Chat and Timecode connection lifecycles still need their own
protocol/ownership audit. Read-only inspection found Timecode marks connected on
socket open and can reuse its generator on reconnect; prove its expected show
scope, ownership and failure behavior before changing it. Native item editor
acknowledgement/draft recovery and ProPresenter command recovery also remain
open. No broad gate closure or new Markdown file. Twenty necessary tracked
Markdown files remain.

Stack gate: #268 at 1f3139e4 is green in run 42539873974, web 15m20s and Rust
4m55s. Draft Reset PR #269 is open at 126e3e65, based on
fix/native-rundown-transport-safety. CI 42541348414 is pending. Connection recovery
is pushed at 9d41c2d8 and its PR waits for #269's green head. Later PRs remain held.

### Phase 2 follow-up: native Timecode authority and recovery

Twelve focused baseline regressions reproduced native Timecode following the
organization's active show, treating socket-open as connected, overwriting live
state with older HTTP data, declaring failed cues fired, ignoring ownership and
command rejections, waiting indefinitely for start acknowledgement, accepting
retired-socket updates and automatically restarting a clock on reconnect.

The native operator now explicitly selects a show. State/event reads, commands,
WebSockets and query caches carry its identity; caches also separate actors.
The same full show catalog serves web and native Timecode through a shared
server query. The new authenticated GET /api/mobile/v1/timecode/shows requires
timecode access, includes older and same-day shows, excludes deleting shows and
filters by organization. The first browser rehearsal exposed why bootstrap was
not a suitable catalog: it intentionally lists upcoming/active shows and uses
the organization's date. Four real-auth Worker cases cover the new catalog,
including session, permission and organization boundaries. The first test run
expected 403 for non-membership; the existing API deliberately returns 401 when
there is no identity in that organization. The test now asserts that exact
existing response, without changing authorization.

Native bootstrap, catalog and timecode HTTP requests have 10-second deadlines.
Timecode opts out of automatic bootstrap retries so the first failure exposes
Retry. A socket has 12 seconds to provide a valid same-show/date snapshot.
Claim, release, start and stop wait at most eight seconds for confirmation.
Connected requires hydration; explicit ownership is visible and HTTP edits are
blocked until this device owns control. A local generator needs both its grant
and the reviewed running position. Source math is unchanged. Disconnect, error,
backgrounding, unreadable/wrong-room data and missed sequence updates retire the
connection and stop its feed immediately. Recovery never replays commands or
restarts the clock. Every 20 seconds, the existing read-only sync protocol
refreshes the full snapshot; a missing reply after eight seconds retires an
otherwise open socket. Retry obtains fresh state. Command rejection/uncertainty
notices persist until dismissed. The existing relay sequence tracker moved to
shared code; web, display and native readers use the same implementation.

Native events preserve their server execution status/error and enabled/skipped
flags. Failed and dispatching updates no longer become Fired, and newer action
names do not discard the timeline. Late HTTP polls cannot replace socket state.
An added event's label is retained until its ID appears in the authoritative
event list. Clock metadata and action-choice labels are at least 12px; action choices
are at least 44px. The operator can change show only after the local source/pending action
has settled. Reset-all now requires explicit confirmation and is unavailable
while the clock is running.

Verification: 30 focused native hook/contract tests and four real-auth catalog
Worker tests pass. Full suite 2 passes 351 unit files / 2,884 tests and 143 Worker
files / 1,589 tests, 4,473 total. Web typecheck 2 and build 2 pass. Main client is
549,593 raw / 173,777 gzip bytes within unchanged budgets. Native verify 2 passes
all three exports, Expo Doctor 18/18, contracts and polling boundaries; Hermes
is 5,769,758 bytes on iOS / 5,768,838 on Android. Lint has 18 pre-existing warnings
and no errors. Earlier summaries said 17; the preceding heartbeat verification
log actually records the same 18 warnings.

Compiled Expo web rehearsals 2 and 3 pass against isolated real authentication, D1
and TimecodeRelay. It stalls bootstrap and catalog reads until visible timeout
and retries, withholds socket hydration, then tests a competing operator's
ownership, a real failed rundown cue, a disabled cue, explicit claim, native
clock feeding and Stop, an established silent connection, last-known timing,
manual retry without an automatic restart, and selecting a separate older
same-day show without leaking the first timeline. All HTTP/socket requests pin
a selected show. Controls stay within bounds and at least 44px at
320/768/1440px. Zero runtime errors. Inspected final narrow timeout, competing
operator and failed/disabled-cue layouts. Rehearsal 3 changes only the capture
position so the cue status/error rows are visible in the screenshots. This is an Expo web rehearsal, not a physical-device claim.

Rehearsal after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-authority.mjs`.
Evidence: /tmp/showpilot-native-timecode-{before,unit1,unit2,shows-before,worker1,worker2,full1,full2,mobile-tsc1,tsc1,tsc2,build1,build2,verify1,verify2,browser1,browser2,browser3}.log.
Screenshots: /tmp/showpilot-native-timecode-{timeout,failed,evening}-{320,768,1440}.png.
The matching backend catalog endpoint must be deployed before distributing this
native build. No deployment, release, migration, external mail or real-org write
was performed.

Phase 2 remains 67/79. Native Timecode still needs the broader editor and mutation
recovery pass, seek/reformat confirmations, accessible confirmation sheets,
automation kill/retry controls and typed action forms. Shared operations-row
status badges still use 11px and remain part of the broader typography pass. Native Chat's own socket
lifecycle, rundown item editing and ProPresenter command recovery remain open.
These checks do not close the product-wide gate or claim native Timecode parity.
No new Markdown file; twenty necessary tracked Markdown files remain.

Stack gate: Reset #269 at 126e3e65 passed run 42541348414. Connection recovery
#270 at 9d41c2d8 passed run 42542523164. Draft heartbeat #271 is open at ab5c6f09,
based on fix/native-live-connection-recovery; run 42543651519 is pending. Its
Rust job passed. Timecode's PR remains held until that head is green.


## Phase 2 follow-up: retain native Timecode cue saves (2026-11-08)

The compiled native baseline committed a cue, lost its reply and then created a
second cue when the operator retried Add. Seven initial Worker regressions also
failed: creation had no durable receipt, a retry after deletion recreated the
cue, and invalid time could silently return success.

Native Timecode now retains its draft and immutable creation request by account,
organization and show in the existing Query cache. A 15-second save deadline
exposes Retry original cue save; navigation retains both draft and request.
Fields remain locked until an authoritative result and timeline refresh arrive.
Retry sends the same identity and intent. A failed refresh has a separate retry
that never creates a cue. Removed, conflicted and rejected results retain the
draft for explicit review; New cue is explicit after a confirmed result.
Drafts survive screen navigation in the running app, not application termination.
A changed frame rate requires review. Native and web now share the existing
SMPTE label validator, including drop-frame exclusions; conversion math is
unchanged.

TimecodeRelay commits a cue and its creation receipt in one storage transaction.
Receipts survive eviction, later definition edits, format changes and cue removal.
Same-ID concurrent saves create once. A later retry cannot resurrect a removed
cue or apply an originally rejected request after its precondition changes back.
Current session, membership and control checks precede receipt lookup. The
receipt rejects different intent under an existing ID. A WebSocket rejection
precedes its canonical timeline echo so the web editor cannot interpret that
echo as a successful conflicting save. Existing payload-validation fixtures now
use distinct IDs for distinct invalid requests; their 400 assertions remain.

Explicit and periodic syncs carry a bounded optional identity. Native save
refreshes require their own matching snapshot; delayed older responses cannot
confirm or rewind them. Legacy syncs without an identity remain supported by
the backend. Deploy the matching backend before distributing this native build.

Verification: 46 native hook tests and 12 creation Worker tests pass as part of
full suite 2: 352 unit files / 2,900 tests and 144 Worker files / 1,601 tests,
4,501 total. Web typecheck 2 and production build 1 pass. Main client is
549,593 raw / 173,795 gzip bytes within unchanged limits. Native verify 1 passes
iOS, Android and web exports, Expo Doctor 18/18, contracts and polling boundaries.
Hermes bundles are 5,784,539 bytes on iOS and 5,783,660 on Android. Lint retains
18 existing warnings with no errors.

Compiled Expo web rehearsal 2 passes with real disposable authentication, D1 and
TimecodeRelay: lost replies, leaving/returning to the show, an isolated second
show draft, same-request retry, a missing refresh response followed by refresh
only, and removal before retry without recreation. No runtime/proxy errors.
The saved-state recovery layout has no horizontal overflow at 320/768/1440px;
New cue is at least 44px. Narrow and wide screenshots were inspected. Rehearsal 1
passed the behavior assertions but treated an intentional navigation cancellation
of the proxy socket handshake as an error. The proxy now ignores only that
specific intentional cancellation; all other errors still fail the rehearsal.
This is Expo web evidence, not a physical-device test.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-cue-recovery.mjs`.
Evidence: /tmp/showpilot-native-timecode-cue-{before,worker-before,worker1,worker2,unit1,mobile-tsc1,tsc1,tsc2,full1,full2,build1,verify1,browser1,browser2}.log.
Screenshots: /tmp/showpilot-native-timecode-cue-saved-{320,768,1440}.png.
Full suite 1 identified the missing conflict echo and fixtures that reused an ID
for different intents; full suite 2 verifies the correction without relaxing
assertions, deadlines, auth or bundle budgets.

Phase 2 remains 67/79. The broader Timecode editor, typed action fields,
seek/reformat confirmations, kill/retry controls and accessible confirmation
sheets remain open, along with native Chat, rundown editing and ProPresenter
recovery. No deployment, release, migration, external mail or real-org write.
No new Markdown file; twenty necessary tracked Markdown files remain.

Stack gate: heartbeat #271 at ab5c6f09 passed run 42543651519. Draft native
Timecode #272 at daa76f2d passed run 42545523831 (web and native Rust). This
follow-up branches from fix/native-timecode-authority and is held for owner merge.


### PR #273 coverage-gate correction (2026-11-08)

Run 42547373079 at 1068e94b passed all tests but failed the Timecode coverage
thresholds: branches 89.56% versus 90%, lines 94.91% versus 95%. The shared
SMPTE validator had moved outside the coverage inventory. Coverage now follows
shared Timecode source too, using absolute instrumentation paths and the same
inventory in both pools. No threshold changed. An instrumentation probe confirms
that the actual shared validator appears in the report with executed counters.

Added seven real Worker cases for identical/conflicting cues from older timelines,
removal after legacy adoption, rate-specific invalid labels, missing payloads and
unusable identities. The malformed-request cases exposed unhandled immediate
promise rejections despite the HTTP 400; awaiting createCue inside the command
handler fixes that propagation. All 19 creation Worker tests now pass without
those unhandled errors.

Full coverage run 2 passes 2,900 unit and 1,608 Worker tests (4,508 total).
Web typecheck 3 and build 2 pass; the client bundle remains within unchanged budgets.
Timecode: statements 92.27%, branches 90.30%, functions 91.66%, lines 95.11%.
Relays: 86.73%, 84.61%, 90.34%, 92.18%; devices: 64.55%, 49.88%, 62.90%, 67.19%,
in that metric order. Coverage run 1 correctly rejected the missing shared file;
the absolute-path probe and run 2 verify instrumentation and the gate itself.
Logs: /tmp/showpilot-native-timecode-cue-{worker3,worker4,worker5,coverage1,coverage-probe,coverage2,tsc3,build2}.log.
The next native clock-review work is retained on fix/native-timecode-clock-review
and has no PR; the next PR remains gated on #273's corrected head passing CI.


## Phase 2 follow-up: reviewed native Timecode clock edits (2026-11-08)

Native frame-rate buttons omitted the backend's confirmation/precondition fields,
so valid operator clicks were rejected. Manual clock changes had neither a
confirmation nor stale-state protection. Eight initial Worker regressions failed.

Native seek and reformat now open a bounded, scrollable confirmation showing the
selected show and the proposed change. The reviewed show/date, held frame,
format and incoming-format identity are frozen. A newer clock/format/date disables
confirmation until explicit review; losing connection/control or starting the
source disables both review and confirmation. Cancel preserves the entered time.
The source must be stopped. Incoming format and automation jump holds are visible.

A dedicated edit-clock command commits the clock/timeline changes and an immutable
actor-scoped receipt atomically. Retries use the original request, returning its
result without rewinding later movement or formatting. Conflicts/rejections remain
terminal even if their old preconditions return. New requests require a new
review. The native draft, review and request survive screen navigation, scoped by
account/organization/show; they do not survive application termination. Mutation
and refresh deadlines are 15 and 12 seconds respectively, and a confirmed result
has a separate refresh retry. Stop remains available while a result is uncertain.
Deploy the matching backend before distributing this native build.

Web and reviewed native edits share the same prepared clock transformation.
Reformat preserves cue execution history and recalculates trigger/dispatch frames
at the new rate. It refuses while a cue is awaiting acknowledgement, preserving
that cue's live object/result. Large seeks keep the existing automation hold,
without re-arming fired cues. Invalid legacy set-timecode requests now return an
explicit error instead of reporting success without changing anything. Immediate
reviewed-command rejections are awaited inside the command handler, as with the
creation-receipt correction in #273.

Verification: final full suite 3 passes 354 unit files / 2,943 tests plus
145 Worker files / 1,621 tests, 4,564 total. This includes 14 native hook tests,
29 boundary/transformation unit tests and 13 real Worker clock-edit tests.
Coverage run 2 passed all unchanged thresholds before the final native-only
review-availability refinement: Timecode 93.06% statements / 92.16% branches /
91.48% functions / 95.31% lines. The final full suite verifies that refinement.
Web typecheck 3 and build 1 pass; the main client is 549,593 raw / 173,795 gzip
bytes. Native verify 3 passes all exports, Expo Doctor 18/18, contracts and polling
boundaries, with 18 existing lint warnings and no errors. Hermes bundles are
5,806,126 bytes on iOS and 5,805,268 on Android.

Compiled Expo web rehearsal 1 passes against disposable real authentication, D1
and TimecodeRelay. It verifies no edit before confirmation, a newer clock making
a dialog stale, explicit re-review, a lost seek reply, a later clock movement,
navigation to another show and back, same-request retry preserving that later
movement, refresh-only recovery, canceling reformat and then confirming a valid
reformat. It asserts no overflow at 320/768/1440px and a 44px-or-larger cancel
control. Narrow and wide dialog screenshots were inspected. No runtime errors.
This is an Expo web rehearsal, not physical-device verification.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-clock-review.mjs`.
Logs: /tmp/showpilot-native-timecode-clock-{before,worker1,worker2,worker3,unit1,unit2,full1,full2,full3,coverage1,coverage2,mobile-tsc1,tsc1,tsc2,tsc3,build1,verify1,verify2,verify3,browser1}.log.
Screenshots: /tmp/showpilot-native-timecode-clock-review-{320,768,1440}.png.
An early hook test failed because it asserted before Query's queued notification;
it now waits for the actual rendered value. An early in-flight Worker fixture
resolved a response from a foreign DO context; the corrected delay creates its
response within the request context. The failing process was explicitly stopped
after that real error. No deadlines, coverage thresholds or auth checks changed.

Phase 2 remains 67/79. Native Timecode still needs automation kill/resume and
per-cue retry controls, accessible cue-delete/reset confirmations, broader editing
and typed action fields, including complete frame-rate choices. Native Chat,
rundown editing and ProPresenter recovery also remain open. No deployment,
release, migration, external mail or real-org write. Twenty necessary tracked
Markdown files remain, with no new Markdown file.

Stack gate: #273's corrected head 9e24b348 is running CI 42549381346; its Rust
job and web coverage step passed, with native verification still active at this
recording. This clock-review branch remains without a PR until that head is green.


## Phase 2: native Timecode automation Stop and reviewed Resume

Native Timecode now exposes the global automation Stop and a separately reviewed
Resume, plus resume of the cue-controlled automatic-firing gate. Stop does not
wait for a confirmation and remains available while Resume or another change is
pending. It stops new dispatches without stopping the clock or clearing existing
output; already-sent commands cannot be recalled. Resume explains the selected
show, any clock-jump hold, and that crossed cues are not replayed or re-armed.

A durable automation revision changes on Stop, legacy gate decisions, automatic
cue gates, clock edits and safety holds. This catches a second Stop while already
off, including an older Resume that arrives afterward. The reviewed gate command
stores its immutable actor/request receipt atomically with state and clock. A
lost-reply retry returns its original result without overriding a later Stop or
Resume. Device timing and renewed membership checks happen outside the local
commit lock; current control, generation and review are rechecked at commit.
The automatic-cue gate cannot bypass the global Stop or an unresolved format.

Native review and request state are scoped by actor/organization/show and survive
screen navigation, not app termination. Mutations and refreshes have 15s and 12s
deadlines. A known result has refresh-only recovery. Another Stop remains possible
after an uncertain result, while an original retry retains the same request ID.
No global Phase 2 requirement is closed by this narrower Timecode change. Matching
backend deployment is required before distributing this native build.

Verification: six initial Worker regressions failed before implementation. The
final coverage/full-suite run passes 356 unit files / 2,973 tests and 146 Worker
files / 1,633 tests, 4,606 total. New focused coverage includes 14 native-hook
cases, 16 shared-boundary cases and 12 real Worker cases. Timecode coverage is
93.20% statements / 92.54% branches / 91.83% functions / 95.39% lines; all other
unchanged coverage gates pass. Web and mobile typechecks pass. Web production
build passes at 549,593 raw / 173,795 gzip main-client bytes. Native verification
passes iOS/Android/web exports, Expo Doctor 18/18, contracts and polling checks,
with 18 existing lint warnings and no errors. Hermes bundles are 5,825,399 bytes
on iOS and 5,824,560 on Android.

The compiled Expo web rehearsal passes against disposable real auth, D1 and
TimecodeRelay: Stop leaves freerun running; opening/canceling review sends no
resume; a newer stop disables stale confirmation; a lost Resume reply followed
by native Stop preserves that stop after navigation and same-request retry;
refresh-only recovery never repeats the mutation; old Stop receipts preserve a
later Resume; and automatic-cue pause/resume remains independent. At 320, 768 and
1440px it checks horizontal overflow and 44px control targets. The 320px and
1440px screenshots were inspected. No runtime errors. This does not claim a
physical-device rehearsal.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-automation-gate.mjs`.
Logs: /tmp/showpilot-native-timecode-gate-{before,worker1,worker2,worker3,unit1,mobile-tsc1,mobile-tsc2,tsc1,coverage1,build1,verify1,browser1}.log.
Screenshots: /tmp/showpilot-native-timecode-gate-review-{320,768,1440}.png.
The first expanded Worker run exposed two fixture assumptions: unauthenticated
DO responses are text/401, and default startup tolerance can fire a cue near the
first frame. The corrected crossing fixture explicitly uses zero tolerance and
asserts that held cues stay unfired. A native generic-inference type error was
fixed with the concrete command/result types; final typechecks are green.

Phase 2 remains 67/79. Native Timecode still needs per-cue retry/disable/re-arm,
accessible delete/reset confirmations, broader editing/typed action fields and
complete frame-rate choices. Other outstanding product-wide UX checks remain
open. No deployment, release, remote migration, external mail or real-org writes.
Twenty necessary tracked Markdown files remain; no new Markdown was added.

Stack gate: #273 head 9e24b348 passed CI 42549381346. Clock review is draft #274,
head b7c2b25e, CI 42551059842. Its Rust job and coverage step have passed; native
verification is still running at this recording. The automation-controls branch
will be pushed, with a draft PR held until that exact preceding head is green.


## Phase 2: native Timecode cue controls and guarded recovery

Native Timecode now has per-cue Enable/Disable, Fire now, Retry, Fire again,
Re-arm and Remove, plus Re-arm all cues. Fire/retry/re-fire, removal and execution
history resets use bounded, accessible confirmation dialogs. Review includes the
show and exact cue/history snapshot. Changing a cue, adding/removing a cue during
a whole-timeline review, or moving/restarting the clock invalidates the applicable
confirmation. Review errors remain visible inside the dialog. Disable is immediate
and can cancel queued output; it cannot recall an already-sent command. Sending
and failed statuses also retain the Disabled label where applicable.

The new control-cues command atomically records actor/request receipts with the
staged cue mutation. Recovery cannot erase a later firing, disable a subsequently
enabled cue, delete a replacement cue or repeat a completed dispatch. Output
requests reserve a dispatch before external I/O, outside the local commit lock;
request acceptance remains distinct from delivered/failed cue status. Permission
and control are rechecked before a reviewed output dispatches. A newer Stop cancels
queued reviewed output even if automation resumes before dispatch. Fire/Retry/
Fire again also carry the persisted automation revision, rejecting older requests
that arrive from the network after a newer Stop and Resume. An interrupted named
timer retry retains its delivery identity and original deadline. In-flight Disable
preserves the live event object and its subsequent acknowledgement.

Native reviews and uncertain requests survive navigation by actor/org/show, not
application termination. Request and refresh deadlines remain 15s and 12s. Known
results offer refresh-only recovery, with no silent repeat. The unused generic
native command API was removed after migrating its delete/reset callers. The
native verifier now checks the explicit controlMobileTimecodeCues integration.
Matching backend deployment is required before distributing this native build.

Verification: the initial four Worker regressions failed before implementation.
A later focused regression also reproduced an old Fire arriving after Stop/Resume;
it now rejects the stale automation revision. Final full suite passes 358 unit
files / 3,043 tests plus 147 Worker files / 1,648 tests, 4,691 total. The preceding
coverage run passes all unchanged thresholds on the final backend/shared logic:
Timecode 93.52% statements / 93.45% branches / 92.52% functions / 95.55% lines.
The final native-only dialog-feedback refinement has an additional passing hook
test in the final full suite. Web typecheck 3 and production build pass, with the
main client unchanged at 549,593 raw / 173,795 gzip bytes. Native verification
passes iOS/Android/web exports, Expo Doctor 18/18, contracts and polling boundaries,
with 18 existing lint warnings and no errors. Hermes bundles are 5,848,916 bytes
on iOS and 5,848,017 on Android.

The compiled Expo web rehearsal passes using disposable real authentication, D1
and TimecodeRelay. It checks fire confirmation/cancel, stale re-arm review and
explicit re-review, lost Disable reply followed by a later Enable, navigation and
same-request recovery, refresh-only recovery, visible failed device delivery and
reviewed Retry, disabled whole-timeline reset while running, a new cue invalidating
a reset review, confirmed reset and confirmed/cancelled deletion. It checks no
horizontal overflow at 320/768/1440px and 44px-or-larger review controls. The 320px
and 1440px confirmation screenshots were inspected. No runtime errors. This is
compiled Expo web verification, not a physical-device rehearsal.

The first full coverage run exposed a timing assumption in the existing projector
cockpit test: it clicked Unmute once Unblank had been called, while the control
correctly remained disabled until acknowledgement. The test now holds that first
acknowledgement, proves another command is blocked, then acknowledges it and waits
for the real enabled state before sending Unmute. Projector application code was
not changed. Early typechecks also caught an optional controller-session identity
and an insufficient union narrowing; both were corrected without type assertions.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-cue-controls.mjs`.
Logs: /tmp/showpilot-native-cue-controls-{before,worker1,worker2,worker3,worker4,late-before,unit1,mobile-tsc1,mobile-tsc2,tsc1,tsc2,tsc3,coverage1,coverage2,coverage3,full1,build1,verify1,browser1}.log.
Screenshots: /tmp/showpilot-native-cue-controls-{320,768,1440}.png.

Phase 2 remains 67/79. Native Timecode still needs the fuller editor/action catalog,
typed action fields/pickers, complete frame-rate choices, timeline next/missed
presentation and lyrics preview controls. Native Chat, rundown editing,
ProPresenter recovery and the other product-wide checks remain open. No deployment,
release, remote migration, external mail or real-org changes. Twenty necessary
tracked Markdown files remain; no new Markdown was added.

Stack gate: #275 head e24ddfac passed CI 42552555899 before opening this change's
PR. This change is stacked on fix/native-timecode-automation-controls and remains
a draft for owner review. Its own exact-head CI must pass before the next PR.

## Phase 2: native Timecode structured cue editor and recoverable edits

The native Timecode editor previously exposed raw JSON, offered only 19 of the
web editor's 33 actions, and could not edit existing cues. It now uses the shared
33-action catalog, typed message/timer/lower-third/webhook fields, and searchable
device/action, song/section, rundown-item and media selectors. It exposes tolerance
and cue lead, validates timecode inline, and offers both 29.97 fps NDF and DF.
Choice requests have a 10-second bound, visible errors and explicit refresh/retry.
Device choices reuse the web catalog reader; both Timecode and domain permissions
are required. Device settings and credentials remain server-side. Device parameter
normalization and the existing webhook URL boundary are shared without widening
allowed destinations. All normalizer callers migrated; the obsolete web file was
removed, and the shared executable sources remain inside the coverage gate.

Existing cues can be edited without deleting, firing or re-arming them. Metadata
edits preserve action details by default. Drafts and uncertain requests remain
scoped by actor/org/show across navigation, not application termination. The inline
editor focuses the label and hides the creation form while editing; global Stop
and navigation remain accessible. Stale cue/revision/execution/format reviews block
save and offer an explicit replacement of the draft with the current definition.
The existing update-event command now supports immutable request receipts committed
atomically with the definition. Same-request recovery preserves later edits and
cannot resurrect a deleted cue. Legacy clients retain their response contract and
field allowlist. Business rejections leave the room usable for the next command.
Backend deployment is required before distributing this native build.

Verification: final full suite passes 360 unit files / 3,109 tests and 149 Worker
files / 1,669 tests, 4,778 total. New coverage includes 18 native edit-hook cases,
48 structured-field cases, 17 edit-receipt Worker cases and four authenticated
catalog Worker cases. The earlier coverage run on the final backend/shared logic
passes 4,777 tests and all unchanged thresholds: Timecode 93.71% statements /
93.62% branches / 92.52% functions / 95.55% lines; relays 87.14 / 85.18 / 91.11 /
92.34; devices 64.55 / 49.88 / 62.90 / 67.19. Later native-only field-limit and
layout refinements are covered by the final full suite and browser rehearsal.
Web typecheck passes. Production build passes at 542,274 raw / 171,106 gzip bytes
for the main client. Final native verification passes typecheck, lint (18 existing
warnings, zero errors), iOS/Android/web exports, Expo Doctor 18/18, contracts and
polling checks. Hermes bundles: 5,918,321 bytes iOS and 5,917,475 bytes Android.

The compiled Expo web rehearsal uses disposable real authentication, D1 and
TimecodeRelay. It creates stage-message, timer, ATEM, lyrics and ProPresenter cues
through the new fields; checks inline invalid-time blocking and both fractional
frame formats; bounds a lost device-catalog response and retries it; rejects a
stale edit without losing its draft; explicitly reloads and saves a revised cue;
recovers a lost edit reply after show navigation while preserving a newer edit;
and retries a failed timeline refresh without resending the edit. It also checks
a legacy rejection followed by a successful edit, no horizontal overflow at
320/768/1440px, 44px minimum save/discard controls, and no runtime errors. The 320px
and 1440px screenshots were inspected. This is not physical-device verification.

The first Worker regression run reproduced missing recovery receipts. The broader
legacy suite then exposed a concurrency-lock rejection resetting the input gate;
business errors now leave the lock before being thrown, and all legacy tests pass.
An initial coverage inventory failure identified the obsolete normalizer barrel;
callers were migrated instead of exempting it or lowering thresholds. Browser
rehearsal waits for the rendered editor and explicitly reclaims control after the
injected refresh reconnect. No production state was involved in these failures.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-cue-editor.mjs`.
Logs: /tmp/showpilot-native-cue-editor-{before,worker1,worker2,worker3,unit1,unit2,unit3,mobile-tsc1,mobile-tsc2,tsc1,tsc2,tsc3,coverage1,coverage2,full1,full2,build1,verify1,verify2,verify3,browser1,browser2,browser3,browser4}.log.
Screenshots: /tmp/showpilot-native-cue-editor-{320,768,1440}.png.

Phase 2 remains 67/79. Native timeline next/missed presentation, target summaries
and lyrics preview controls remain open, alongside the other product-wide UX
requirements. No deployment, release, remote migration, external mail or real-org
changes. Twenty necessary tracked Markdown files remain; none were added.
Stack gate: #276 head 9c7bfbc10818e62a10f7299052f17d677785c5ba passed CI
42555671474 before opening this change's draft PR. Its own exact-head CI must pass
before opening the next PR.

## 2026-11-08 — Native Timecode timeline and fixed transport

Branch: fix/native-timecode-timeline, stacked on fix/native-timecode-cue-editor.
Native Timecode previously rendered the relay array in received order, discarded
canonical dispatch timing during parsing, and showed only basic execution status.
Its clock and both stop controls scrolled away. The timeline now shares Next,
ordering, dispatch-frame, overdue/missed and payload-summary functions with web,
MIDI feedback and the relay. Nominal cue order remains separate from dispatch
order; cue lead and captured device latency determine the countdown and Next.
The old web summary implementation was moved to shared and its callers migrated.

Native rows now show Next, Overdue, Missed and FAILED text, tolerance, early-send
timing, device names and short device/webhook summaries. Secret fields are omitted
and webhook summaries show only the origin. Device names use the existing
org-scoped Devices API with an abortable ten-second deadline and inline retry.
A missed/failed list and Fire next reuse the existing reviewed, recoverable cue
commands. Disabled/skipped cues and the automation gate still block output.
Disconnected timelines identify the last known Next and disable controls.

The clock, running state, automation state, Start, Stop and Stop automation live
outside the page scroll area. The module gate also gates this fixed header.
Automation stop confirmation stays visible even at the bottom of a long timeline.
Cue editing, retained saves, clock review and automation recovery keep their
existing controls; the timeline is now above the creation form.

Final full suite passes 361 unit files / 3,129 tests and 149 Worker files / 1,669
tests: 4,798 total, including 20 new native timing cases. Web and shared typechecks
pass. The web build passes at 542,274 raw / 171,110 gzip bytes for the main client;
subsequent refinements were native-only. Final native verification passes
TypeScript, lint (18 existing warnings, zero errors), all three exports, Expo
Doctor 18/18, contracts and polling checks. Hermes bundles: 5,935,332 bytes iOS,
5,934,492 bytes Android. Coverage thresholds and bundle limits are unchanged.

The final compiled Expo web rehearsal uses disposable real authentication, D1
and TimecodeRelay. It deliberately reverses event arrays on the wire, verifies
nominal ordering and lead-aware Next/countdowns while stopped, drop-frame labels,
missed/overdue/disabled/failed states, a ten-second device-name failure and retry,
redacted summaries, cancelled/confirmed Fire next and attention-list reviews.
Start/Stop and Stop automation affect the real fixture room; stopping automation
keeps the clock running. Socket loss marks cached state and disables controls.
Controls remain at least 44px and visible while scrolled at 320/768/1440px and
320x568. Screenshots were inspected. The existing cue-editor rehearsal also passes
with the new layout, including stale review, retained lost replies after show
navigation, preservation of later edits and refresh-only recovery. This is not
physical-device verification. A screenshot's ambiguous semicolon appearance was
checked against rendered text; the header was already correct, and assertions now
cover it before and after cue actions.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-timeline.mjs`.
Logs: /tmp/showpilot-native-timeline-{mobile-tsc1,mobile-tsc2,unit1,full1,full2,tsc1,tsc2,shared-tsc,build1,verify1,verify2,browser1,browser2,browser3,browser4,editor-browser}.log.
The first mobile typecheck caught a JSX extraction error, corrected before tests.
Screenshots: /tmp/showpilot-native-timeline-{320,768,1440,short}.png.

Phase 2 remains 67/79; broad product-wide requirements remain partial. Native
lyrics preview controls/fitting are next, followed by the other recorded native
and web UX gaps. No deployment, release, remote migration, external mail or
real-org changes. Twenty necessary tracked Markdown files remain; none added.
Stack gate: #277 exact head 737fd18a673eb4f0eb9ba8490c7234bf188adb86 passed CI
42559076471 before opening this change's draft PR. Its own exact-head CI must pass
before another PR is opened.

## 2026-11-08 — Native lyrics preview, reviewed controls and safe recovery

Branch: fix/native-timecode-lyrics-preview, stacked on fix/native-timecode-timeline.
Native Timecode no longer truncates the preview to four nonempty lines. It keeps
every line and blank line, uses the same measured font-fit search as confidence,
and grows vertically at a 12px floor when dense lyrics cannot fit. The fixed
transport remains reachable. Previous, Next and Clear now show inline reviews,
pending states, errors and recovery. Stale song/section/revision/generation
reviews cannot change output. The review identifies the selected show and song.

The relay atomically stores the output and an actor-scoped request receipt.
Recovering a lost reply returns that receipt without advancing twice or clearing
a later song. Song lookup and fresh permission checks have a shared five-second
deadline outside the local commit, allowing Stop and newer lyrics to interrupt.
The commit checks current ownership, show/date and lyrics again. Rejections do
not reset the Durable Object input gate. Existing web controls remain supported.
Native requests retain their original identities across navigation, bound sends
to 15 seconds and refreshes to 12 seconds, and offer refresh-only recovery after
the result is known. Clear recovery remains available with no lyrics on output.

The confidence browser rehearsal also exposed a real settings bug. Adding an
optional upcoming-text color changed object property order; the acknowledged
layout was normalized by its schema, so raw JSON comparison incorrectly kept the
editor dirty and hid success. Draft comparisons and writes now use the same
schema order. A regression failed before the fix and passes afterward; newer
edits made during a save remain unsaved until separately applied.

Final full suite: 363 unit files / 3,157 tests and 150 Worker files / 1,690 tests,
4,847 total. Web typecheck and production build pass. Main client is 542,274 raw /
171,102 gzip bytes under unchanged limits. The preceding coverage run passes all
4,846 then-current tests and unchanged thresholds: Timecode 93.77% statements,
93.75% branches, 92.66% functions, 95.59% lines; relays 87.35/85.47/91.20/92.44;
devices 64.55/49.88/62.90/67.19. The final extra test covers the color-save bug.
Native verification passes TypeScript, lint (18 existing warnings, zero errors),
iOS/Android/web exports, Expo Doctor 18/18, API contracts and polling checks.
Hermes bundles: 5,960,185 bytes iOS and 5,959,345 bytes Android.

The compiled native web rehearsal uses disposable real authentication, D1 and
TimecodeRelay. It verifies seven lines including a blank line, fifty-line growth,
320/768/1440px layouts, 44px controls, cancelled/confirmed Next/Previous/Clear,
stale review, a lost Next reply recovered after show navigation, preservation of
newer output, known Clear with refresh timeout/retry, and first-section errors.
Next replaces lyrics directly without a lyrics-clear message or preview unmount.
The built web lyrics rehearsal also passes with a stable confidence DOM node.
The confidence renderer/editor rehearsal passes at 320, 390, 768, 1280, 1920,
2560 and 3440px, including stable upcoming font size, scripture reference
separation, simulated output control and the confirmed color save. Screenshots
were inspected. Expo web and simulated native output are not physical-device
verification.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-timecode-lyrics.mjs`;
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-lyrics-steps.mjs`;
`node apps/web/scripts/smoke-confidence.mjs`.
Logs: /tmp/showpilot-native-lyrics-{full1,full2,coverage1,tsc2,tsc3,build1,build2,verify1,browser1,web-browser,confidence-browser,confidence-browser2,color-before}.log.
Screenshots: /tmp/showpilot-native-lyrics-{320,768,1440}.png and
/tmp/showpilot-confidence-controls.png. The first confidence rehearsal failed on
the real color-save bug described above; the unchanged rehearsal passes now.

Phase 2 remains 67/79. Broad product-wide requirements stay open. The next
identified gap is native Chat: socket opening/history hydration and older-history
fetches lack deadlines, and unacknowledged sends have no visible recovery.
No deployment, release, remote migration, real-org write or external mail.
Twenty necessary tracked Markdown files remain; none added.
Stack gate: #278 exact head 65b555e751d709a15bdf99afd416e265033874f6 passed CI
42561112839 before opening this draft. Its own exact-head CI must pass before
another PR opens.

## 2026-11-09 — Native Chat connection, history and delivery recovery

Branch: fix/native-chat-recovery, stacked on fix/native-timecode-lyrics-preview.
Native Chat previously declared itself connected before its history arrived,
allowed socket opening and history fetches to stall indefinitely, and removed
sent messages from an invisible queue before acknowledgement. Room changes
silently discarded queued messages. The new transport tests reproduced ten
failures before implementation.

A mounted actor/org/room now owns its socket, authentication cancellation and
connection generation. Authentication retains the existing ten-second bound;
a separate ten-second opening/hydration deadline closes a stalled socket. Only
valid hydration declares the room connected and enables queued sends and message
mutations. Disconnect and background transitions cancel pending work; late
callbacks cannot populate another room or actor. Connection errors persist with
Retry, cached messages remain visible, and unavailable history never appears as
an empty room. Older-history loading bounds credentials, HTTP and body parsing
together to ten seconds and exposes a separate error/Retry. New hydration,
including history clear, cancels older requests and prevents stale restoration.

The actor/org/room query cache retains queued, sending, uncertain and rejected
messages during app-session navigation. A twelve-second acknowledgement deadline
makes uncertain delivery visible. Retry uses the original immutable message ID
and frame, including attachments, replies and polls; the existing relay dedupes
that ID. Rehydrated acknowledgements reconcile delivery without a resend. Only
never-sent queued messages flush automatically; uncertain messages require an
explicit retry. Removing an entry requires confirmation and never deletes the
server message. This is session-memory retention, not persistence across an app
restart. Send, room selection, history and recovery controls meet 44px minimums.

Final full suite passes 364 unit files / 3,182 tests plus 150 Worker files / 1,690
tests, 4,872 total. This includes 25 new transport cases and the two existing
history-clear regressions migrated to the shared native hook harness. The first
full run exposed stale mocks in those two existing tests; their original
clear/reconnect/late-page assertions remain. Web typecheck and production build
pass; the main client remains 542,274 raw / 171,102 gzip bytes. Final native
verification passes TypeScript, lint (18 existing warnings, zero errors), all
three exports, Expo Doctor 18/18, contracts and polling checks. Final Hermes
bundles: 5,972,034 bytes iOS / 5,971,238 bytes Android. Limits are unchanged.

The compiled Expo web rehearsal uses disposable real authentication, D1 and
ChatRelay. It withholds history, verifies queued-not-sent UI and the handshake
deadline, restores the connection, drops an actual message acknowledgement,
changes rooms, and retries the original ID. Two sends leave exactly one stored
message. It also checks confirmed local removal, history timeout/retry and
320/768/1440px layouts, including 320x568 and reachable 44px controls. Synthetic
history rows expose pagination; HTTP history requests still reach the real
fixture Worker. Screenshots were inspected. This is not physical-device proof.

Reproduce after web build and native export:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-chat-recovery.mjs`.
The final browser4 run exits zero. Earlier runs exposed fixture teardown and
fault-timing issues: a delayed HTTP request outlived the server, fault release
preceded hydration and legitimately reconciled the message before Retry, and
waiting for all routes before closing Chrome hung on open connections. The
harness now keeps a network guard, closes Chrome and sockets, drains only HTTP
work, then stops the fixture. The hung browser3 fixture processes were stopped
and their temporary data removed before the final rerun. No app assertion was
weakened to resolve these harness issues.
Logs: /tmp/showpilot-native-chat-{before,unit1,unit2,unit3,unit4,full1,full2,full3,mobile-tsc1,tsc1,tsc2,build1,verify1,verify2,browser1,browser2,browser3,browser4}.log.
Screenshots: /tmp/showpilot-native-chat-{short,320,768,1440}.png.

Phase 2 remains 67/79; the broad product-wide gates remain open. Native Chat
composer drafts still need room/actor isolation and its notification calls still
swallow failures; those are the next Chat follow-ups. No deployment, release,
remote migration, external mail or real-org data changes. Twenty necessary
tracked Markdown files remain; none added.
Stack gate: #279 exact head 04257b835a1ed772716afad45c0025dfad5955e6 passed both
jobs in CI 42563967696 before opening this draft. This draft's exact-head CI must
pass before another PR opens.


### Phase 2: native Chat drafts and notification recovery (2026-11-09)

Native Chat now retains text, message type, reply/edit context, an uploaded
attachment, and unfinished poll fields by actor, organization and room for the
current app session. Leaving the screen does not discard them. A late edit
acknowledgement clears only the submitted draft, preserving newer typing; sending
a separate text message preserves an unfinished poll. This is in-memory
navigation recovery, not persistence through process termination.

Message notification intent is stored before sending the relay frame. After the
relay acknowledges delivery, the outbox distinguishes delivered chat from an
unconfirmed crew notification. Notification calls have a 15-second deadline and
an explicit notification-only retry. Reaction notifications are planned from the
acknowledged reaction snapshot; retry does not toggle the reaction again.
Attempts retain their actor, organization, room, message and request identities
across navigation, and mismatched receipts cannot settle them. The server checks
the original account identity before writing, reports inbox preparation/write
failures as 503, and uses insert-once event keys so retry cannot duplicate push
attempts or reset existing read/dismissed inbox state. Push remains best effort;
success confirms durable inbox creation, not receipt on a physical device.
Already-released clients retain their legacy response shape. Other operational
notification callers retain their existing best-effort failure policy.

Verification: 3,220 unit and 1,690 Worker tests passed (4,910 total); web typecheck
and production build passed. Main web bundle remains 542,274 raw / 171,102 gzip
bytes. Native verification passed typecheck, lint (18 existing warnings, zero
errors), iOS/Android/web exports, Expo Doctor 18/18, API contracts and polling
boundaries. Hermes bundles: iOS 5,978,380 / Android 5,977,492 bytes. Focused cases
cover full composer isolation, late acknowledgement, notification deadline and
late response, receipt identity mismatches, same-event retries, partial failures,
reactions, and preserving a poll while sending text.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-chat-drafts.mjs`
exercises the compiled Expo web UI with real disposable auth, D1 and ChatRelay.
A recipient-specific D1 trigger fails one inbox write while another succeeds.
After marking the successful inbox item read/dismissed, restoring the database
and retrying creates the missing item without resending chat or resetting the
existing item. A dropped notification HTTP reply also recovers without duplicate
messages or inbox items. Text and poll drafts survive Production/Planning room
switches. 320/768/1440px layouts, including 320x568, have reachable 44px retry
controls and no document overflow. Browser2 exited zero and screenshots were
inspected. Browser1 passed behavior assertions but captured the room picker
closing; browser2 waits for it to disappear and checks unobstructed clickability.
The fixture's separate live-show indicator reports unavailable; this rehearsal
proves Chat recovery, not live-rundown or physical-device operation.

Logs: /tmp/showpilot-chat-drafts-{full1,tsc1,build1,verify1,browser1,browser2}.log;
/tmp/showpilot-chat-notification-unit1.log;
/tmp/showpilot-chat-notifications-{before,server1,server2}.log.
Screenshots: /tmp/showpilot-chat-drafts-{short,320,768,1440}.png.
Phase 2 remains 67/79. Web Chat notification recovery and the remaining native
Chat upload/share/mutation workflows still need their broader UX pass. No deploy,
release, remote migration, external mail or real-org writes. Twenty necessary
tracked Markdown files remain, with none added.
Stack gate: #280 exact head 00e5f63d4d5df7857a7f1dbb400f4e29acbbd4da passed
both jobs in CI 42566284825 before this draft opens. This draft's exact-head CI
must pass before another PR opens.


### Phase 2: native Chat invitation recovery (2026-11-09)

Native Chat previously created a fresh grant on retry, discarded the returned
link before opening the share sheet, and reported a share failure as failed
creation. Crew and Planning invitations now retain their choices, request ID,
link, original expiry and notification outcome by account, workspace and room.
Creation and sharing have separate 15-second deadlines and explicit retries.
Closing the sheet preserves the draft or pending request for this signed-in app
session. A notification retry reuses the existing grant; a failed, timed-out or
cancelled share leaves the link available. Starting another invitation requires
review of the fact that an earlier link may still be active. Expired links cannot
be shared, and selections can be cleared if a member becomes unavailable.

Chat member reads now have a 10-second deadline, an account-scoped query key,
a response identity check, and visible error/retry. The current session supplies
the actor instead of a potentially stale member response. Invite requests carry
the expected actor and receive authoritative account/workspace/request/scope
metadata. A changed account is rejected before grant creation. The existing
receipt table and authorization rules are reused; no migration is needed.
Deploy the API response extension before releasing a native build that expects
it. Previously released clients keep their existing response shape when they
omit a request ID.

Removed the unsupported guest-text-only claim from web and native invite copy.
ChatRelay still accepts guest-supplied cue/alert message types; enforcement is an
explicit Phase 3 item and was not implemented ahead of the Phase 2 gate.

Verification: the initial API regression run failed three assertions (missing
identity metadata and two changed-account requests accepted). The fix passes
those checks and a real Worker/D1 test proving rejection before insertion and
one recovered grant after retry. Final full suite: 3,243 unit + 1,691 Worker =
4,934 passing tests. Web typecheck and production build passed; main bundle
542,274 raw / 171,113 gzip bytes, within unchanged budgets. Final native verify3
passed typecheck, lint (18 existing warnings, zero errors), all three exports,
Expo Doctor 18/18, contracts and polling checks. Hermes bundles: iOS 5,994,009 /
Android 5,993,129 bytes. Thirty final focused invite UI/hook tests passed after
the copy and checked-state changes. The focused parameterized test initially
unpacked array fixtures incorrectly; correcting the fixture shape preserved its
selection-validation assertions.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-chat-invites.mjs`
uses compiled Expo web with disposable real auth, D1 and pass issuance. It rejects
a mismatched member response, recovers with Retry, loses an actual grant reply,
and verifies the same token/expiry/request with one stored grant. Crew and
Planning choices remain separate through close/reopen and room changes. Sharing
failure, timeout, cancellation and retry use the same link without further grant
creation. A real D1 notification trigger exposes a ready Planning link with a
missing notification; retry after restoring the database preserves the link and
creates one inbox item. Share outcomes are simulated browser adapters, not a
physical iOS/Android share-sheet test. The first browser run exposed missing
checked-state attributes on the compiled radio/checkbox controls; explicit
aria-checked was added rather than weakening the assertion. Final browser3
exited zero at 320/768/1440px including 320x568, with unobstructed 44px+ retry
controls and no document overflow. Screenshots were inspected. The separate
fixture live-show indicator remains outside this Chat rehearsal's coverage.

Logs: /tmp/showpilot-chat-invites-{before,unit1,unit2,unit3,full1,full2,full3,full4,mobile-tsc1,tsc1,tsc2,build1,build2,verify1,verify2,verify3,browser1,browser2,browser3}.log.
Screenshots: /tmp/showpilot-chat-invites-{short,320,768,1440}.png.
Phase 2 remains 67/79; product-wide UX and final phase gates remain open. Web
Chat still starts notifications before relay acknowledgement and swallows some
failures; native Chat attachment and message-mutation recovery also remain.
No deployment, release, remote migration, external mail or real-org writes.
Twenty necessary tracked Markdown files remain, with none added.
Stack gate: #281 exact head 35d326e57f3332abd8e507013dd045eaa6bbc2d4 passed
both jobs in CI 42568671152 before this draft opens. This draft's exact-head CI
must pass before another PR opens.

### Phase 2: native rundown item recovery (2026-11-09)

The native item editor closed as soon as it sent a WebSocket save. Moving an
item also closed the form and discarded unsaved fields. The before regression
failed the close-before-confirmation assertion while the existing eleven
confirmation checks passed.

The editor now retains all fields, its new-item ID, the reviewed order and
revision, and the original request by account, organization and show for the
current app session. Save, Add and Move use the existing authenticated mobile
change endpoint and RundownRelay single writer. New strict command variants
allow only editable item fields and exact order IDs. The relay still verifies
live session, permission and PIN, deduplicates retries and rejects stale
revisions. No direct rundown-item writes or database migrations were added.
Deploy the expanded API command contract before releasing this native client.

Requests have a 15-second deadline, visible outcome and exact-request retry.
A failed refresh has a separate retry that does not repeat the edit. Closing or
navigating away preserves drafts and pending results. Moving an item retains
unsaved text. A revision conflict requires explicit review of the current item,
order and date before adopting a new revision; another intervening change
invalidates that review. An unresolved save cannot be silently discarded or
rebased. Draft discard is explicitly confirmed. Existing item-removal review,
undo and timer authority remain unchanged. Retention is in-memory navigation
recovery, not persistence through app termination.

The sheet is bounded to 680px, type choices have 48px targets and explicit checked
state, and its fixed header keeps request status visible. A browser regression
found a 482-character title consumed the entire 320x480 screen; the header now
uses two lines while the title field retains the full value. The rundown's resume
button abbreviates its visible label and keeps the full accessible name.

Verification: all three full-suite runs passed 3,258 unit + 1,695 Worker = 4,953
tests. Focused final editor/hook checks passed 26 tests. Web typecheck and
production build passed; main bundle remains 542,274 raw / 171,113 gzip bytes.
Real Worker tests cover add deduplication after eviction, preserving a later
operator edit/order on retry, stale-revision rejection, forged operational-field
rejection and actor isolation. Hook cases cover retained fields, navigation,
account/show separation, deadline/late response, reply identities, refresh-only
retry, conflicts, moved drafts, removed items, offline editing and date changes.
The first browser run passed the recovery flows before exposing the long-title
layout failure. Final exported-app browser verification is recorded below.

Phase 2 remains 67/79. These checks cover the native item editor, not the broad
product-wide gates. Remaining native rundown work includes ProPresenter commands,
stage messages/display controls and export/share recovery. No deployment,
release, remote migration, external mail or real-org writes. Twenty necessary
tracked Markdown files remain; none were added.
Stack gate: #282 exact head 0b357d615ed97a386c4c571e9f713e6bd7f7ce31 passed
both jobs in CI 42571440609 before this draft opens. This draft's exact-head CI
must pass before another PR opens.

Final native verification passed typecheck, lint (18 existing warnings, zero
errors), iOS/Android/web exports, Expo Doctor 18/18, API contracts and polling
checks. Hermes bundles: iOS 6,017,212 / Android 6,016,283 bytes. Import placement
was corrected after the first verification to avoid adding a lint warning.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-rundown-items.mjs`
uses exported Expo web with disposable real auth, D1 and RundownRelay. It holds
an accepted update reply until the native deadline, retries the identical
request, fails the subsequent read and retries only that refresh. A second
client edits while a request is held before delivery; the original edit conflicts,
retains its fields and requires explicit current-item review. Another change
invalidates that review. Move preserves unsaved text, confirmed discard works,
and an Add retry produces exactly one section with zero duration. Draft fields
survive close/reopen and navigation. 320x480, 768x1024 and 1440x1000 checks cover
44px+ unobstructed controls, no horizontal overflow, and the complete 482-character
title retained after closing and resuming the bounded editor. Browser2 and final browser3 exited zero; screenshots were inspected. This proves exported-web behavior, not physical iOS/Android operation.

Logs: /tmp/showpilot-item-{before,unit1,unit2,worker1,mobile-tsc1,full1,full2,full3,tsc1,build1,verify1,verify2,verify3,verify4,verify5,verify6,browser1,browser2,browser3}.log.
Screenshots: /tmp/showpilot-native-item-{uncertain,review,long-title}-{320,768,1440}.png.

### Phase 2: native stage-message drafts and outcome recovery (2026-11-09)

The disposable browser regression reproduced an incoming relay message replacing
an operator's unsent stage text. Native stage messages now keep a draft, including
priority, per account/workspace/show for the signed-in app session. The current
or last-known displayed message is separate. Incoming updates and navigation do
not overwrite the draft. Explicit review precedes Send, Clear and replacing the
draft with the current message; a changed rundown revision, date, actor, show,
message or access invalidates that review. Clear preserves unsent text.

Send and Clear use the authenticated mobile `/rundowns/:showId/stage` endpoint
and the existing revision-checked RundownRelay single writer. The endpoint accepts
only those two actions, derives edit/control authority from current permissions,
and preserves control-only production-manager and edit-only grant access without
granting item editing or timer control. The relay still verifies the live session
and PIN. Unknown outcomes retain their original ID/message/revision with a
15-second deadline and explicit retry; a refresh failure retries only the read.
Duplicate retries cannot overwrite or clear a later operator's message. The
existing bounded relay command history still applies: an old request outside
that history conflicts against its original revision instead of replaying.
Deploy the expanded mobile API contract before releasing this native client.
No database migration or direct stage-message writer was introduced.

Moved the existing stage-message encoder/decoder into `@showpilot/shared`, migrated
both web callers and the codec test, and removed the old web module. Native and
web now interpret the priority marker with the same functions. Native inputs and
priority controls have explicit labels and checked state. An incoming 2,000-character
message remains retained, but the editor explains its 1,980-character limit and
blocks Send until shortened. This is navigation recovery in memory, not persistence
through app termination or a claim that every physical display received an update.

Verification: final full suite passed 3,279 unit + 1,702 Worker = 4,981 tests.
The first full run exposed a new test fixture sharing a mutated revision between
permission scenarios; independent per-test workspaces/shows fixed the fixture,
with all permission assertions retained. Web and shared typechecks and the web
production build passed. Main bundle: 542,230 raw / 171,073 gzip bytes, within
unchanged budgets. Native verification passed typecheck, lint (18 existing
warnings, zero errors), iOS/Android/web exports, Expo Doctor 18/18, contracts and
polling checks. Hermes bundles: iOS 6,031,075 / Android 6,030,167 bytes.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-stage-message.mjs`
passed against exported Expo web with real disposable auth, D1 and RundownRelay.
It covers the original incoming-update draft loss, navigation retention, explicit
Send/Clear/Replace review, invalidated reviews, delayed accepted replies, identical
send and clear retries, preservation of later messages, a held-before-delivery
clear conflicting with another writer, separate refresh failure/retry, priority
state, long messages and over-limit draft recovery. At 320x480, 768x1024 and
1440x1000, action controls remain unobstructed and at least 44px, with no horizontal
overflow. Browser1 exited zero and screenshots were inspected. This is exported-web
behavior proof; physical iOS/Android behavior remains outside this rehearsal.

Logs: /tmp/showpilot-stage-{before,unit1,worker1,route2,mobile-tsc1,full1,full2,tsc1,shared-tsc1,build1,verify1,browser1}.log.
Screenshots: /tmp/showpilot-native-stage-{uncertain,clear-review,long-review,overlong}-{320,768,1440}.png.
Phase 2 remains 67/79; the broad product-wide gates remain open. The native
ProPresenter command path still creates a fresh relative-command ID per request,
and its output toggle writes the org setting directly; those need separate
outcome/retry work. Native export/share recovery also remains. No deployment,
release, remote migration, external mail or real-org writes. Twenty necessary
tracked Markdown files remain, with none added.
Stack gate: #283 exact head c216a8fa7f2800617dd8203c7e0b9367086da7e6 passed
both jobs in CI 42574525613 before this draft opens. This draft's exact-head CI
must pass before another PR opens.

### Phase 2: native ProPresenter command receipts (2026-11-09)

The mobile API previously generated a new Bridge command ID on every request.
After a lost reply, another request could advance again without establishing
whether the first Next had already reached ProPresenter. Native slide controls
now retain the original account/workspace/show/request identity and show a
bounded pending state, confirmed result, rejection, or uncertain outcome.
Checking status reads that request's receipt and never dispatches another slide
command. After uncertainty, the operator must explicitly check the output before
starting a new action. Clear requires a visible confirmation; Previous slide and
Next slide remain single-tap controls with distinct accessible labels. Retention
covers navigation during the signed-in app session, not app termination.

The mobile prepare/execute/check contract delegates to the org-scoped BridgeRelay.
A durable receipt is written before dispatch and binds the actor, show, command,
selected installation and ProPresenter configuration fingerprint. Live session,
PIN/control permission, show existence, configured target approval and cue-control
settings are rechecked at execution. Retries and object eviction cannot replay a
claimed relative command. A crash or missing device acknowledgement remains
uncertain rather than being reported as a definite failure or success. Receipts
use existing Durable Object storage and are retained for deduplication; no D1
migration or new service is required.

The Bridge prepares a five-second reservation using its own monotonic clock,
then consumes it before touching ProPresenter. Server and Bridge clocks need not
agree. A delayed command, duplicate execution, changed payload, connection
replacement, disconnect or ownership handoff cannot reuse the reservation.
Reconnecting with identical ProPresenter settings preserves it. The adapter checks
expiry before each fallback mutation endpoint; its existing rule against trying
another endpoint after a lost HTTP response remains intact. ProPresenter's reply
confirms its API command, not what a physical screen displayed.

Deployment dependency: deploy the receipt API and update Desktop/Bridge's bundled
Bridge before distributing this native client. Older Bridges cannot acknowledge
reservation messages and fail closed without a slide command. Older native
clients sending only `{command}` receive an explicit update-required error;
coordinate the client rollout instead of expecting the previous blind-command
contract to remain available. No deployment or release was performed here.
The native stage-display toggle and the web ProPresenter controls remain separate
recovery work; this change does not claim those paths are complete.

Verification: full web suite passed twice after migrating the old control tests:
3,297 unit + 1,712 Worker = 5,009 tests. A final expired-preparation message
correction and added regression passed all 25 focused unit/hook/API tests. Worker
coverage exercises real auth, D1, socket dispatch, durable receipts after eviction,
permission/session/configuration/cue-control changes, removed shows and strict
identity matching. All 158 Bridge tests passed, including real localhost sockets
and a ProPresenter HTTP stub proving one mutation per reservation, unchanged
reconnection, configuration replacement and ownership handoff. No real equipment
or production workspace was used.

Web and Bridge typechecks and production build passed. Main bundle remains
542,230 raw / 171,073 gzip bytes within unchanged budgets. Final native verification
passed typecheck, lint (18 existing warnings, zero errors), all three exports,
Expo Doctor 18/18, contracts and polling checks. Hermes: iOS 6,038,976 / Android
6,038,080 bytes.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-propresenter-command.mjs`
passed and exited zero. It exercises the compiled Expo web controls with a local
command-receipt stub and real disposable Worker authentication/rundown hydration.
Lost accepted replies, failed status reads, explicit Clear review, uncertain
outcome acknowledgement and late preparation are covered. Status checks add no
mutation. At 320x480, 768x1024 and 1440x1000, controls remain unobstructed, at least
44px and within the viewport. Screenshots were inspected. This is exported-web
behavior proof, not physical iOS/Android or external ProPresenter verification.

Logs: /tmp/showpilot-pp-{unit1,unit2,unit3,worker1,worker2,worker3,route1,route2,bridge1,bridge2,full1,full2,full3,tsc0,tsc1,bridge-tsc0,bridge-tsc1,mobile-tsc0,build1,verify1,verify2,browser1}.log.
Screenshots: /tmp/showpilot-native-propresenter-{ready,clear-review,lost-reply,uncertain}-{320,768,1440}.png.
Phase 2 remains 67/79. Twenty necessary tracked Markdown files remain; none added.
Stack gate: #284 exact head 0ea5b60c1abe66b648a46fdbf13ea5aa518815a8 passed
both jobs in CI run 42576928882 before this successor was opened.


## Phase 2 web ProPresenter command recovery (2026-11-09)

Web slide controls now use the same prepared, once-only command receipt as the
native controls in #285. Previously, navigating away erased an uncertain result
and another action generated a fresh Bridge command ID. A regression reproduced
that loss before the fix (8 passed, 1 failed). The web hook now retains the original
account/workspace/show/request identity in the signed-in query cache. Status
checks read that receipt without sending another slide command. Navigation and
show/target changes cannot erase uncertainty; account/workspace caches are
isolated. Retention does not cover a full reload or application termination.

Preparation/execution has a 20-second client deadline; status checks have a
12-second deadline. Late preparation cannot execute after timeout, navigation,
changed scope, lost control permission or disabled cue control. The existing
server/Bridge reservations enforce expiry and duplicate rejection. The web RPC
checks fresh account/session/PIN/control authority and delegates to BridgeRelay.
The command schema moved into a direct shared-package export; all native/server
callers migrated, and the former native-only module was removed.

Clear now requires a visible confirmation that is invalidated if the account,
show or target changes. Previous slide and Next slide remain single-click, with
distinct labels and 44px minimum targets. Control-only operators can enable the
local preview and use slide controls. Missing show identity explains why controls
are disabled. The output toggle retains an uncertain result across navigation,
but its server-side revision/recovery work remains outstanding.

Verification: full web suite passed twice, 3,310 unit + 1,716 Worker = 5,026 tests.
Real-auth Worker tests cover control-only access, strict input/actor/organization
binding, revoked session/permission, removed shows and once-only dispatch. Web
and shared typechecks, Bridge build and frozen offline install passed. Final web
build: 542,230 raw / 171,089 gzip bytes under unchanged budgets. Native verification
passed all three exports, Doctor 18/18, contracts and polling checks, with 18
existing lint warnings and zero errors. Hermes remains 6,038,976 iOS / 6,038,080
Android bytes. Formatting-only cleanup of the new confirmation test passed all
three focused tests.

The built-app rehearsal passed twice, including after the final scope changes:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-propresenter-feed-recovery.mjs`.
It uses disposable auth/D1 and a protocol-compatible Bridge fixture with the real
compiled reservation class. Lost replies after execution, failed read-only status
checks, SPA navigation, uncertain Clear, Cancel and late preparation cause no
additional slide commands. Existing feed retention/reconnection, import retry and
kiosk error checks still pass. At 320x480, 768x1024 and 1440x900, confirmation and
recovery targets are unobstructed, at least 44px and within the viewport; screenshots
were inspected. This is not physical ProPresenter or native-device proof.

Rollout still requires the receipt API and updated Desktop/Bridge from #285 before
clients use these controls. No deployment, release, migration or real-org write
was performed. Parent #285 exact head 0355f7bfe7a213848934c35c953f085c313c795d
passed both CI jobs in run 42580714565 before this successor. Phase 2 remains
67/79; these are partial proofs for product-wide requirements. Twenty necessary
tracked Markdown files remain, with none added.

Logs: /tmp/showpilot-webpp-{before,unit1,worker1,full1,full2,tsc2,tsc3,shared1,build1,build2,verify1,bridge-build1,install,controls2,controls3,browser1,browser2}.log.
Screenshots: /tmp/showpilot-web-pp-{lost-reply,clear-review,uncertain}-{320,768,1440}.png.


## Phase 2 native ProPresenter output recovery (2026-11-09)

The native stage-display toggle used a boolean initialized once from the show
loader, an unbounded mutation and an alert claiming that failed replies meant no
change. A real D1 regression also found that its SQL inserted nonexistent
`createdAt`/`updatedAt` columns on `app_setting`; mocked route tests missed this.
The first real-database run failed both output cases on that schema error.

The native control now reads the workspace output state, requires an explicit
Show/Hide confirmation, retains its original account/workspace/request across
navigation and offers recovery of that same request. It distinguishes saved,
conflicting, expired and superseded outcomes from an unconfirmed reply. Reads
expire after eight seconds, command waits after fifteen, and refresh failures
have their own retry without another write. Polling stops on screen blur or read
failure. Confirmation invalidates on changed scope, access or output revision;
retention covers navigation during the app session, not app termination.

The new `/api/mobile/v1/propresenter/output` GET/POST contract uses shared strict
schemas. A D1 transaction claims the request, compares the workspace-wide output
revision, writes the desired boolean and advances the revision together. Original
receipts are retained for deduplication. Expired or excessively future-dated first
deliveries become terminal without writing output; retries cannot resurrect them.
The client normally allows five seconds for first delivery. Fresh membership,
session, role/grant and PIN configuration are guarded at the write boundary.
Existing Settings, rundown/Companion and fallback writers also advance this
revision. A second before-fix regression demonstrated a stale review overwriting
a Settings change away and back; it now returns conflict.

A saved setting is reconciled through an authenticated internal request to the
active show relay. It reads the latest setting, persists the resulting slide,
advances the room revision and broadcasts to connected displays. Lost delivery
acknowledgements can retry this reconciliation without rewriting the setting.
Failed reads no longer silently turn output off. Real read-only display-socket
coverage proves a held lyric appears and disappears without another slide event.
The relay keeps this reconciliation in its existing single-writer queue.

Rollout: deploy the new API/relay before distributing this native build. The old
show-scoped boolean endpoint now returns an update-required response; the old
native helper was removed. No D1 migration, deployment, release, real-org write
or external-device command was performed. Web output controls still use their
existing recovery UI; migrating those controls to the receipt contract remains
separate work. This does not close the product-wide UX gate.

Verification: full web suite passed twice, 3,316 unit + 1,729 Worker = 5,045 tests.
Final additional focus/PIN/writer assertions passed 26 focused unit tests and all
16 output Worker tests. The configured-PIN test uses the same 15-second integration
budget as the existing Worker PIN crypto suite because it performs multiple real
PBKDF2 checks; request deadlines remain unchanged. Coverage includes read/write
permissions, original actor/workspace binding, permission revocation at commit,
Settings/Companion/fallback revision changes, lost relay replies, expiry, changed
payloads, navigation retention and bounded reads. Web/shared/native typechecks
and web production build pass. Main bundle remains 542,230 raw / 171,089 gzip bytes.

Native verification passes all three exports, Expo Doctor 18/18, contract and
polling checks, with 18 existing lint warnings and zero errors. Hermes bundles:
iOS 6,050,267 / Android 6,049,384 bytes, within unchanged 6,500,000-byte budgets.
The compiled Expo web rehearsal passed and exited zero:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-native-propresenter-command.mjs`.
Its output tests use the real disposable Worker/D1 API with lost-reply, failed-read
and delayed-delivery injection. Original request recovery preserves a later
operator's state; navigation retains uncertainty; delayed delivery expires without
changing output. Existing slide-command recovery tests still pass against their
local receipt stub. At 320x480, 768x1024 and 1440x1000, confirmation and recovery
targets are unobstructed and at least 44px, without horizontal overflow. Screenshots
were inspected. This does not establish physical iOS/Android or ProPresenter behavior.

Parent #286 exact head 39d795fae0e29ae3fee463013135d696a2e0bb5b passed both CI jobs
in run 42584267748 before this successor. Phase 2 remains 67/79. Twenty necessary
tracked Markdown files remain; none added.
Logs: /tmp/showpilot-output-{before,before-settings,unit3,unit4,worker4,worker7,full2,full3,tsc3,tsc4,shared1,build1,verify2,browser1}.log.
Screenshots: /tmp/showpilot-native-propresenter-output-{review,lost,refresh-error}-{320,768,1440}.png.

### Native output CI repair: one PIN verification per request (2026-11-09)

Run 42588931063 failed the configured-TM-PIN test: a valid output command
returned `expired` instead of `applied`. The mobile handler verified the same
210,000-iteration PIN in its generic authorization and again in the shared output
authority. On the coverage runner those two checks consumed the five-second
command lifetime. The endpoint now checks identity first and delegates live
permission/PIN verification to the shared output authority once. Typed access
failures preserve the 401 PIN challenge and 403 denial. The transaction still
checks the exact session, role/grant and PIN configuration; changing the PIN
between verification and commit rejects the write. No hash work factor, command
expiry, client timeout, or integration-test timeout was increased.

Validation: full web suite passes 3,317 unit + 1,733 Worker = 5,050 tests.
All 17 output Worker tests also pass under Istanbul coverage, including exact
PIN-verification call counts and the new PIN-change-at-commit regression.
Web typecheck and production build pass; main stays 542,230 raw / 171,089 gzip.
The PIN boundary unit test now supplies a valid output command so it tests the
PIN gate rather than an obsolete malformed payload. No deployment or release.
Logs: /tmp/showpilot-output-ci-{pin1,full2,coverage1,tsc1,build1}.log.

### Web ProPresenter output receipt migration (2026-11-09)

Rundown and Settings now use the same dedicated workspace-output receipt contract
as the native client. Each surface checks its own live permission: rundown edit
or control (including the configured TM PIN), or Settings integrations permission.
The old web boolean RPC/fallback writer and generic editable output key were
removed; generic Settings saves can no longer bypass output receipts. Companion
continues to advance the shared revision through the relay.

Both Show and Hide require review against the current output revision. A lost
reply retains the exact actor, workspace, request ID, desired value, revision and
expiry through SPA navigation, including Rundown → Settings. Reads stop after
eight seconds; commands after fifteen seconds. Recovery cannot overwrite a later
output change, and a saved command's failed refresh retries only the read.
Conflict, expired and superseded results require review before another change.
Changing account/workspace isolates retained work. Retention covers navigation
within the current browser session, not a page reload or browser termination.

Validation: full web suite passes 3,336 unit + 1,738 Worker = 5,074 tests; web
typecheck and production build pass. Main bundle is 542,176 raw / 171,049 gzip
bytes under unchanged budgets. Tests cover concurrent surface actions, revision
changes during confirmation, cancellation, bounded reads/writes, identity-mismatched
replies, navigation retention, permission/session revocation, strict payloads,
generic Settings rejection and the original slide-control recovery behavior.

The built browser/real disposable Worker rehearsal passed and exited zero:
`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-propresenter-feed-recovery.mjs`.
It loses an output reply after the actual D1 commit, changes output through the
native API, navigates to Settings without reloading, and recovers the original
request without replacing that later value. A failed read after recovery retries
without another POST. Both output directions require confirmation; Cancel sends
nothing. Existing slide/import/feed recovery checks still pass against the
protocol-compatible Bridge fixture. Confirmation/recovery targets are reachable
and at least 44px at 320x480, 768x1024 and 1440x900 without horizontal overflow;
screenshots were inspected. No physical ProPresenter or production writes.

Parent #287 CI repair is pushed as 995a5515289b74ac5626aace2a289b02515d5cde,
run 42591572155. Its exact-head CI must pass before opening this successor PR.
Phase 2 remains 67/79; this is partial evidence for the product-wide gates.
No deployment, release or migration. Twenty necessary Markdown files remain.
Logs: /tmp/showpilot-weboutput-{unit1,worker1,ui2,full2,tsc2,build1,browser2}.log.
Screenshots: /tmp/showpilot-web-pp-output-{review,lost,refresh,hide-review}-{320,768,1440}.png.

### Web output CI test isolation (2026-11-09)

Run 42593570002 reached all Worker tests but timed out after 15 seconds in the
combined TM PIN test. That case generated a PIN hash and then checked several
requests, accumulating four expensive PBKDF2 derivations in one deadline. The
existing crypto suite independently tests hash creation and compatibility.
The output integration now uses the existing 210,000-iteration fixture hash and
six independent read/write cases: missing, wrong and correct PIN. Each asserts
exactly one real verification per API request; rejected writes preserve storage,
and the valid write must apply within its original five-second command deadline.
No production code, PIN work factor, command expiry or test timeout was relaxed.
All 21 output Worker integration tests pass under Istanbul coverage after this
change (`/tmp/showpilot-weboutput-ci-split2.log`). The CI rerun remains the
required check before a successor PR is opened.

### Web Chat message acknowledgement and notification recovery (2026-11-09)

Web chat previously started crew notifications before the relay acknowledged the
message. Reaction notification failures also rejected the completed reaction,
encouraging another toggle. The web adapter now starts notifications only after
matching message/reaction acknowledgement and tracks notification work separately.
Message acknowledgement stops waiting after eight seconds; Retry send retains the
original message identity. Notification requests stop after fifteen seconds and
retry the original command without sending a message or toggling a reaction again.
The inbox endpoints already deduplicate partial/lost-reply retries without
resetting read or dismissed state. Both clients now import one shared notification
contract; the old web notification RPCs and native-local duplicate were removed.

Notification work is scoped to actor, workspace and room and survives SPA
navigation in the current browser session, including pending replies. It is not
persisted across a full reload or browser termination. Errors, timestamps and
notification-only retries appear above the composer in a bounded scroll region.
The composer retains its draft or poll if enqueue fails, and a full outbox no
longer silently evicts an earlier message. Removing a local queued copy requires
confirmation that explains it cannot retract an already accepted server message.
Send and recovery buttons meet 44px. Receipt request IDs remain valid UUIDs on
HTTP/LAN origins and for older queued message IDs; notification text respects the
relay's 4,000-character storage limit.

Validation: full web suite passed 3,354 unit + 1,743 Worker = 5,097 tests. After
adding the queue-capacity regression, all 100 focused chat/identity tests passed.
Web/shared typechecks and production build passed; main bundle 542,252 raw /
171,024 gzip bytes under unchanged budgets. Native verification exported iOS,
Android and web, passed Expo Doctor 18/18 and the polling boundary; Hermes bundles
were 6,050,266 / 6,049,386 bytes. These exports are not physical-device proof.

`SHOWPILOT_SMOKE_RUNTIME=miniflare node apps/web/scripts/smoke-web-chat-delivery.mjs`
passed against a compiled Worker, real local auth, ChatRelay and disposable D1.
It loses the actual message acknowledgement, verifies one saved message after
same-ID retry, injects a partial inbox failure, navigates between rooms, retries
only notifications and preserves existing read/dismissed state. A second case
loses a successful inbox reply and recovers without duplicate messages or inbox
rows. No external email is sent. At 320x568, 768x1024 and 1440x900, recovery targets
are reachable and at least 44px, with no horizontal overflow. Screenshots were
inspected after waiting for responsive sidebar transitions. The first browser
run caught a 36px Send button; it was corrected and the component tests and build
rerun before the successful rehearsal.

Remaining chat work includes acknowledgement recovery for edit/delete/vote/reaction
mutations themselves, attachment uploads/discards and native media preparation.
This change handles message and notification delivery, not all chat operations.
Phase 2 remains 67/79. Twenty necessary Markdown files remain. No deployment,
release, remote migration or real organization data change.
Parent #288 repair: 8f2a31c191287f5ee725f655240bd436aa31c416, CI run 42595830192;
its exact-head CI must pass before opening this successor PR.
Logs: /tmp/showpilot-webchat-{full4,unit5,ui6,tsc1,shared1,build2,native1,browser3}.log.
Screenshots: /tmp/showpilot-webchat-{message,notification}-{320,768,1440}.png.

### 2026-11-09: recover chat edits, deletes, reactions and poll votes

On `fix/chat-mutation-receipts`, a shared command contract and retained tracker
replace blind chat mutations in web and native clients. Each command captures
actor, organization, room, message, request ID, deadline and the original edit or
vote state. The relay commits the message and receipt in one SQLite transaction.
Recovery returns that receipt and the current projection; it cannot toggle a
reaction again, overwrite a later edit, restore an earlier vote or delete again.
First deliveries expire; membership is rechecked before returning a receipt.

Unconfirmed work survives navigation within the running app, has an eight-second
acknowledgement deadline, and blocks another mutation on that message until its
outcome is recovered. The panel shows the captured action, timestamp and retry or
review controls. Captured edit versions and newer drafts are preserved. Web row
actions are visible and 44px; native message actions have a labeled 44px button
that works with the keyboard. Native reaction pickers close on submission so they
cannot cover pending status or failure. Recovery areas scroll and shrink to keep
the web composer reachable at 320x568.

Deletion is durable before attachment cleanup starts. Cleanup has a five-second
bound and its own recovery state. A persistent opaque file-ID marker prevents a
concurrent attachment validation from saving a reference to a deleted file, and
live references are checked after the last storage await. Account deletion
includes mutation receipts and pending attachment cleanup; it rereads current
messages before scrubbing so cleanup cannot restore an old snapshot. History
clearing erases stored edit drafts and prevents replay from storing them again.

Validation: full web suite passed 3,377 unit + 1,760 Worker = 5,137 tests. One
existing automation regression initially failed because it used the old delete
protocol; it now verifies the same no-resurrection invariant with the new command.
The 28 ChatRelay tests include stale versions, actor/room/org mismatch, expiry,
altered retries, revoked membership, eviction, independent reactions, receipt
erasure, failed R2 cleanup and a delayed attachment validation. The race fixture
runs inside the Durable Object context to avoid a cross-context Workers runtime
crash. After responsive adjustments, 20 ChatPanel tests passed; native recovery
and tracker tests passed 56/56. Web/shared/native typechecks passed.

Web production build passed at 542,252 raw / 171,037 gzip bytes under unchanged
budgets. Native verification exported iOS, Android and web and passed Expo Doctor
18/18 and polling boundaries; Hermes bundles were 6,068,609 / 6,067,776 bytes.
These exports and the compiled native web rehearsal are not physical-device
proof. A subsequent cleanup removed only a redundant callback dependency.

Both `smoke-web-chat-mutations.mjs` and `smoke-native-chat-mutations.mjs` passed
against built clients, real disposable authentication and ChatRelay. They lose
actual replies after commit, navigate rooms and recover the exact original
commands. Web covers edit/reaction/delete recovery; native covers edit/reaction
recovery and keyboard message actions. At 320x568, 768x1024 and 1440x900, recovery
controls are reachable and at least 44px with no horizontal overflow. Screenshots
were inspected. The web rehearsal caught the short-screen composer clipping,
which was fixed before rerunning. The native rehearsal waits for the room picker
to finish closing before operating the next modal and passed twice consecutively.

Compatibility: old blind mutation frames return an explicit update-required
error. Coordinate server and app updates. Retained recovery is in memory and does
not survive browser reload or process termination. Attachment uploads/discards,
native media preparation and the remaining product-wide UX audit are still open.
Phase 2 remains 67/79; twenty necessary Markdown files remain. No deployment,
release, remote migration or real organization data change.
Parent #289: a24ebe86b130b3802d581bd6a53a5dd35b8bca0e, both CI checks green.
Logs: /tmp/showpilot-chat-mutations-{full2,worker5,unit2,ui3,tsc5,shared2,build2,native3,native-unit3,native-tsc4,browser2,native-browser6}.log.
Screenshots: /tmp/showpilot-web-mutation-{edit,delete}-{320,768,1440}.png and
/tmp/showpilot-native-mutation-{edit,reaction}-{320,768,1440}.png.

## 2026-11-09 — Chat attachment recovery (not deployed)

Branch `fix/chat-attachment-recovery` follows #290. The web UI previously removed
an attachment before its DELETE succeeded and silently discarded files on
unmount or when starting an edit. Two UI regressions reproduced those failures.
Uploads had no stable identity, so retrying a lost response could create another
file. The Worker checked message references separately from storage deletion,
allowing a new message to reference a file during removal. Native upload HTTP
already had a 60-second deadline; preparation, selection and file removal still
needed recovery and correct conversation ownership.

Web and native now share a retained attachment state machine keyed by account,
organization and room. It reserves capacity before preparation, retains each
file's identity and prepared source for retry, and shows timestamped upload and
removal failures. Preparation/upload is bounded to 60 seconds; cancellation to
15 seconds. Removing a file before preparation finishes prevents publication
from its late result. Outbox handoff protects selected files and consumes only
that captured selection after enqueue succeeds. Navigation does not discard
attachments, and starting a web message edit preserves unsent files. Native
text/poll/reply drafts retain their existing separate conversation ownership.

New uploads carry a UUID, canonical filename and SHA-256 checksum. R2 conditional
claims bind immutable metadata to the original actor/room, and R2 verifies the
checksum against uploaded bytes. Stable names are carried separately from
multipart filenames, including native multipart encoding. The room authority
checks live references and reserves cancellation without an intervening await.
Zero-byte deletion markers prevent late conditional uploads from recreating
removed content; cancellation works even before the original upload arrives.
File reads check logical deletion as well as storage state. Account erasure still
physically removes owned files, claims and markers through the existing prefix
purge. Legacy uploads remain accepted; new native clients need this server
update before rollout.

Native selection and HEIC preparation are bounded and ignore late results after
navigation. Retries reuse the prepared JPEG and checksum. File opening/sharing
has a bounded failure path; image previews time out with an explicit Retry.
Web recovery cards share one scrollable area above the composer. This fixes a
320px heading clip discovered in screenshot review; a shorter placeholder and
an explicit room label keep the composer compact and accessible. Native image
error text uses the appropriate foreground for its always-dark viewer; the
browser check verifies contrast and a 44px retry target.

Validation on the final frozen dependency set: full web suite passed 3,400 unit
+ 1,774 Worker = 5,174 tests. The dependency addition is only mobile's pinned
`@noble/hashes` 2.3.0; incidental lockfile resolution changes were removed and a
forced frozen install restored the original auth dependency graph before the
final suite and rebuild. Web/shared typechecks passed. Final native verification
includes typecheck, iOS/Android/web exports, Expo Doctor 18/18 and polling checks;
Hermes bundles are 6,130,778 / 6,129,895 bytes. Final web build is 542,252 raw /
171,028 gzip bytes under unchanged budgets. The final native change after the
full suite adjusts only image-viewer colors and retry sizing; verification and
the image recovery rehearsal were repeated for it.

`smoke-web-chat-attachments.mjs` and `smoke-native-chat-attachments.mjs` pass
against compiled clients with real disposable auth, ChatRelay and R2. They lose
actual upload/removal responses after storage completes, navigate rooms, retry
the original identity, verify stored bytes/deleted availability, and send an
attachment. Web also cancels a request before it reaches storage. Native also
stalls a real image read, waits for the preview deadline and successfully retries.
320x568, 768x1024 and 1440x900 checks verify reachable 44px recovery controls,
visible composer and no horizontal overflow; final web checks also require the
heading and filename to remain visible. Screenshots were inspected. The existing
web mutation rehearsal still passes edit/reaction/delete acknowledgement recovery
with the shared recovery area. Harness fixes wait for hydrated file inputs and
target the message's Open attachment control rather than duplicate filename text
in the delivery status.

Recovery is in memory for the app session; reload/process termination and physical
native device behavior are not proven by these exports/browser checks. The native
fixture still reports its live-rundown state as unavailable. Web text/poll draft
retention across room navigation and the remaining product-wide UX audit are
still open. Phase 2 remains 67/79. Twenty necessary Markdown files remain. No
production deployment, release, remote migration or real-organization writes.
Parent #290 head 15ff6dd2e9d7c5fed0221ab00b3a3d90770ad70a has both CI checks green.
Logs: /tmp/showpilot-chat-attachments-{before1,full3,worker3,unit3,ui5,tsc8,shared3,build4,native3,browser6,native-browser4,mutation-browser1,frozen-force}.log.
Screenshots: /tmp/showpilot-{web,native}-attachment-{upload,removal}-{320,768,1440}.png
and /tmp/showpilot-native-attachment-preview-timeout.png.

### Phase 2 follow-up: conversation composer retention

Web chat kept text, message type, reply, edit, and poll drafts inside `ChatPanel`, whose conversation key unmounts it on room changes. Native chat retained its composer, but both clients overwrote an unfinished message when opening an edit and discarded it on cancellation. A delayed web poll enqueue also reset newer poll typing. Two rendered regressions reproduced the edit-cancellation and delayed-poll failures before implementation (22 existing tests passed, 2 new tests failed in `/tmp/showpilot-composer-before.log`).

`packages/shared/src/chat-composer.ts` now owns separate new-message, edit, and poll sections. Both clients use that model; completion clears only the exact submitted section, so poll typing cannot resurrect an already queued message and a late completion cannot erase newer text, reply/type choices, or an edit. Cancelling or completing an edit restores the underlying unsent message and reply. A conversation-wide send lock survives unmounts and simultaneous views. Web registries are scoped to organization, room, and member or full guest pass/name; server rendering and unidentified users do not share a registry. Native registries belong to the QueryClient and account/organization/room, with inactive view setters ignored. Removed the old native composer field/clear API after migrating sends to the shared operation. All web chat consumers, including Show Flow and guest chat, receive the scoped composer.

Poll fields have labels, message-type/poll/reply controls retain 44px targets, and long polls scroll without pushing the message input or modal Send button outside short windows. Browser review caught a 320px attachment regression after increasing toolbar targets: scrolling Retry into view clipped the filename. Reducing surrounding padding restored both the filename and recovery action without shrinking buttons. Web poll space can expand to half the panel on larger screens. The attachment rehearsal now captures its screenshot before geometry assertions so future failures preserve the actual failed state.

Validation:

- Full web command passed 3,413 unit and 1,774 actual Worker tests (5,187 total), including the parent PR's CI fixture correction: `/tmp/showpilot-composer-full3.log`. Final spacing-only changes also passed all 26 rendered chat-panel tests (`ui4`). Web/shared typechecks passed (`tsc3`, `shared2`). Final web build (`build3`) passed at 542,252 raw / 171,033 gzip main bytes; limits remain 600,000 / 175,000.
- Mobile verification (`native2`) passed lint/typecheck, iOS/Android/web exports, Expo Doctor 18/18, and polling boundaries. Hermes bundles: 6,135,818 iOS and 6,134,964 Android bytes, under the unchanged 6,500,000 limit. The existing parity inventory remains 20 complete / 1 missing; exports are not physical-device proof.
- Compiled web rehearsal (`browser3`) passed with real disposable authentication/ChatRelay: separate production/planning drafts, edit draft retention across rooms, cancellation restoring an unsent announcement, six-option poll retention, and existing edit/reaction/delete lost-response recovery. Compiled native-web rehearsal (`native-browser3`) passed the corresponding draft/poll/edit/reaction checks. Both verified 320×568, 768×1024, and 1440×900. The initial native rehearsal focused a message action before the poll modal finished its closing animation; diagnostics showed the closing modal still owned focus. Waiting for the actual modal to disappear fixed the test sequencing; no forced clicks or product focus bypass were added.
- Actual R2 attachment rehearsals passed after integration: web `attachment-browser2` covered lost upload/removal replies, cancellation before arrival, room return, filename visibility, and sending the original file; native `native-attachment-browser` additionally covered image-preview timeout/retry. Representative phone/tablet/desktop screenshots were inspected. Logs use the `/tmp/showpilot-composer-` prefix. No production organizations, deployments, or real crew notifications were used.

These are session-memory drafts, not reload/process-restart persistence. Phase 2 remains 67/79 verified; this is partial evidence for the broader UX and gate requirements, not Phase 2 completion. Necessary Markdown remains 20 files. The next read-only audit confirms that `useAssignmentWork.execute` can re-enter an old settled attempt from a stale retry closure after review because it checks only live pending flags, then overwrites the attempt cache unconditionally. Its caller embeds assignment ID in editor ID, so the snapshot key is not currently a cross-assignment collision; investigate/reproduce stale callback ownership next rather than claiming a key collision from the hook alone.

### Phase 2 follow-up: assignment editor ownership and legacy result honesty

Six focused hook regressions reproduced stale Retry/Review callbacks replacing a newer assignment attempt, old account/organization/editor callbacks writing drafts or submitting, and a confirmation submitting after unmount (`/tmp/showpilot-assignment-owner-before.log`). `useAssignmentWork` now binds user actions to an active editor instance, freezes the draft while an attempt exists, checks the expected attempt before claiming it, and publishes a completion only if its actual QueryClient cache object still owns that attempt. Review checks the exact rendered result; a confirmation captured before newer typing is rejected with visible review-and-save feedback. A started save still completes into its original cache after navigation; newer typing, another editor, and a newer cache owner remain intact. The assignment ID already forms part of the caller's editor ID, so no snapshot-key change was needed.

Two actual Worker/D1 regressions also showed older mobile assignment endpoints performing the requested edit/delete and then incorrectly reporting HTTP 409/404. Revision triggers write a second row, so `meta.changes === 1` was not evidence that the assignment itself changed. The legacy edit now reads `UPDATE ... RETURNING id`; the transactional deletion checks its `DELETE ... RETURNING id` result. Organization filters and revision tombstones remain effective. The current receipt-backed mobile command protocol and the older endpoints' response contracts are preserved. Real cross-organization edit/delete tests return 404 and leave the other organization's assignment unchanged. Outbound email in tests is captured or mocked, never sent to real crew.

Validation: final full web command passed 3,422 unit plus 1,778 actual Worker tests (5,200 total), including nine hook ownership regressions and four actual legacy-route/organization tests (`/tmp/showpilot-assignment-owner-full2.log`). Focused editor/hook/legacy unit tests passed 26 cases (`unit3`); web typecheck and production build passed (`tsc1`, `build1`), with 542,252 raw / 171,045 gzip main bytes under the unchanged limits. The compiled browser rehearsal (`browser1`) passed real local authentication and D1 create recovery after a lost reply, retained drafts across navigation, exact request retry without duplicate assignment or invitation, edit/delete conflict review, and partial team recovery at 320×480, 768×1024, and 1440×1000. The phone conflict-review screenshot was inspected. Native UI source was unchanged in this follow-up; the earlier composer exports remain the native build evidence.

PR #291's CI correction is green at cb96d18e335e60027754b98d665e210a0e7b6129 (run 42615743279). Composer draft PR #292 is at 27a94da1ff3be513fa6bc76ec515f2f90fc3a513, with CI run 42618508195 active when this entry was written. This assignment change waits for that exact-head CI gate before a successor PR. Phase 2 remains 67/79; no broad gate was closed by these targeted fixes. Necessary Markdown remains 20 files; no deployment or production-data mutation occurred.

Next audit: `WorkspaceRouteGate` and `WorkspaceSettings` both call unbounded workspace saves followed by router invalidation. The feature-enable route sends the whole module list from its rendered profile, so a stale view can undo another administrator's module choice. `profile.server.ts` changes a workspace revision but these UI writes do not compare it. Cover both workspace surfaces and the corresponding native path together. Desktop status actions in `components/layout/DesktopStatusBar.tsx` still need the bounded-operation and touch-target pass.

### Phase 2 follow-up: workspace change recovery

Workspace feature controls sent the entire rendered module list, allowing a stale page to undo another administrator's choices. Workspace custom-name fields also reset whenever the provider refreshed, including during editing. Web/native settings and their disabled-feature screens now send one intended operation against a reviewed workspace revision. The shared editor retains names, type/reset choices and frozen requests by QueryClient/account/organization; inactive or stale view callbacks cannot submit. Reads, saves and refreshes have a 12-second deadline. An uncertain save retains its original ID and offers retry or a server-side review; a confirmed save with a failed refresh retries only the refresh.

Migration `0092_workspace_change_recovery.sql` introduces receipts scoped to organization, actor and request. A D1 transaction records the immutable outcome, compares the workspace revision, writes all affected settings and updates the revision together. Repeating an ID cannot reapply it after a newer change; changing its payload is rejected. Review records cancellation if no save committed, fencing a delayed original request. Commit-time guards require a live session and the same authorized owner/admin membership. Type changes retain features unless reset was selected, and core features remain available. Both clients share the operation/result schemas. Existing initial setup and older compatibility endpoints retain their contracts and update the same revision: new clients detect their intervening writes, but this does not retrofit revision-aware editing into already-installed old clients.

Validation on the final application source:

- Full web command passed 3,444 unit and 1,791 actual Worker tests (5,235 total), including 10 shared-editor tests, 12 actual web/native hook ownership tests and 13 real Worker/D1/HTTP regressions (`/tmp/showpilot-workspace-full3.log`). The first run caught two test mocks returning extra command fields in a strict result contract; those mocks now return the real response shape. The second run passed all assertions but exposed an existing Radix focus-restoration callback firing after the SaveRundownModal test's jsdom realm closed. Its teardown now finishes the scheduled unmount task; the final full suite passed without that unhandled error.
- Web/shared typechecks passed (`tsc2`, `shared1`). Web build passed (`build1`): 549,872 raw / 173,400 gzip main bytes under unchanged limits. Mobile verification (`native1`) passed lint/types, iOS/Android/web exports, Expo Doctor 18/18 and polling checks. Hermes bundles are 6,157,874 / 6,157,007 bytes. The existing inventory remains 20 complete / 1 missing; exports are not physical-device proof.
- `smoke-workspace-recovery.mjs` and its `--native` mode passed against compiled apps and real disposable auth/D1 (`browser4`, `native-browser2`). They verify initial-read recovery, a lost reply after an actually committed save, the identical retry after another admin changes a feature, preservation of that newer change and explicit review. Web additionally verifies names retained across settings-section navigation, type/reset controls, and enabling Chat without restoring disabled Songs. Checks cover 320×480, 768×1024 and 1440×1000, reachable 44px recovery controls, no horizontal overflow, no browser errors and zero captured emails. Phone/tablet screenshots were inspected. Initial web harness failures came from a nonexistent Appearance section and duplicate case-variant Origin headers in its intercepted request; the harness now uses Organization and one normalized origin header. It waits for actual responsive transitions before inspecting screenshots.

The new receipt migration must precede deployment of these clients; no remote migration, deployment, release or real-organization write was performed. Drafts/requests survive navigation in the current app session, not reload or process termination. Phase 2 remains 67/79 verified, with twelve broad requirements still open. Necessary Markdown remains twenty files. Parent composer #292 is green at 27a94da1ff3be513fa6bc76ec515f2f90fc3a513 (run 42618508195). Assignment draft #293 is also green at exact head 85ffce913ea4e698a81df0ddb4ebae63aa5a9617 (run 42620830579), verified before opening this successor PR.

Next audit: DesktopStatusBar polls Bridge status with setInterval without waiting for its previous read, so slow replies can overlap and overwrite newer status. Most native window/Bridge invocations have no enclosing deadline; the updater check does already pass a 30-second timeout to its plugin, while download/install, resource close and restart can still remain unresolved. Local-device confirmation does not recheck its originating workspace after the dialog resolves. Address those boundaries without treating an installation timeout as proof it stopped or allowing a second installer to run.

### PR #294 rebase: migration 0092 applied and verified

On 2026-11-13T14:27:16.023615+00:00, applied only `0092_workspace_change_recovery.sql` to the configured `showpilot-db` after full local coverage/types/builds and both real fixture workspace rehearsals passed. Reviewed application source: `60ef3e98a9fa67011ba8e577d189ead2e2b145a8`; SQL SHA-256: `559caca99f275d328ba44fab44c7d926f43eff61b696c06f8972e09bec086997`. Verified database identity, saved a recovery bookmark privately and compared exact CREATE TABLE/check constraint, columns, composite key/index and cascading org/user foreign keys to the reviewed SQL. No organization records were read or changed by verification. The ordered production manifest now records 0092; no application deployment or release performed.

### Phase 2 follow-up: desktop action ownership and status recovery

Three rendered regressions reproduced overlapping Bridge status reads, a companion-window button stuck indefinitely on Opening, and a local-device confirmation executing after its workspace changed (`/tmp/showpilot-desktop-action-before.log`). Desktop status polling now schedules its next read after the preceding native promise settles. A 12-second deadline marks the status unavailable; an explicit read retry supersedes older results. Engine checks also have a visible deadline/retry.

Desktop window, local-show, Bridge, update-check and installation actions retain ownership in the native webview across component remounts. A UI deadline reports an unconfirmed command without claiming IPC stopped or permitting another copy of that pending action. Late success/failure updates the retained result. Unrelated controls remain usable. Installer uncertainty appears after 60 seconds and retains the lock until the underlying native call settles. Automatic and manual update checks share ownership. Local-device and updater confirmations recheck their originating view before starting; staged device setup also stops continuing after its deadline/navigation. Both enabling and stopping local-device mode require confirmation. The enable copy now matches the existing standby behavior rather than claiming an automatic active-Bridge takeover.

The existing updater check already supplied a 30-second plugin timeout. Its enclosing read is now bounded, as is metadata cleanup; cleanup failure cannot replace a real installation error or hide a known installed update. Download passes the plugin's supported 120-second timeout. After a confirmed install, a restart that does not reply within 12 seconds reports the manual quit/reopen path. No timeout claims that a native installer was cancelled. Pending action retention is limited to the current webview, not process termination.

Desktop actions and dismiss/retry controls have 44px targets. Browser screenshot review showed the enlarged controls crowding the workspace on a 320×480 window; the keyboard-focusable Desktop controls region now scrolls within 35dvh and uses 12px labels. The final rehearsal verifies at least 120px of operator workspace remains visible, checks controls and the full unconfirmed-install explanation are reachable, and inspects phone/desktop screenshots.

Validation: full suite passed 3,457 unit plus 1,791 actual Worker tests (5,248 total), `/tmp/showpilot-desktop-action-full1.log`. The subsequent layout/type-only correction passed all 40 focused runtime/device/status tests (`unit2`) and a final 14-case status-bar run (`ui3`). Web typecheck (`tsc2`) and final build (`build2`) passed: 553,877 raw / 174,869 gzip main bytes, below unchanged 600,000 / 175,000 limits. Native app source and Rust were unchanged, so no redundant native export run was performed.

`smoke-desktop-action-recovery.mjs` passed against the compiled web client with real local auth/D1 and the actual Tauri JavaScript updater adapter, using simulated IPC (`browser4`). It verifies serialized polling, a delayed window's honest pending state and late completion, independent local-show control, one unresolved installation, late installation acknowledgement/manual restart, and 320×480 / 768×1024 / 1440×1000 geometry. Its clock advances UI deadlines; unrelated fixture notification/live-rundown reads can report unavailable during those advances and recover. A harness-only iteration used a string predicate that Playwright evaluated through CSP-disallowed eval; function predicates now preserve CSP unchanged. Zero browser exceptions and captured emails; no real update, device command, release or deployment occurred. This is UI/adapter evidence, not physical native-engine proof.

Workspace draft #294 is green at exact head 5b4e19810c47530fd64d9713cc77261fb5592a3f (run 42623851525), verified before opening a successor. Phase 2 remains 67/79; the remaining requirements are broad product-wide audits/gates, not a count of PRs. Necessary Markdown remains twenty files. Next audit: incident-history controls and the remaining web Schedule positions/team/roster flows, followed by the terminology, confirmation and responsive sweep.

### Phase 2 follow-up: incident history filters and read recovery

Reproduced two rendered search races: a 350ms debounce restored an older status selection, and Clear filters let the pending query reappear. History navigation now patches the latest search state, and Clear resets the local search draft. Route reads receive cancellation; query/assignee/category lengths and page numbers are bounded at the URL boundary. Search, status, severity, category, sort, assignee and dates have accessible names, controls meet 44px, and status/severity defaults have distinct visible labels. The responsive filter grid scrolls with the page rather than covering results on a short viewport. Incident cards have keyboard focus styling and readable metadata/comment labels.

The compiled browser rehearsal exposed a hydration mismatch: SQLite CURRENT_TIMESTAMP lacks an offset and was interpreted as local time in the browser. A tested parser treats that legacy format as UTC and preserves explicit offsets. Both history and incident details use it; history starts with a deterministic UTC timezone before adopting the viewer's timezone after hydration.

Native history reads now use the existing cancellable operation deadline (10 seconds), with no automatic retry loop and an explicit Retry history button. Loading/error states no longer claim zero matching results; failed refreshes label retained results as last loaded, and loading/error do not coexist with an empty-state claim. Invalid calendar dates and reversed ranges retain the open filter draft with inline feedback. Native history targets, search input, filter sheet, card wrapping and operational text were checked at 320×480, 768×1024 and 1440×1000.

Validation: full web suite passed 3,463 unit + 1,791 actual Worker tests (5,254 total), `/tmp/showpilot-history-full2.log`. Final label-only change passed 13 focused history/incident/timestamp tests (`final-unit`). Web typecheck (`web-tsc3`) and final production build (`build4`) passed: 554,052 raw / 174,927 gzip main bytes against unchanged 600,000 / 175,000 limits. The initial test-only route-component export prevented automatic code splitting; tests now obtain the existing route component without exporting it. Native verification (`native2`) passed types, lint, iOS/Android/web exports, Expo Doctor 18/18 and polling checks; Hermes sizes 6,159,663 iOS / 6,158,791 Android bytes. Existing parity inventory remains 20 complete and 1 missing, not a physical-device claim.

`smoke-incident-history.mjs` and its `--native` mode passed with real local authentication/D1 and compiled clients (`browser4`, `native-browser1`). Web proves debounced filter preservation, Clear cancellation, keyboard history-to-details navigation and zero hydration errors. The harness waits for hydration before interacting with SSR controls. Native holds the initial real history response past the deadline, verifies one request without automatic retries, retries successfully, rejects invalid/reversed dates without a request, then confirms a real empty search. Both exercise 44px controls and no horizontal overflow at all three widths; screenshots were inspected. Zero browser exceptions or captured emails. No production data, deployment, release or migration was touched.

Desktop draft #295 is green at exact head 80fe0a2534819237b7888d6eddc2f9e4b3ef0a67, run 42627226577, before opening a successor. Phase 2 remains 67/79: this supplies evidence for broad requirements rather than claiming the product-wide gate is finished. Necessary Markdown remains twenty files. Next: remaining Schedule roster targets/layout, then the terminology, confirmation and responsive audit.

History rehearsal follow-up: corrected the email assertion to await the fixture’s capturedEmails() accessor rather than inspecting the function’s arity. Both compiled web and native-web rehearsals passed again with the actual captured-message arrays empty (`/tmp/showpilot-history-mail-web.log`, `history-mail-native.log`). Application code is unchanged.

### Phase 2 follow-up: Schedule roster visibility and panel layout

The compiled fixture reproduced two missing legacy assignments at every tested width: the department picker trimmed/discarded department values while row grouping used raw values and an inferred fallback absent from that picker. `rosterDepartment` now supplies the shared display label, and `groupRosterRows` includes every supplied assignment exactly once, even if its department is not in the supplied list. Existing explicit department names win over role inference. Stored assignments are not rewritten.

The same baseline found undersized roster actions and a statistics section overflowing a 438px panel at a 1024px viewport. Schedule now uses its main panel's container width for the card/table and statistics layouts, removes the 900px table floor, wraps long operational text, and gives the roster buttons and response-note toggles 44px targets. Local route labels use at least 12px. Desktop response notes expand with keyboard controls instead of depending on a truncated hover tooltip. A confirmed empty response filter explains the result and offers Show all responses; it does not claim emptiness alongside a refresh or read failure. The Rundown link remains available on narrow screens.

Validation: 3,469 unit + 1,791 actual Worker tests passed (5,260 total), `/tmp/showpilot-roster-full1.log`; web typecheck (`tsc1`) and production build (`build1`) passed. Main bundle 554,052 raw / 174,942 gzip bytes, below unchanged 600,000 / 175,000 limits. Six grouping regressions cover blank, padded, inferred and explicitly named departments without mutating input data. No native app/Rust code changed.

New `smoke-schedule-roster.mjs` passes against real local auth/D1 and the compiled app at 320×480, 768×1024, 1024×768, 1440×1000 and 1920×1080 (`browser1`). Every fixture assignment is visible; inspected controls meet 44px; tested panels have no horizontal overflow; legacy assignments open their actual editor; response notes expand with Enter and show their complete text; empty filters recover. Phone and desktop screenshots were inspected. Zero browser exceptions and actual captured emails. Its optional --audit mode records the original defects (`before`). Fixture-only legacy records are behind a separate scheduleRoster option.

Existing compiled assignment, reminder and roster-read recovery rehearsals also pass on this build (`assignment`, `reminders`, `read`): exact save/invitation retry, retained drafts across navigation, revision-conflict review, partial-team retry, uncertain reminders without repeating accepted emails, and bounded reads that retain confirmed data and ignore late replies. All email delivery in those mutation fixtures is captured locally. The broader navigation rehearsal (`navigation`) passed all 21 sidebar routes and 13 Settings sections without reload, including distinct Schedule/Rundown/Show Flow screens, Settings back behavior and narrow layouts. These are scoped checks, not a claim that every control in every product surface has passed the complete UX gate.

Phase 2 remains 67/79; necessary Markdown remains twenty files. No remote data, deployment or release changed. Next: reconcile terminology/deduplication and the remaining broad Phase 2 gate evidence, rather than advancing to Phase 3 with unresolved requirements.

Rebase validation follow-up (2026-11-13): screenshot review at 1440px exposed a narrow show-title column beside crew actions despite the roster assertions passing. Give the title an 18rem flex basis so the actions wrap before they squeeze it; the named roster rehearsal now asserts the title retains that width (or the complete narrower panel width) at every tested viewport. This is part of the Schedule panel layout fix; no data or native code changes.

### Phase 2 follow-up: native graphics recovery

The compiled native Lower Thirds screen sent a toggle immediately when Take off air was pressed, with no visible confirmation (`/tmp/showpilot-native-graphics-before.log`). Repeating an uncertain toggle could reverse the intended output, and an unbounded save could close an unrelated editor. The updated screen uses explicit show/hide commands and confirms live takes, clears, deletes and edits to a live graphic. Reads have a 10-second deadline; failed refreshes retain and label the last confirmed state without claiming an empty library or disabled cloud graphics. Commands and drafts survive screen navigation within the current app session, scoped to account and organization. An uncertain command locks competing changes and offers exact retry or review; a confirmed command with a failed refresh retries only the read. Drafts survive conflicts and require an explicit review of the current saved revision before replacement.

Migration `0093_graphic_control_recovery.sql` records per-template revisions, including delete/recreate tombstones, and actor-scoped command receipts. Program revisions reuse the existing triggers, so writes from other clients invalidate stale reviews. Revision checks, receipt and mutation commit in one D1 transaction with current session, membership, permission and cloud-enable guards. Explicit output requests expire after a short send window. Review cancels an uncommitted request before delayed delivery; retry returns the original outcome and current state without reapplying a save or toggling newer output. Editing preserves existing graphic styling, and deleting a live graphic removes its program pointer while retaining other graphics. The new client uses dedicated endpoints; older installed clients retain their existing API contract and do not gain the new UI safeguards until updated.

Validation: full web command passed 3,478 unit plus 1,806 actual Worker tests (5,284 total), `/tmp/showpilot-native-graphics-full1.log`. Fifteen new Worker tests exercise actual D1 revisions, receipts, races, expiry, legacy pointers, deletion, malformed program state and commit-time authority changes. Nine actual native-hook tests cover navigation/account ownership, retained drafts, exact retries, read deadlines, stale edit review and refresh-only recovery. Web/shared typechecks passed (`web-tsc1`, `shared2`). Web build (`build1`) passed at unchanged 554,052 raw / 174,942 gzip main bytes. Native verification (`native1`) passed types, lint with existing warnings, iOS/Android/web exports, Expo Doctor 18/18 and foreground polling checks; Hermes sizes 6,175,134 / 6,174,258 bytes. Existing parity inventory remains 20 complete / 1 missing. Initial test-only failures were an incomplete fixture timestamp and asynchronous query-observer notification; the read hook now explicitly observes its error state.

`smoke-native-graphics-recovery.mjs` passed with the compiled native-web app and real disposable auth/D1 (`browser1`). It holds an initial read beyond its deadline, retains drafts across actual screen navigation, loses the reply after a committed save, retries the identical request after another edit, verifies the newer edit survives, reviews a delayed-before-arrival output command and proves it remains cancelled, recovers failed polling, and checks Take live/off air, Clear program graphics and Delete confirmations. Checks cover 320×480, 768×1024 and 1440×1000, 44px action targets, no horizontal overflow, zero browser errors and zero actual captured emails. Phone confirmation/recovery and tablet editor screenshots were inspected. This proves the compiled client/API path, not physical iOS/Android hardware behavior.

The migration audit passes with unapplied migrations reported; no remote migration, deployment, release or real-organization write occurred. Migration 0093 must precede these clients' deployment. Necessary Markdown remains twenty files. Schedule draft #297 is green at exact head 337eca4ffc031d587f7555ee67a216a428ff9aba (run 42633148171), checked before this successor PR. Phase 2 remains 67/79; next is the remaining native destination-control recovery and the terminology/product-wide gate reconciliation.

Migration verification (2026-11-13): applied `0093_graphic_control_recovery.sql` once with a single-file remote D1 execute against the configured ShowPilot database, after full local tests/types/build/mobile verification and the compiled native graphics recovery acceptance passed. Reviewed application commit `ba142a135b56ad8ee0117859f26bcfce4e16e266`, SHA256 `fed7b111d6bf7c9de723b7b362b99e0a518716fd9fae345a29c3ccd567f6baf3`. Exact two tables, three triggers, columns, composite primary keys/indexes, cascading foreign keys and outcome constraint match the reviewed SQL. Recovery bookmark and command/schema evidence are saved privately. The migration backfills new graphic revision metadata; original templates, output settings and styles are unchanged. Verification queries schema metadata only; no organization content is queried. The ordered remote ledger now includes 0093; do not apply it again. No app deployment or release performed.

Legacy graphics compatibility follow-up (2026-11-13): after 0093 application, a new actual-D1 regression reproduced an old native edit updating the graphic and its revision but returning false 404 because `meta.changes === 1` included trigger writes. The legacy graphics update now uses org-scoped `UPDATE ... RETURNING id` to acknowledge its own row, retaining 404 for missing/foreign IDs. Eighteen focused Worker cases pass, including three new compatibility cases; the compiled native graphics rehearsal also checks the legacy authenticated endpoint, style/output preservation and revision advancement. Other existing graphics library writers acknowledge retained receipts rather than trigger-sensitive counts. Migration bytes are unchanged and must not be reapplied.

### Phase 2 follow-up: native destinations and stream-health recovery

The compiled native screen reproduced an immediate Disable output mutation without visible confirmation (`/tmp/showpilot-native-destination-before.log`). It omitted the request IDs required by the existing destination/output receipt engines, and its Connected label was inferred from a stored output pointer rather than provider status. Native Multi-Platform now distinguishes selection for Go Live from actual provider output state, explains that selection does not start a broadcast, and confirms disconnect/delete against the displayed revision. Changing metadata or provider ownership invalidates an open confirmation. Fields and original requests remain scoped to account/organization across screen navigation within the current app session; stream keys stay masked and are not returned by reads.

Migration `0094_destination_control_recovery.sql` adds destination revisions, tombstones and HMAC-only native admission receipts. The native path reuses the existing encrypted save and provider reconciliation engines. Their first atomic write/admission accepts an internal SQL guard for current authority, the reviewed revision, expiry and uncancelled request identity; no client can supply SQL. Reviewing an unsent request cancels it before a delayed arrival can apply it. Once a provider command is admitted, review does not claim it was cancelled: unresolved work remains visible and locked until the original command is reconciled, or a newer command supersedes it. Retrying an acknowledged request does not recreate a destination or undo later changes. Old client/API fingerprints and optional caller contracts remain intact. Intent revision triggers watch ownership changes rather than lease bookkeeping, preserving the existing engine's lease checks.

Destination reads and native Stream Health reads have explicit 10-second deadlines, foreground-only polling, and visible retry. A failed load no longer implies an empty library or zero inputs. Failed refreshes label retained state. Stream Health uses actual destination provider status separately from input health; an enabled output is not presented as proof that the encoder is live. Editor conflicts retain the draft and require an explicit review of current saved values. Confirmed changes whose refresh fails retry only the read.

Validation: full web command passed 3,487 unit + 1,819 actual Worker tests (5,306 total), `/tmp/showpilot-native-destination-full1.log`. Thirteen new Worker tests cover encrypted keys/hash-only receipts, exact retries, revision/tombstone conflicts, pre-arrival and in-preparation cancellation, commit-time permission loss, admission guards, provider status, lost provider replies and superseding commands. The focused run also passed existing streaming tests (49 total, `worker1`); nine actual native-hook tests passed (`hooks1`). Web/shared typechecks (`web-tsc3`, `shared1`) and final build (`build1`) passed at unchanged 554,052 raw / 174,942 gzip main bytes. Native verification (`native1`) passed types, lint with existing warnings, iOS/Android/web exports, Expo Doctor 18/18 and polling checks. Hermes bundles are 6,198,246 / 6,197,379 bytes; parity remains 20 complete / 1 missing, not physical-device proof.

The compiled native rehearsal `smoke-native-destination-recovery.mjs` passed with real disposable auth/D1 and the local provider fixture (`browser2`). It verifies bounded reads, stale confirmation invalidation, draft navigation, exact retry after a newer edit, retained conflict review, cancellation before delayed delivery, failed provider deletion plus review-without-repeating and retry reconciliation, status failure recovery, Stream Health loading/error honesty, confirmed deletion preserving another destination, encrypted creation and selection without creating a broadcast. Tested 320×480, 768×1024 and 1440×1000 with reachable 44px controls, no horizontal overflow and zero browser errors; phone confirmation/health and tablet/desktop editor screenshots were inspected. Its first run reached the final creation step but a label selector matched both the visible password field and an Expo-retained hidden screen; the final selector targets the visible field. No application change was required for that harness correction.

The existing `smoke-stream-output-commands.mjs` also passed on this build (`web-outputs`): web confirmation, exact retries, partial Stop, and a late provider creation that cannot restart broadcast; nine distinct commands and five intentionally exercised fixture creations, all isolated from external accounts. Migration manifest audit passed with pending migrations reported. Migration 0094 must precede deployment of these clients. No remote migration, deployment, release or real-organization write occurred; all provider activity stayed in disposable local fixtures. Necessary Markdown remains twenty files.

Graphics draft #298 is green at exact head b4f703b8a06a07e6aa825586798448d8755c6cbd (run 42637654374), verified before this successor. Phase 2 remains 67/79. Next: reconcile the remaining terminology/deduplication findings and product-wide gate evidence before Phase 3; the owner-supplied Founding Member end date/timezone remains pending.

Destination migration compatibility preflight (2026-11-13): before remote application of 0094, added actual-D1 legacy HTTP cases for encrypted-key-preserving saves, selection/disable/delete acknowledgment and idempotent deletion, no unintended provider activity, and foreign-organization rejection. All sixteen focused destination Worker cases pass. The new intent-update trigger runs only when commandId changes, so lease/state updates do not alter revision counters or their acknowledgment counts; final destination mutations are acknowledged through the separate command receipt. Main's 0093 graphics compatibility fix remains intact.

Migration verification (2026-11-13): applied `0094_destination_control_recovery.sql` once with a single-file remote D1 execute, after 5,319 local tests, web/shared types, web build, full mobile verification and the compiled native/web destination/output rehearsals passed. Reviewed source `5396a08a265f6b680c628a388affde74ddbcbfb8`, SHA256 `9bce0536d7a30273d16cce171ec992d08252e2b6d8e292c06e613294646c5fea`. Exact two tables, six triggers, columns, composite primary keys/indexes, cascading FKs and outcome constraint match the reviewed SQL. Recovery bookmark and command/schema evidence are private. Backfills only new destination revision metadata; existing destination fields/keys, output intent and provider state are unchanged. Verification queries schema metadata only. Actual-D1 legacy HTTP save/select/disable/delete/retry/cross-org cases passed before application; synthetic SQL proves lease/state updates and same-command assignments do not bump revisions. The ordered ledger now includes 0094; do not apply it again. No manual app deployment or release performed.


### Phase 2 follow-up: operator terminology and native manager reads

Team now distinguishes Workspace members, Access grants, Crew roster and Content reports, with visible explanations of sign-in access, production profiles and the separate show-report area. Native Operations and its destination screens use the same member/access labels. Tech Manager calls reported issues incidents, matching the incident log, and its heading matches navigation. Song Studio calls its saved timing structures cue maps. Contextual service/show terms and internal API identifiers remain unchanged.

Lower Thirds and Template Studio both use Clear program graphics. Studio visibly explains Save graphic versus Save scene and keeps the Take Live name for multi-layer compositions. Tech Manager's broader Clear all graphics explicitly includes both Program and the live lower-thirds relay. Stream controls say Disconnect destinations and retain their existing explanation that the encoder/input keeps running. These are distinct operations; their confirmation, revision, original-request retry and provider semantics are preserved.

The compiled native baseline kept both manager screens on Opening after 11.5 seconds, with no retry (`/tmp/showpilot-terminology-manager-before.log`). Manager reads now have a 10-second cancellable deadline, account/organization-scoped query keys, foreground polling that stops after failure, and a visible Retry dashboard action. Initial failures do not present zero counts or a missing-show claim; refresh failures label and retain confirmed values. Native Tech Manager labels stored stream metadata as setup attention and points to Stream health for provider status.

Validation: full web suite passed 3,487 unit plus 1,819 actual Worker tests (5,306 total), `/tmp/showpilot-terminology-full2.log`. The first run found two test selectors still using the old Members tab name; selectors now match Workspace members. Web typecheck (`tsc1`) and production build (`build1`) passed at 554,052 raw / 174,934 gzip main bytes against unchanged limits. Native verification (`native1`) passed types, lint with existing warnings, iOS/Android/web exports, Expo Doctor 18/18 and polling checks; Hermes bundles 6,200,094 / 6,199,244 bytes. Parity remains 20 complete / 1 missing; exports do not establish physical-device behavior.

New compiled rehearsals `smoke-operator-terminology.mjs` (`browser1`) and `smoke-native-manager-recovery.mjs` (`manager1`) pass against real disposable auth/D1. They exercise Team tab purposes and keyboard navigation, library-to-Studio navigation, named clear confirmation, visible save explanations, both managers' initial deadline and failed-refresh retention, explicit retry, 44px controls and no horizontal overflow at 320×480, 768×1024 and 1440×1000. Phone and desktop screenshots were inspected. Both report zero browser exceptions and actual captured emails. Existing compiled Studio, stream-output, Tech Manager stream and Tech Manager graphics recovery rehearsals also pass (`studio1`, `stream1`, `tmstream1`, `tmgraphics1`), preserving exact retries, newer output, cancellation, partial failures, both graphic-output clears and saved templates. External traffic was blocked or replaced by local provider fixtures.

Phase 2 remains 67/79. This is scoped terminology/loading evidence, not completion of the product-wide audit. Remaining work includes web manager readiness, its compact controls and refresh recovery, the full terminology/deduplication reconciliation, and final gate checks. The owner-supplied founding-window date/timezone is still pending. No remote migration, deployment, release or real-organization write occurred. Necessary Markdown remains twenty files.
