# DRAFT, FOR REVIEW ONLY. Not sent to Codex. Not sent to the user.

---

# ShowPilot: one phased safety, trust, and feature pass

Repo: https://github.com/reydisse/showpilot

## Context

ShowPilot is a real, working live show system, not a prototype. Its rundown core is single writer with revision control, its SMPTE math is correct including drop frame, and its automation design is server authoritative. What is thin is the show day safety envelope around that core: timecode automation has no kill switch, no retry, and reports some failures as successes; one Bridge API key can drive an entire org's devices with no PIN and no attribution; timecode and Bridge state are scoped per org rather than per show or per venue, so concurrent services collide; and the operator UI has unguarded destructive actions and silent failure modes. This prompt fixes all of that in phases, plus the feature work that is unsafe to build on the current foundation: a MIDI controller layer, real LTC input, the missing automation events, and billing completion.

This prompt is based on a full CTO audit (12 Critical, 28 High, 31 Medium, 13 Low findings), a UI behavior review (9 additional issues), live browser testing in the ShowPilot Demo org, competitor pricing research, and a product-wide UI/UX audit (a code-level audit of every route plus a live pass over every reachable screen in the Demo org). The audit was done on commit 32e2507, so confirm file paths when you start; paths may have drifted.

## How to work

1. Work in phases, in order: Phase 0, then 1, then 2, then 3. Land each phase as its own reviewable change set. Do not land this as one mega diff. If a phase grows too large to review, split it and say so in your phase report.
2. Verification gates. After each phase, run the full test suite, run typecheck, and run that phase's acceptance checklist below. Report the results. If any gate fails, stop, report the failure, and do not start the next phase.
3. Do not break what already works. Keep: single writer rundown with revision control and conflict resend; correct SMPTE math including drop frame; server authoritative automation; atomic song cue replacement by sourceKey; scoped lyric clears by generationKey; read only display projection (confidence and kiosk clients receive display state only, never the full automation timeline); webhook SSRF basics (extend them, never weaken them); permission discipline in org-access; bound D1 parameters; React text node rendering for lyrics, stage messages, lower thirds, and chat. Keep every existing test green; add tests for every new behavior.
4. No signing secrets. Implement the pre-tag CI check that reports missing secrets by name (Phase 1). Do not provision Apple Developer ID or Windows Authenticode certificates, and do not require any secret to be present for CI to pass apart from that report itself.
5. No new paid services. The error reporting sink must be built in repo (for example a D1 backed endpoint reusing the existing webhook log pattern). No Sentry, Bugsnag, PostHog paid tier, or any other new SaaS.
6. No price level changes. ShowPilot charges Free, Starter $39, Pro $79, Founding Member $25 locked for life, all USD per organization per month, monthly billing only, with a 14 day Pro trial and no card. Those levels and the free tier limits are business decisions and are out of scope. Phase 3 builds billing mechanics only (annual billing, plan preselection, promo codes, trial handling, webhook endpoint verification).
7. Do not touch real org data. Test against fixtures and test orgs only. Never modify Faithfire Production or the ShowPilot Demo org's real data in order to test.
8. Do not chase these, they were checked and are not issues: the timer/kiosk page does show connection state; rundown drag reorder does have touch support; the event editor does validate timecode format on submit (Phase 2 adds inline validation, it does not add validation from scratch); the relay does resend state on command rejection and revision conflict; the show page has no competing rundown transport; Sidebar QuickActions are benign (theme, fullscreen, collapse only); ConfidenceToolbar having no lyrics controls is consistent with the current design.
9. Audio following lyrics ("as they sing") is explicitly out of scope for this prompt. It is its own project (Bridge side audio tap, confidence gated alignment, manual override that always wins). Do not attempt it here.

## Phase 0: Stop the bleeding (show day safety)

Goal: an operator can stop automation without stopping the clock, trust what the UI reports, and cannot wipe a live show with one misclick.

### 0.1 Automation kill switch, per event disable, per event retry (audit C7, TC/L2)

- Wire the existing `triggersEnabled` field into `TimecodeRelay.evaluateEvents` (apps/web/src/durable-objects/TimecodeRelay.ts). When disabled, skip execution but keep the clock and displays running. Do not invent a second flag.
- Add a per event `enabled` flag on `AutomationEvent` (apps/web/src/types/timecode.ts). Disabled events never fire and render as disabled, distinct from fired and from failed.
- Add a per event retry/re-fire command that resets one event's `fired` flag and execution status, instead of the current `reset-events` which re-arms everything. Add a Retry button on failed timeline rows.
- Surface a "missed/failed cues" list the operator can see at a glance.

### 0.2 Honest failure reporting (audit C8)

- Make every automation action branch throw on non-OK, or set status from the logged result instead of from "no exception". Lower third and rundown branches currently catch failures internally, only log them, and the outer handler then marks the event `acknowledged`. That must end.
- Keep `fired` unset until acknowledgement. Add a bounded retry inside the event's tolerance window plus the manual re-fire control from 0.1.
- Surface `failed` status to read only display clients too, through the existing display state projection.

### 0.3 Kill the Bridge god credential (audit C1)

- Store only a hash of the Bridge API key, never plaintext. Issue per installation keys with a label, a last used timestamp, and one click revocation.
- Never accept the key in a URL query string. Header only.
- Scope the key to bridge transport. Require a member session or a narrower device token for rundown, timecode, and lower third writes.
- Log which key was used on every relay write.
- Support a short overlap window during rotation, so rotating a key does not kill the venue Bridge mid show.

### 0.4 Gate public show state behind a display pass (audit H6)

- Require a kiosk token, a short lived display pass, or a per org unguessable display secret for `/timer/*`, `/api/overlay/*`, and `?display=1` relay reads.
- Remove `Access-Control-Allow-Origin: *` from the overlay endpoint.
- Treat stage messages as non-public: exclude them from the unauthenticated display projection or gate them behind the same pass.

### 0.5 Unguarded destructive actions (audit C12, H3; UI review 9 note; UI/L5)

- Route rundown "Reset timer" (apps/web/src/routes/$slug/rundown.tsx, `handleReset`) through the same `ConfirmDialog` used for "Clear this rundown?" and "End this show?", and require it to be disabled or double confirmed while the timer is playing. It currently wipes items, clears actual start/end, stops the timer, and broadcasts reset to all operators with no dialog and no undo.
- Put single rundown item delete, saved template delete, automation "Reset All", and per event delete behind `ConfirmDialog` (or the two tap arm pattern from `CockpitControlPanel`). Add an Undo toast for single item deletes.
- Move "Load Demo Show" out of the sticky header into an empty state body section, and hide it once any real event exists or a show is live. One tap must not inject demo events into a real workspace timeline.
- Scope the end show confirmation to the show only, not the current item, so it does not silently evaporate when the item advances. If it must reset, show "show advanced, confirmation cancelled" feedback.

