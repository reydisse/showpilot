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
internal records through `updateOrgSetting`. The batch and credential variants
now reject those keys before any write. No data migration or new secret is
required. Existing internal rows remain available to their owning server code.
Future Settings fields must be added to the registry with an explicit permission.

Run `node apps/web/scripts/smoke-settings-boundary.mjs` after building to exercise
the compiled RPCs with real authentication and disposable D1 data. Deployment
and production verification are still pending.

Local verification passed 1,393 unit tests, 390 Worker tests, typecheck, the
production build and the compiled-RPC smoke check. The smoke check rejects 21
internal-key writes, then inspects D1 to confirm unchanged internal records,
no partial invalid batch, and encrypted credentials.

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

The production manifest records every migration through `0051_device_latency.sql`.
Migration 0048 was applied on 2026-11-05 after a clean preflight and a saved
Time Travel bookmark. Its postcondition verified three empty tables, five
named indexes, an unchanged legacy key count, and no foreign key violations.
Migration 0051 (`device.latencyMs`) was applied on 2026-11-09 after a clean
preflight and a saved Time Travel bookmark. Its postcondition verified the
NOT NULL integer column with default 0 and range check, all existing devices
at zero latency, and no foreign key violations.
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
