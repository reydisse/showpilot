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