### 0.6 Tame global keyboard shortcuts (audit H1)

- Never let bare `Space` start a stopped show. Gate transport shortcuts behind an explicit armed mode or require a modifier for start, next, and previous.
- Surface the shortcut list in a dismissible banner the first time the rundown opens, not only in a small left rail card.

### 0.7 Bridge MTC decoder (audit C9)

- Port the web decoder's seenMask, direction, and contiguity logic (apps/web/src/lib/timecode-sources/mtc-source.ts, lines 102-135) to the Rust decoder (apps/bridge-desktop/src-tauri/src/lib.rs, `MtcQuarterFrameDecoder::feed`). Reset `received` after each emit. A dropped or reordered quarter frame must not jump the clock by seconds or minutes.

### 0.8 Timeouts and parallel execution (audit C11)

- Wrap each `executeEventAction` in a timeout (for example 5s for webhooks, matching the Bridge 8-10s envelope). Evaluate independent same frame events concurrently with `Promise.allSettled`. Record per event timing so a slow webhook shows up before it eats a show.

### 0.9 Disconnect honesty on operator screens (UI review 1, 2, 3; live findings)

- Rundown page: render a persistent banner from the sync hook's `connected` flag plus the unconfirmed command count ("Offline, N changes queued"). While disconnected, either disable transport or clearly mark presses as queued. Add staleness handling for transport commands applied after reconnect: drop or confirm commands older than a few seconds instead of firing a late Next or Start minutes after the moment passed.
- Timecode page: make `sendCommand` (apps/web/src/hooks/useTimecode.ts) report success, queued, or failed instead of silently doing nothing when the socket is not open. Disable the event editor, song loader, and transport while disconnected, or queue with a visible pending state. Do not clear the editor form until the relay echoes the event back in `events-update`. Do not set local `isMaster=true` or start the local clock when the start command never reached the relay.
- Song cue loader: confirm gate (or disable) cue map loads while the clock is running, so loading the wrong song's map cannot swap the live timeline mid show. Surface a format mismatch warning instead of silently falling back to the running format when a map's stored format is unparseable. Validate the offset input to >= 0 (or show the clamped result before loading); today a negative offset piles every early cue at 00:00:00:00 where they burst at clock start.
- Clock panel truth: the large clock panel must never read "Stopped" while the generator is running and the clock is advancing. Running state shown in the panel, the button label, and the sticky header must agree at all times.

### Phase 0 gate (all must pass before Phase 1)

- Full test suite green, typecheck green.
- Kill switch test: with triggers disabled, the clock and displays keep running and no event fires; re-enabling resumes firing from the correct position without double firing.
- Per event test: disabling one event leaves all others firing; retrying one failed event re-fires only that event.
- Failure honesty test: a failing lower third action and a failing rundown action both land in `failed`, never `acknowledged`, and appear on a read only display client.
- Credential test: no plaintext Bridge key anywhere in storage or logs; a key in a query string is rejected; a revoked key is cut off; rotation with an overlap window does not drop the connected Bridge.
- Guard test: Reset timer, single item delete, template delete, Reset All, and per event delete all require confirmation; Reset timer is blocked or double confirmed while playing.
- Shortcut test: bare Space never starts a stopped show.
- MTC decoder test: dropped and reordered quarter frames do not jump the clock; the Rust decoder matches the web decoder's contiguity behavior.
- Timeout test: a hung webhook (5s+) does not stall later cues in the same tick.
- Disconnect test: with the socket closed, transport presses show queued state and do not present as live; the editor form is not cleared until relay echo; a stale queued command does not fire late after reconnect.
- Report the gate results. If anything fails, stop here.

## Phase 1: Trust model and honest clock

Goal: concurrent shows cannot collide, revoked access is actually cut off, and the clock tells the truth about signal loss, jumps, and format changes.

### 1.1 Scope relays per show and per venue (audit C4, C3)

- Key `TimecodeRelay` per org plus show (same key function as `RundownRelay`), or at minimum scope `events[]` by showId/serviceDate and reject a feed whose show does not match the active rundown. Never let a format change re-arm events fired in the current run without an explicit operator reset.
- Key `BridgeRelay` per org plus venue/room, or allow N registered bridges with a named active/standby and explicit operator takeover. Until that lands, document "one Bridge per org, never start a second mid-show" and surface the 4410 takeover as a loud UI alarm, not a log line.

### 1.2 No claim means read only (audit C2)

- Make "no claim" mean read only display everywhere except a narrow, explicitly marked internal path the Worker itself originates.
- Have the Worker strip all `auth*`, `access`, `role`, and `key` parameters from the inbound URL and rebuild the DO URL from scratch.
- Require every WS write socket to carry a claim re-validated per message, including bridge key client sockets bound to the key's current hash.

### 1.3 Stop re-authenticating every broadcast (audit C6, H15)

- Cache the authority decision on the socket attachment with a short TTL (for example 60s, invalidated on permission change push) and check revocation out of band. Broadcasts must be fire and forget `ws.send` loops without awaiting a DB query per recipient. Reserve per message D1 checks for writes and commands only.
- Cache org resolution plus session/access in the Worker for WS upgrades (short TTL, keyed by session id). Scope `first-primary` to the post-write loader path only and let steady state reads use replicas. Reuse a single Prisma client per isolate where the adapter allows it.

### 1.4 Watchdog, handover, and reconnect gaps (audit H12, H13, H17)

- Add a DO Alarm watchdog: if no feed arrives for more than 2s while running, mark `running=false`, broadcast a "timecode lost" state, and keep a last feed timestamp in persisted state. Persist `previousFeedFrame` alongside the snapshot.
- Implement master handover: when the master disconnects, promote the Bridge/MTC feed if one is live instead of unconditionally stopping.
- Add a monotonically increasing sequence/revision to `TimecodeRelay` broadcasts and to `CueSheetRelay` (or send a D1 derived snapshot on cue sheet WS connect). Clients compare `lastSeenSequence` on hydrate and force a refresh when there is a gap.
- Add relay side stall detection: no `feed-tc` for 500 ms means `running=false`, broadcast a `timecode-stalled` state, and freeze automation evaluation. Surface "MTC signal lost" in `TimecodeSourceSelector`.

### 1.5 Master only mutations, jump threshold, format change guard (audit H19, H18, H21, TC/M4)

- Require the master session for all mutating timecode commands (`set-timecode`, `set-source`, `set-format`, `add-event`, `replace-event-group`, `update-event`, `remove-event`, `reset-events`, `set-lyrics`, `clear-lyrics`). Reject HTTP `/command` calls that lack a master claim, or at minimum require the same session token.
- Add a jump threshold (for example, more than 2s discontinuity requires explicit re-arm or fires only cues the operator confirms). Never auto-reset `fired` on backward jumps unless the operator pressed Reset.
- Require an explicit, confirmed "reformat timeline" action. Ignore format changes that arrive only in `feed-tc` unless they persist for N consecutive feeds. Never reset `fired` on format change without operator confirmation.
- Pick one tolerance default (the types say 2, the relay and song cues default to 5), surface tolerance per event in the editor, and document that tolerance only applies to re-sync and startup matching.

### 1.6 Bridge target allowlist and credential hygiene (audit H7, H8)

- Maintain a per org device allowlist (host plus port plus protocol, created only by `settings:api_keys` or `settings:integrations` holders) and reject `connect-device` and `command` to any target not on it. Log every new target connection with the acting user. Never forward settings blobs containing credentials (PJLink passwords, OBS auth, `http-command` auth tokens) without redaction in relay and broadcast paths.
- Encrypt credential valued settings with a Worker secret (envelope encryption), hash API, kiosk, and companion tokens at rest and show them once at creation, mask all credential values on every read path (including `add` and `update` returns), and narrow `getProPresenterRuntimeSettings` to `settings:api_keys` holders or a dedicated device credential permission, not every lower third operator.

### 1.7 Rundown persistence and active show pointer (audit H11, H14)

- Persist item diffs (insert, update, delete by id, one statement per changed row) instead of delete plus reinsert. Move the big JSON snapshot out of `app_setting` (or drop it; the relational rows already exist) and remove the 1.5 MB edit failure cliff. Persist `ppSlide` with the same action set as `ppPreviewSlide`.
- Make the active show pointer transactional with the room switch (write it in the same step that opens or seeds the room, and fail loudly if it fails). Include the resolved showId/serviceDate in every automation and Companion response so the UI can warn "automation is targeting a different show than the one on screen".

### 1.8 Release pipeline honesty without secrets (audit C10, constrained)

- Add a pre-tag CI check that fails fast with a named missing secret report before any platform builds. Time limit or delete the unsigned prerelease path so it cannot be mistaken for a release. Do not provision certificates and do not require secrets to be present.

### 1.9 Delete or quarantine the dead gateway (audit H16)

- Delete `apps/gateway/`, or, if it must stay for reference, make `index.ts` refuse to start with a banner pointing to `apps/bridge` plus `apps/bridge-desktop`. Do not leave two "Bridge" entry points in the repo.

### 1.10 Onboarding: signup dead end and second org creation (live findings 1 and 2)

- Signup: on USER_ALREADY_EXISTS, offer "Sign in" and, once signed in, surface org creation, instead of sending the user away with "Use another email."
- Second orgs: separate org creation from first time onboarding. Give the switcher's "New organization" a dedicated create org flow that does not require hasOrg=false, or add an "add another org" mode to setup that skips the redirect for users who already have an org. Today `deriveResumeScene` (apps/web/src/lib/onboarding-flow.ts) redirects any user who has an org and is not an owner, has not started onboarding, or has completed onboarding, and the only `organization.create` call lives inside the setup wizard, so no existing user can create a second org for a different team through the UI. That must end.

### 1.11 Clock semantics: resume versus restart (live finding)

- Define and implement one consistent rule for Stop then Start: either resume from the held position or restart from zero, and make the button label, the panel, and the header all say the same thing. Today Stop holds the clock but the next Start restarts from 00:00:00:00, which reads as a resume that is not one.

### 1.12 Web MTC decoder hardening (audit TC/M1, TC/M3 validation half)

- Check the SysEx device/channel byte (`data[2]`), range check minutes, seconds, and frames in `handleFullFrame`, and reset the quarter frame accumulator on full frame receipt. Note the web SysEx path may be dead in practice because `getInputs()` and `start()` call `navigator.requestMIDIAccess()` without sysex permission; confirm that and do not rely on full frame jam sync in the browser until it is proven.
- Validate `set-source` against implemented sources only, so the relay can never report `ltc-bridge` or `network` as active while nothing feeds them. Full LTC implementation lands in Phase 2.

### Phase 1 gate (all must pass before Phase 2)

- Full test suite green, typecheck green.
- Scoping test: two concurrent shows in one org have separate clocks and automation lists; a feed for show A cannot fire into show B's rundown.
- Claim test: a claimless socket is read only; a revoked member's open socket stops writing; attacker supplied auth params in the URL are stripped and ignored.
- Perf test: a 10 Hz feed to N sockets performs no per socket per broadcast D1 auth round trips.
- Watchdog test: feed silence over 2s marks the clock lost and broadcasts it; master disconnect promotes a live Bridge/MTC feed instead of stopping; sequence gaps on reconnect force a refresh.
- Mutation test: a non master session cannot mutate the timeline, format, clock, or lyrics; HTTP `/command` without a master claim is rejected.
- Jump and format test: a backward jump does not re-arm fired cues; a forward jump past the threshold requires confirmation; a lone format glitch does not re-arm the timeline.
- Allowlist test: a Bridge command to a non allowlisted host/port/protocol is rejected and logged; credential values never appear in relay broadcasts or read returns.
- Persistence test: a 100 item rundown edit does not rewrite the whole table and does not hit a size cliff; `ppSlide` survives a relay restart.
- Onboarding test: signup with an existing email offers sign in; a signed in Member can create a second org through the switcher without being bounced to their current org.
- Report the gate results. If anything fails, stop here.

## Phase 2: Features the safety pass unlocks

Goal: the APC Mini becomes a real control surface, venues can feed LTC, cues carry honest timing, and the operator UI stops hiding the information a live show needs.

### 2.1 MIDI controller layer, separate from MTC (audit Phase 2 item 13; TC/M2, TC/M5)

- Build a MIDI controller listener distinct from the MTC source. MIDI learn: map APC Mini pads and faders to transport (start, stop, pause, reset, set timecode) and event actions (fire next, fire one, skip, re-arm), saved per show, not global only.
- Simultaneous MIDI inputs: MTC source on one port and the controller on another at the same time. Controller notes and CCs must never be parsed as MTC.
- MIDI output and pad feedback: light pads for running, next cue, armed, and fired states. Without this the operator is blind.
- Paged cue grid and fader roles: banks for shows larger than 64 pads, plus faders for offset trim or jog/scrub.
- Reconnect resilience: USB unplug and replug without losing mappings. Mirror the Bridge's 2s rescan loop in the web path, add an `onstatechange` handler, and show time since last MTC frame in the source selector.
- MIDI transport awareness: handle MTC start, continue, and stop (0xFA, 0xFB, 0xFC), Song Position Pointer (0xF2), and MIDI clock (0xF8). Stop must mean `running=false` and no evaluation; start and continue must re-sync via full frame or SPP. Stop re-feeding a static frame at 10 Hz when MTC has stopped advancing.

### 2.2 Real LTC input (audit TC/M3, Phase 2 item 14)

- Implement the currently unimplemented `ltc-bridge` source type: audio input demodulation in the Bridge, where audio access is feasible, so venues that feed LTC over audio (not USB MIDI) get a real clock. Until it lands, Phase 1's `set-source` validation stays in place and the type stays hidden from the source selector.

### 2.3 Local show mode, minimum viable first (audit C5)

- Ship a real local mode in the Bridge/desktop app: cache the active rundown plus device targets on the venue machine, allow timer advance and a whitelisted set of device commands locally while the cloud WS is down, and reconcile revision checked on reconnect.
- Minimum first slice if the full mode slips: queue Bridge bound commands client side with a visible "queued, not sent" state instead of silent drop or fail fast. The desktop offline page today is a read only rehearsal timer that cannot fire a device, push lyrics, or sync back; that is not a local mode.

### 2.4 Offset, latency, and clock drive (audit H20, H22)

- Drive the internal clock from `setInterval` or a Web Worker, not `requestAnimationFrame`, which browsers throttle or stop in background tabs. Feed at 30 Hz or extrapolate on the relay between feeds.
- Add per event `leadMs` and per device latency fields consumed in `evaluateEvents`, plus client side interpolation between relay samples. Today the only offsets are a static per song frame shift and an internal start offset that is always called with 0, so ProPresenter slides, lighting, and lower thirds, which each have different downstream latency, cannot be aligned.
- Surface the internal generator offset in the UI instead of hardcoding 0 at the Start button.

### 2.5 Automation event catalog completion (audit section d; agreed additions)

Add every event below, each with relay support, timeline rendering, editor support, and tests. Keep `device-action` as the generic catch-all for ATEM cuts, mixer mutes, and anything device specific; do not grow a first class event per device. Keep `custom-webhook` as the escape hatch; its Phase 3 hardening (H10) must land before it is widened.

- Rundown: `rundown-goto-item` (jump to a named item, not just next and previous).
- ProPresenter: `pp-trigger-previous` (the missing sibling of next); `pp-trigger-prop` (must clear existing props first, then trigger by name, matching the established props stack rule: Clear Props, short delay, then Prop Trigger; never Clear All); `pp-clear-props`.
- Lyrics: `lyrics-next-section`, `lyrics-previous-section` (step buttons for a live operator who does not know the section id; derive next from the song's section order plus the current section).
- Timers: `timer-start`, `timer-stop` (named timers, for example a 5 minute countdown on the stage display).
- Lighting: `lighting-blackout` as a dedicated safety action, not a scene recall that is trusted to reach black.
- Media: `media-play`, `media-stop` (bumpers, countdown videos, stings as first class timed cues).
- Crew comms: `crew-message` (a timed post to production chat, for example "standby cameras" at a timecode point; `stage-message` goes to the stage display, not to the crew).
- Automation control: `triggers-disable`, `triggers-enable` (for unscripted segments where timecode must stop firing without stopping the clock; pairs with the Phase 0 kill switch).
- Per event `enabled` flag and per event retry/re-fire: already delivered in Phase 0; every new event type must honor both from day one.

### 2.6 Lyrics path 2 completion (audit section e; TC/L1)

- Add Next Section and Previous Section controls to the operator view and the confidence display, plus a guarded keyboard shortcut (for example Right Arrow on the operator view, guarded against input focus like the existing tap handler). A Bluetooth or USB footswitch that emulates a keyboard then works for free. Add a MIDI note binding once the 2.1 controller layer exists.
- Expose "clear after last cue" in the song loader UI and pass `clearAfterFrames` through, so a loaded song's last section does not hold on the confidence display forever. Give manual lyrics a clear path from the timeline: today a manual `set-lyrics` carries no `generationKey`, so a song scoped `lyrics-clear` is deliberately ignored and manual lyrics can only be cleared manually.
- Fix lyrics rendering: lines must not concatenate without a space or line break in either preview (observed live: "Test lyric line oneTest lyric line two").
- Song loader must not offer unloadable options: a song with no cue map configured must not appear as a disabled dead option with no explanation. Show why it cannot be loaded, or hide it.

### 2.7 Operator UI hardening (audit H2, H4, H5, UI/M1, UI/M2, UI/M3, UI/M4, UI/M5, UI/L3; UI review 4, 5, 6, 7, 8; live findings)

- Hit areas: minimum 44x44px for every rundown row and timeline row action. Keep the current item's actions always visible; make non current actions visible on focus and on touch. Remove hover only reveal for transport adjacent rows.
- Live bar: never render null for a known org. Render "No live rundown" or "Show ended" states, add an explicit "Reconnecting, showing last known state" label plus `aria-live="polite"` when disconnected, and enlarge the three transport buttons to 44px.
- Timeline: sort a copy of events by `triggerFrame` before rendering and computing `isNext`. Compute "next" from the first unfired event at or after the current frame regardless of running state, so a pre show check can see the first cue. Add an overdue/missed state for unfired events behind the playhead, distinct from upcoming. Show time until the next cue in the timeline header. Add a Retry button on failed rows and a non color "FAILED" text label next to the red icon.
- Timeline rows: show target device name, tolerance, and a short payload summary for device action and webhook events. Today rows show only timecode, action tag, label, and delete.
- Event editing: add an edit affordance on timeline rows wired to `update-event` (time, label, payload, tolerance). Ship the `update-event` field allowlist with this UI (label, triggerTimecode, toleranceFrames, and payload.url only via a validated setter); do not let the editor overwrite `id`, `fired`, `executionStatus`, `triggerFrame`, or `sourceKey`. The remaining H10 webhook hardening (DNS resolution, HMAC, fixed schema) lands in Phase 3.
- Event editor: replace the raw JSON textarea with per action structured fields (message text field, device/action picker, webhook URL field). Add device, tolerance, song, and section selectors: today the editor has only a generic "ACTION DETAILS (JSON)" box, and that JSON is ignored for those fields, so a device test fires with "Choose a target device" and a lyrics test with "Lyrics cue is missing its song or section content". Validate timecode inline as the operator types (the editor already validates on submit; the live finding is that typing "99:99:99:99" or "abc" shows no error and leaves Add Event enabled until submit). Unify the frame rate wording: the selector says "30 fps" while the error says "30fps NDF".
- Lyrics preview on the timecode page: add Clear plus Next/Previous section controls, tied to the 2.5 lyrics events and the 2.6 path 2 work. Today the preview has no controls at all (no Clear, no Next, no Previous) and the page does not even destructure `clearLyrics` or `setLyrics`. Reuse `ConfidenceSlide` auto fit logic instead of fixed `text-2xl`.
- Transport placement: move compact transport (Start/Stop plus running state) into the sticky header alongside the clock. Today Start/Stop live in the Timecode Source panel below the fold and scroll away as events are added.
- Contrast and type: raise dark mode muted to at least `#A3A3A3` (4.5:1 or better), set a 12px floor for operational text, and reserve 9-10px for truly decorative labels only.
- Keyboard and focus: route rundown page buttons through the shared Button component (which already has a proper `focus-visible:ring-2`). Add visible focus rings to row actions. Implement proper tab keyboard support or drop the tab roles in favor of plain buttons. Add a "Skip to rundown" link in `AppShell`.
- Small screens: remove the 760px floor below the container query breakpoint (let rows wrap: duration below title, actions on a second row) or offer a dedicated compact operator view for narrow widths.
- Frame rate lock: disable the frame rate select while running, or confirm gate changes while running.

### 2.8 Error visibility and render cost (audit H25, H26, H27, H28)

- Mirror the `command` case for `connect-device` and `ping`: on send failure, reply to the originating client with `success: false` and the reason, and surface it in the device panel's connection state. Today the operator clicks, nothing happens, and no error is returned.
- Replace `catch {}` on operator paths with surfaced state (last error plus timestamp plus reconnect indicator). Broadcast `event-fired` failure status to display clients through the read only safe projection. Add a single lightweight error reporting sink (D1 backed, reusing the webhook log pattern; no paid service) for DO `console.error` sites and client `error` and `unhandledrejection` handlers, gated so it never blocks the UI.
- Isolate the 10 Hz rundown clock into a small memoized clock component (or update the DOM node directly, as the page already does for progress bars) so the page body does not re-render per tick. Convert show page member, target, and Ontime polls to the existing Relay push or back off when the tab is hidden. Virtualize rundown and cue sheet rows above about 100 items. Remove or gate the per message `[PP WS]` console.log.

### 2.9 CI and test closure (audit H23, H24, QO/M1, QO/M2, QO/M3, QO/M4, QO/L2)

- Add `pnpm --filter @showpilot/web build` to CI before deploy, so a bundling only breakage fails in CI instead of at production deploy time. Add `pnpm --filter @showpilot/desktop test:offline`, a gateway smoke test plus CI job (or delete the gateway in Phase 1 and drop this), and `tsc --noEmit` for `packages/shared` and `apps/mobile` (or document explicitly why each is excluded).
- Add `buildCommand` golden tests for ATEM, DMX (sACN plus Art-Net), Home Assistant, PJLink, VISCA, TCP, and WoL, driven through `resolveTimecodeDeviceAction` with a fake D1, mirroring the existing `http-command-driver.test.ts` pattern.
- Bind test doubles for `LOWER_THIRDS_RELAY` and `CUE_SHEET_RELAY` in `vitest.worker.config.ts` and add a worker test asserting a timecode event reaches the lower thirds stub and that a non-OK response surfaces as `failed`.
- Add a fake timer test for `InternalTimecodeSource` (frame change only emission, `feedElapsed` dedup), a full frame SysEx test for `MtcSource`, and a WebSocket mock test for `useTimecode` reconnect reclaim.
- Validate frames in `parseTimecodeString` (today `01:00:00:99` parses successfully at 30 fps) and add a test for it.
- Enable `vitest --coverage` with a modest, ratcheting threshold (start at the current measured baseline for `src/lib/timecode*`, `src/durable-objects/*`, `src/lib/device-modules/*`) and fail CI below it.
- Extract the shared updater test or add a desktop side equivalent for `apps/desktop` versus `apps/bridge-desktop`.

### 2.10 Connection state consistency (live finding)

- Unify connection state across screens into one model. Today a fresh Timecode load briefly shows a red "Disconnected" dot and 0 events before settling to 17 events and "Stopped"; the Show page Team Chat widget stays on "connecting"; the Board once showed "connected, Live"; the Chat page says "disconnected" in header and connection panel; Song Studio shows a red "Timecode offline" dot while the Timecode page says "Stopped". Loading state must never flash "Disconnected", and two screens must never disagree about the same connection.

### 2.11 Product-wide UX repair (code audit of all routes plus live pass in the Demo org)

Basis: a code-level audit of every route (org pages, auth, public and standalone pages, landing) and a live pass over every reachable screen in the Demo org. Test data from the live pass was removed. These are systemic defects, not polish. Fix them in this phase, not Phase 3.

- Stale SPA navigation (live, highest priority): on first in-app navigation to Board, Timecode, Chat, Team, Cue Sheets, Checklist, Check-in, Incidents, Assets, Stream, Multi-Platform, Lower Thirds, dashboards, and Settings sections, the URL changed but the previous screen (or a skeleton) stayed on screen until reload. Settings section clicks changed `?section=` and the menu highlight but not the content until reload. Find and fix the router and layout state cause so every route renders on navigation without a reload.
- Loading-state discipline: no loading indicator may persist indefinitely. Add timeouts plus error plus retry to Board and Timecode first-load skeletons, Checklist after delete, Incidents, API Recent events, Companion token list, Kiosk Org Chart, and every equivalent list. Loading must never show alongside its empty state (Incidents showed "Loading incidents..." with "No incidents logged yet").
- Silent-failure sweep, product-wide: extend Phase 0.2 honesty to every mutation in the code audit list: check-in toggle (which carries an explicit silently-fail comment), guest-pass creation, schedule ProviderModal and reminders, team moderation and role changes, audio mute and delete, devices toggle and delete (including the modal that can stick on "Removing..."), cue-sheet reload, graphics live-reconcile polling, platforms output polling, setup GO LIVE, and settings autosave revert (which additionally needs a retry that re-applies the reverted value). Every failure must surface with an error and a retry.
- Confirmations on live output and deletes: reuse `useConfirmDialog` for Take Live, Clear Program, Clear all, Go Live, Stop all, scene and layer deletes, audio channel delete, Kiosk "Blank all displays" (one click today blanks lobby displays), team cancel-invitation and moderation actions, and Danger Zone buttons (the confirm step must be visible, not assumed). Fix invite Decline to actually call `rejectInvitation`; today it only navigates home and the invite stays pending.
- Navigation homes and orphans: give assignments and crew-chat real entries (sidebar or account menu, or fold crew-chat into Chat as a kiosk and guest view mode). Keep the sidebar visible on Settings with a true back-to-previous-route (today Settings kills the sidebar and only offers "Back to ShowPilot" to show). Map lt-preview under the Lower Thirds active state. Wire lower-thirds-disabled into the guard that produces that state. Add a breadcrumb and back convention for hidden pages. Fix the board CTA that points at the `/admin` alias (link to team directly). Fix the sidebar silently shrinking per module and permission with no "you don't have X" affordance, and the missing scroll affordance when the sidebar is taller than the viewport.
- One screen per nav entry: Service, Schedule, and Rundown currently render the identical Show Flow composite (timecode panel, Team Chat, Rundown list) with only the highlight differing, and the headings never say Schedule or Rundown. Decide the canonical home for each and make each route render its own screen (a real schedule and calendar view for Schedule, a standalone rundown editor for Rundown).
- Duplicate primary actions: exactly one primary action per empty state. Remove the doubled header plus empty-state buttons on Songs (Import; New song vs Create manually), Stream (Add Input vs Create Live Input), Lower Thirds (New Graphic vs Create your first graphic), Audio (Add Channel vs Add First Channel), Devices (Add Device vs Add First Device), Multi-Platform (Connect a Platform vs Connect Platform), and Board (Add First Item vs header + Add Item).
- Chat room switching: clicking Planning Room changed the URL to `?room=planning` but the header, highlight, and panel stayed on Production Chat. Fix room switching. Explain "7 DAYS" and the "Join production" button, or remove them. Do not mix rooms and member names in one list without distinction.
- Labels and targets: label every placeholder-only input, starting with the entire setup wizard (zero labels today), then check-in code input, crew-chat name input, chat searches, reports search (empty label today), incidents-history filters, and schedule filter select. Raise recurring sub-44px controls to `min-h-11`, starting with invitations, setup, superadmin, streaming toolbars, modal close buttons, chat reaction chips, and reports pagination.
- Shared dialog primitive and route errors: replace hand-rolled modals with the existing `Dialog` component (Escape, focus trap, `aria-modal`) on schedule, audio, devices, graphics, songs import, chat share, and reports modals. Add route-level `errorComponent`s with retry to every route that lacks one (today loader throws fall through to the generic boundary with no in-product retry).
- Keyboard blockers: make reports table rows and audio channel rows keyboard operable (today clickable `tr` elements with no tabIndex, role, or key handler); give team tabs tablist semantics with arrow-key nav and `aria-selected`; add focus-visible styles to the assignments page; remove hover-only reveal for row actions (team remove, checklist and incidents deletes) or add a visible affordance.
- Text and spacing bugs: fix missing spaces ("Go toMulti-Platformto", "0destinations", "1report", "External gateway:None"), clipped Prod Manager dropdowns, unexplained labels ("Balanced", "Native", "ACTUAL", "PM" and "TM" note buttons, "7 DAYS"), the ambiguous report date format 04/11/2026 for Toronto users, "Owner" rendered in an error red, and Settings spinbuttons announced only by number (add accessible labels).
- Settings specifics: mark the current plan unambiguously in Billing (today "Current plan Pro Trial" sits next to an offered "Choose Pro" while "Founding" is highlighted as if selected); give each Integrations Connect button a distinct accessible name; resolve the Production Defaults "Changes save automatically" contradiction with the Confidence Screen disabled Apply and Discard controls; make Notifications categories actually editable (today only one toggle is editable while the copy says categories can be changed); add a visible Save button to the API webhook field (today only an example.com placeholder); add a date picker to Danger Zone "Export report" or remove the choose-a-date copy; add search to the timezone list; explain the Lower Thirds overlay URL and QR (what scanning does).
- Song Studio specifics: preserve lyric line breaks on entry (today two lines become one concatenated line); do not leave the Create dialog on "Creating..." after navigation already moved to the new song; do not show a disabled Save next to "All changes saved" (pick one truth); add a visible section reorder control (today no visible reorder exists); do not leave the preview column as empty black space before any section exists; add a legend for the "PP" badge; show a message (not an empty grid) for search with no match.
- Kiosk identity leak (security, fix in this phase, not Phase 3): the public check-in page restores the previous member from localStorage and renders photo, name, and role with a single Check Out / Check In Again button and no PIN or re-confirmation, so the next person at a shared kiosk can check someone else out. Require re-confirmation or a PIN before acting on a restored identity. Also: invalid org slugs must not silently redirect to `/` (show "organization not found"); check-in errors must not auto-clear after 4s without a retry; timer and overlay must validate the slug instead of polling an indefinite 00:00 or a blank overlay (and note the exposure-by-obscurity issue: live rundown titles, stage messages, slides, and lower-thirds are reachable by guessing an org slug, which the display-pass work in Phase 0.4 must cover).
- Overlay and kiosk URLs published in Settings must resolve: the Lower Thirds overlay URL returned 404, and the kiosk URL redirected to the signed-in Show Flow page instead of a kiosk view. Fix the routes or the published URLs, and add a reachability check to the settings display.
- Terminology and dedup: one name per concept across the product (service vs show vs event; Members vs Crew vs Team; incidents vs faults; destinations vs outputs vs platforms; cue maps vs Timing maps; "serve" vs assignment vs event). Collapse or clearly differentiate the three chat surfaces, the four rundown surfaces, the five overlapping dashboards, the four roster surfaces, the three schedule-copy paths, and the four lower-thirds surfaces plus two overlay routes. Rename "Show Board" to what it displays (crew status), since it is a crew carousel, not show content. Fix the "Save graphic" vs "Save scene" distinction (today tooltip-only) and the three labels for removing live output ("Clear all", "Clear Program", "Stop all").
- Auth and onboarding repair (extends Phase 1.10): fix `/verify-email` to actually check verification status (today it renders success whenever there is no `?error=` param, then Scene 1 blocks org creation, a contradiction); give setup a Back and exit path, a correct step indicator (today "Scene N/5" for six steps 1, 1b, 2, 3, 4, 5), and disclosure that GO LIVE is the only escape from the re-entering wizard; stop GO LIVE from swallowing invite and crew failures (failed invites look identical to success today); do not silently filter invalid crew and invite rows (show a count and a warning); add a spinner and progress to Scene 4 seeding plus a "continue without a rundown" escape; pre-validate reset-password tokens (expired links show a usable-looking form today); give reset success a "Sign in now" button instead of a hardcoded 2s redirect; surface distinct messages for invalid vs revoked vs expired join-chat tokens; do not flash the wrong "invite is for another member" card to authorized users; fix returnTo to accept deep links (today only `/delete-account` survives); map signup errors to human messages instead of raw "[CODE] message"; add a verify-email interstitial after signup; fix the landing concept-page dead anchor (`/#features` has no such id; the section is `id="product"`); state the trial length on landing (today three framings, zero durations, while the app trial is 14 days); define the founding window end date; give download cards an href fallback (today JS-only buttons).
- Narrow and mobile viewport: the live pass could not resize the browser window, so narrow widths are NOT verified live. Codex must verify each screen below the xl breakpoint and fix: the `min-w-[760px]` floors (rundown, reports, audio tables) with a collapsing alternative, devices mobile search (today the mobile view drops search and lists all devices), schedule month calendar hidden on mobile (no jump to non-adjacent weeks), song studio 22rem rail squeeze, setup header collision at ~320px widths, and overlay fixed positioning that assumes a landscape broadcast canvas.
- What was already good, do not regress: Assignments empty states and `role="alert"` errors; Assets confirmed delete and revision-conflict draft preservation; Checklist confirmed delete with scope note; Incidents load error plus Retry and focusable rows; Stream Health per-input degradation to "unknown"; Songs import flow with partial-failure banner and Retry; Song Studio unsaved-changes blocker dialog; delete-account typed DELETE plus password gate; lower-thirds-disabled explainer page.

### Phase 2 gate (all must pass before Phase 3)

- Full test suite green, typecheck green, CI builds the web app.
- MIDI test with real gear where possible: APC pad starts, stops, pauses, and resets transport; APC and MTC work at the same time on separate ports; pad feedback matches running, armed, next, and fired states; unplug and replug keeps mappings; DAW stop stops the ShowPilot clock and automation.
- LTC test: an LTC feed over audio produces timecode; `set-source` rejects unimplemented sources.
- Local mode test: with the cloud WS down, the cached rundown advances and whitelisted device commands run locally, then reconcile revision checked on reconnect; at minimum, queued commands show "queued, not sent" and never silently drop.
- Catalog test: every new event type fires correctly through the relay, honors per event `enabled` and retry, and the props event clears props first and then triggers.
- Lyrics test: Next/Previous section controls advance on operator and confidence views; clear after last cue works; manual lyrics can be cleared from the timeline; lines render with proper spacing and breaks.
- UI test: timeline sorted with correct next highlight, missed state, and time to next; rows show device, tolerance, and payload; editing an event works without deleting it; transport stays visible in the sticky header; lyrics preview has working Clear, Next, and Previous; editor validates inline and offers device, tolerance, song, and section pickers.
- Error visibility test: a failed `connect-device` returns an error to the panel; a failed event is visible on a display client; the 10 Hz clock does not re-render the rundown page body.
- Acceptance notes for what could not be checked live before this prompt: end to end firing to a configured external device, rundown advance via timecode at 00:35:00:00 and 00:45:00:00 on a long run, and Next/Previous behavior for a successfully fired lyrics cue. Cover these with a test device or stub in this gate.
- Product-wide UX gate: every sidebar and Settings-section navigation renders the new screen without a reload; Service, Schedule, and Rundown each render distinct screens; no list or panel shows a loading indicator indefinitely (every loader has a timeout plus error plus retry, and loading never shows alongside its empty state); each listed mutation (check-in toggle, schedule reminders, team moderation, audio and devices mutations, cue-sheet reload, graphics and platforms polling, setup GO LIVE, settings autosave) surfaces an error and a retry on failure; every live-output and delete action in Streaming, Kiosk blank-all, and Danger Zone requires confirmation, and invite Decline actually rejects the invite; setup wizard and listed inputs all have labels and listed controls meet 44px; reports and audio rows are keyboard operable, team tabs have tablist semantics, and no hover-only row actions remain; chat room switching changes header, highlight, and panel together; the overlay URL and kiosk URL published in Settings resolve to their views; timer and overlay validate slugs instead of polling blank states; a restored check-in identity cannot act without re-confirmation or a PIN; each screen is verified below the xl breakpoint with no dropped search, no hidden calendar navigation, and no colliding headers.
- Report the gate results. If anything fails, stop here.

## Phase 3: Polish, billing completion, and hygiene

Goal: close the remaining trust, persistence, and release gaps, and finish billing mechanics without changing price levels.

### 3.1 Billing completion (live finding 3; pricing context below)

- Annual billing: create annual prices in Stripe for Starter, Pro, and Founding Member at the advertised deal (2 months free, about 16.7% off, matching the competitor annual norm of 15 to 17%: ProPresenter 17%, Proclaim up to 17%, WorshipTools 15%). Wire the interval through checkout and plan resolution, and remove the "coming soon" note from `pricing.mjs` and the landing template. Today all three Stripe prices are monthly only and no annual interval exists anywhere in checkout code.
- Plan preselection: carry the landing `plan` parameter through signup into the billing flow. Today landing buttons link to `/login?signup=1&plan=starter|pro|founding` but the login route only reads `signup` and `returnTo`, so no preselection happens.
- Promo and coupon support: set discounts and `allow_promotion_codes` in `buildCheckoutSessionParams`.
- Stripe side trial: decide whether paid checkout should honor a trial period and implement it (`trial_period_days`) or document why the app side 14 day trial stays the only trial. Today the Checkout Session sets no trial, so a paying org is billed from checkout completion.
- Webhook endpoint verification: verify the live Stripe webhook endpoint. Root `DEPLOY.md:159` tells operators to register `https://showpilot.tech/api/stripe/webhook`, but the handler lives in the app at `app.showpilot.tech`. Fix the docs and/or the endpoint so billing sync cannot silently break.
- Pricing context for calibration, not for changing levels: presentation tools cluster at $15 to $30 per month per organization (WorshipTools Pro $19, EasyWorship $17.50 to $27.50, Proclaim On Air $269.99 per year, Pro $399.99 per year) or $29 per month per seat for ProPresenter; streaming tools sit far higher at $99 to $299 per month. ShowPilot's $39/$79/$25 per org per month sits above the per org presentation peers but covers more than presentation (rundowns, timecode automation, crew, devices). Do not reprice in this prompt; that is a business decision for the owner.

### 3.2 Webhook and update hardening (audit H10, remainder)

- Resolve the webhook hostname and reject private or reserved ranges at fire time (today `isSafeAutomationWebhookUrl` blocks literal private IPs, localhost, userinfo, and non-HTTPS but does not resolve DNS, so an attacker controlled hostname resolving to a private IP at fetch time passes).
- Support an optional per webhook HMAC signature header. Never echo arbitrary `payload` fields to the webhook; send only a fixed schema.

### 3.3 Check-in and token hygiene (audit H9, SEC/M1, SEC/M2, SEC/M3, SEC/M4, SEC/M5, SEC/M6)

- Check-in: bind public check-in to a per member secret (the QR/NFC code should carry a random token, not the member ID itself), or require the kiosk/operator to confirm. At minimum, do not return photo or role on the unauthenticated read path, and alert the PM when a check-in or out comes from an unusual IP or device for that member.
- Tokens: default kiosk and companion tokens to short expiry (show weekend, not permanent) with a visible "permanent" warning. Bind tokens to a venue IP range where feasible. Use separate signing secrets per token family. Strip the `?key=` fallback for non-LAN deployments. Set `Cache-Control: private, no-store` on kiosk API responses. Restrict `alert` and `cue` message types to members with `chat:access` (guests get `text` only).
- Guests: prefix all guest display names with `Guest - ` server side (do not accept a freeform name that collides with a member name), and show a distinct guest badge in `ChatPanel`.
- Uploads: verify magic bytes server side (JPEG SOI, PNG signature, PDF `%PDF`), serve all user files with `Content-Disposition: attachment` (or from a separate, cookieless origin with a sandbox content security policy), set `X-Content-Type-Options: nosniff` on the file serve path, and require auth (or a signed, expiring URL) for avatar reads.
- Local setup servers: require a setup token (printed once at first run, stored alongside the config) for all mutating local endpoints and for `GET /status` when it contains secrets. Never pre-fill secrets into the setup HTML. Drop the `!origin` allow rule (require the localhost origin or the setup token).
- Query hygiene: keep the bound parameter discipline, add a lint or test rule banning `${...}` inside `prepare()` except for the two audited files, and escape `%`, `_`, and `\` in LIKE needles with `ESCAPE '\'`.
- Smaller gaps: require the invitee's session or a signed invite link for invitation details; move super-admin from a hardcoded email string to a platform role plus second factor pattern that needs no paid service, and alert on super-admin use; set explicit short session expiry for operator roles, require verified email for any write permission, and narrow wildcard trusted origins; fail closed for auth and token endpoints (fail open only for read only display paths) and alert on rate limit storage errors; move inline scripts and styles to nonces or hashes and restrict `connect-src` to the app origin plus relay origins; log key creation, rotation, and revocation with actor plus timestamp.

### 3.4 Reconnect and state hygiene (audit ARCH/M1 to M6)

- Unify on one Bridge command path (server RPC) with one timeout policy, or give `pendingClientCommands` the same 10s timeout and a single "operation in flight" key. Document and align `disconnect-device` semantics (today the panel path deliberately no-ops while the server path sends to the Bridge, so venue connections can leak after panels close).
- Add a shared, versioned device command schema (actionId enum plus param ranges per protocol) validated both in `device-modules/*` at build time and in `apps/bridge/src/bridge.ts` before dispatch. Validate TCP targets against the configured device list instead of parsing them from the string.
- On Bridge reconnect, have the Bridge send a single authoritative `bridge-status` plus per target `device-status` snapshot before the relay broadcasts "online" to clients, and have the relay hold the previous `connectedTargets` until that snapshot arrives (or mark status "reconnecting, last known ...").
- Adopt `wrangler d1 migrations apply` with a single linear history (fold the timestamped migrations into the numbered sequence, or vice versa) and make CI apply migrations to a scratch D1 and run the app's migration check against it. Keep the manifest as a belt and braces check, not the system of record.
- Add chat retention pruning (for example keep 90 days, or archive to D1/R2 and prune DO SQL), and either mirror relay chat to D1 or document that DO SQL is the only chat store.
- Never auto-wipe a room on open. Require an explicit `switch-show` command (revision checked, confirmed by the UI) and keep the old room's state until the new room is seeded successfully.

### 3.5 Remaining UI polish (audit UI/M6, UI/M7, UI/M8, UI/L1, UI/L2, UI/L4)

- Check-in: show an inline per row error plus Retry on toggle failure (the chat panel already does this pattern for failed sends). Replace `window.confirm` with `ConfirmDialog`. Enlarge the In/Out toggle to 44px.
- Kiosk and timer: under `prefers-reduced-motion: reduce`, replace blinking with a static red or amber background and border. Same phase information, no animation.
- Navigation: promote Settings to a sidebar item. Add Assignments or remove the orphan route. Rename "Show Board" to something non-overlapping (for example "Crew Board") or merge the show page tabs with the sidebar so one concept has one home.
- Fullscreen exit: keep it faintly visible (for example 40% opacity) and fade fully on hover, instead of invisible until hover.
- Settings page: keep a collapsed sidebar or a persistent back affordance in the settings header, instead of losing navigation context.
- Mobile live view: add Pause and Next to the live show action row for the on foot operator.

### 3.6 Release and dependency hygiene (audit ARCH/L1 to L4, QO/L1, QO/M5, QO/M6)

- Consider a separate, version pinned Worker (or at least a staged rollout plus instant rollback runbook) for the relay and bridge API surface, and pin Bridge client URLs to `app.showpilot.tech` rather than relying on the marketing redirect.
- Add a per DO socket cap with a clear "room full" close code, and a per socket inbound rate limit (especially for `feed-tc`, which is legitimately 10 Hz from one master but should never be 100 Hz from many).
- Move cron work to a separate Worker or a Cloudflare Queue with retries and dead letter handling. Alert on repeated cron failure.
- Split `app_setting` into a proper settings table (typed, cached) and a dedicated rundown snapshot store (or drop the snapshot; see Phase 1).
- Add a post deploy smoke gate that auto invokes `wrangler rollback` on health check failure, and document the migration state that pairs with each rollback target.
- Delete dead code after confirming with `tsc` plus a bundle analysis: `RundownPanel.tsx`, `ChatCompact.tsx`, `tooltip.tsx`. Confirm before deleting, since a basename scan can miss dynamic imports.
- Add Dependabot or Renovate for pnpm plus Cargo, a CI `pnpm audit --prod` gate (allow listed with expiry dates), delete `apps/gateway/package-lock.json` in favor of the workspace lockfile (or delete the gateway in Phase 1 and drop this), move devtools to `devDependencies`, and add an `engines` field matching CI's Node 24. Annotate each pnpm override with the CVE or advisory it addresses.

### Phase 3 gate (all must pass before the final report)

- Full test suite green, typecheck green, CI builds the web app and applies migrations to a scratch D1.
- Billing test: annual checkout creates an annual subscription at 2 months free and plan resolution honors the interval; landing plan preselection reaches the billing flow; a promo code applies; the live Stripe webhook endpoint is verified against the handler host.
- Webhook test: a DNS rebinding hostname is rejected at fire time; a webhook payload contains only the fixed schema; an HMAC signature header is sent when configured.
- Token test: kiosk and companion tokens default to short expiry; guest names render with the `Guest - ` prefix and badge; uploads with spoofed MIME types are rejected by magic byte checks.
- Hygiene test: room open with a mismatched show does not wipe state; Bridge reconnect delivers a status snapshot before "online" broadcasts; cron work retries through a queue; rollback smoke gate exists.
- Report the gate results. If anything fails, stop here.

## Final gate: full suite verification and report

After all four phases:

1. Run the entire test suite, typecheck, and the production build from a clean checkout.
2. Run one full show length rehearsal against the acceptance checklists: kill switch, per event disable and retry, honest failure display, disconnect behavior, jump and format guards, MIDI control with a real APC Mini where possible, LTC feed, the full new event catalog, and annual checkout.
3. Report, per phase: what changed (files and behavior), gate results, any findings you could not verify and why, and anything you deliberately deferred with a reason. Do not claim a gate passed that did not run.

## Constraints restated (do not negotiate these away)

- No signing secrets, no new paid services, no price level changes.
- No mega diff: one reviewable change set per phase, gates between phases, stop on gate failure.
- Do not break the rundown core, the SMPTE math, server authoritative automation, or the existing test suite.
- Audio following lyrics is out of scope. It is a separate project.
- Keep every operator facing failure visible. A cue that did not fire, a command that did not send, and a clock that stopped must all say so on screen. Silent success is the bug this prompt exists to kill.
