# ShowPilot safety-pass finish run: WS8 final gate

Started 2026-11-15. Closed for reporting 2026-11-18.

Final main: `332f039d6095559e8e070971efe400ddf13000a7`. Acceptance remains partial.

## Final ledger counts

Verified means complete within the recorded evidence scope.


| Phase | Complete (verified) | Partial | Deferred | Blocked |
| :--- | ---: | ---: | ---: | ---: |
| global | 8 | 1 | 0 | 0 |
| 0 | 38 | 0 | 0 | 0 |
| 1 | 37 | 0 | 0 | 0 |
| 2 | 68 | 11 | 0 | 0 |
| 3 | 26 | 10 | 3 | 1 |
| final | 5 | 3 | 0 | 0 |
| 0.4 | Included in Phase 0 | | | |

## Phase 0

#73 ships kill switch, per-event disable/retry, honest cue failures, confirmations, deliberate shortcuts, MTC decoder contiguity and bounded concurrent execution. #74 ships per-installation hashed Bridge credentials and native vaults; #75 ships protected display access and browser show-day acceptance. The recorded verification-only gate includes 1248 unit/116 Worker tests, typecheck/build and three browser rehearsals, plus unsigned four-platform run 41965318862. Physical venue acceptance remains in Phase 2 and the end-of-pile list.

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows and specific reasons are enumerated in the complete disposition list below.

## Phase 0.4

Display-pass work is indexed under Phase 0 by the source ledger. Merged #75, #153 and #155 gate timer/overlay/display reads, remove the legacy graphics read and bound pass checks/expiry; #366 restores Last checked. Historical smoke-display-access.mjs, smoke-display-deadlines.mjs and smoke-legacy-display-read.mjs record the concrete access/scope/expiry checks. Current main CI and deployment confirm the integrated changes are shipped.

## Phase 1

#76 scopes clocks by show and validates MIDI sources. #79 to #87 harden relay claims, live authority, cached read leases and request-scoped D1 access. #88 to #93 ship feed watchdog, sequence recovery, single-writer automation and jump/format/tolerance guards. #95/#96 persist diffs; #97 makes active-show publication transactional after durable preparation. #98/#99 ship Bridge takeover and destination allowlisting; #100 to #108 hash tokens, encrypt credentials and verify ProPresenter authentication. #77 adds signing readiness, #78 removes the obsolete gateway and #94 repairs second-organisation onboarding. The ledger records the Phase 1 full-suite and named acceptance checks as verification-only closures, without claiming room-open auto-wipe was repaired; that separate Phase 3 requirement is blocked at row 337.

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows and specific reasons are enumerated in the complete disposition list below.

## Phase 2

#109 to #117 ship MIDI reconnect/transport/controllers, LTC, local mode and latency compensation. #118 to #126 ship the cue catalogue and lyric controls; #127 to #170 cover editor/timeline, operator visibility, recovery, CI builds, wire tests and coverage. #171 to #307 repair onboarding, navigation, scheduling, chat, graphics, reports and native recovery. Verification-only acceptance is recorded by #213 (catalogue/failures), #215 (native/virtual MIDI), #216 (local handoff), #221 (UI/lyrics) and #225 (2710-second long run). These are fixture/software acceptance records; the parked physical gates are retained separately.

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows and specific reasons are enumerated in the complete disposition list below.

WS4 shipped #356 to #365: bounded pending recovery, settled mobile content, chat wording and reactions, mobile failure reporting, role confirmation, touch targets and room naming. Items 1 and 2 remaining ledger clauses stay partial. Item 2 loading-state clauses and a fresh live sub-xl viewport pass were not verified in this run. The six (C) chat-text wording questions remain with Rey.

## Phase 3

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows and specific reasons are enumerated in the complete disposition list below.

Chunk map and merged work:

- #368: WS7 A: harden automation webhooks (fire-time DNS check, fixed schema, optional HMAC); merge `1c130e571792ab8317bd5664902f84a7f701c45e`.

- #369: WS7 B: wire annual billing, promo codes, and the Stripe trial; merge `3a69531ae97883157ac48bf268b71bd13677773b`.

- #370: WS7 C: carry the landing plan choice through signup into billing; merge `0f6dd7c9d2f07faf21d01dcee902df19f5f89247`.

- #371: WS7 D: point the Stripe webhook doc at app.showpilot.tech; merge `b33495bbc8aa4308e946b312cd12b8bcede7d40e`.

- #372: WS7 E (kiosk side): scoped-link expiry defaults, private kiosk API cache, LAN-gated ?key=; merge `29b5a9c798aa84e359dcf79174490e0c4a4fca0c`.

- #373: WS7 E2: downgrade guest alert/cue chat messages to text; merge `8a0afcc9f9442bd610fe912f9a1da22a73e20251`.

- #374: WS7 F: prefix guest chat display names with Guest - server-side; merge `f7867811ef05484ab0b807adec8c10e7765b643a`.

- #375: WS7 G: strip photo/role from unauthenticated check-in read (row 322, slice 1); merge `e02f1ec6f70e2d15230973bb1ad7f98eb8c441ba`.

- #376: WS7 H: verify upload bytes, attachment disposition for chat files, scope avatar cache; merge `afc3c95797a9a79cd3f3bb08b58e74a06aafc290`.

- #377: WS7 I: escape LIKE needles in incident search + SQL hygiene guard (row 327); merge `f8b114a14949472869b1d93e0e84c0ec7900e502`.

- #378: WS7 J1: narrow trusted origins, pin session policy, audit-log kiosk/companion tokens (row 328, mechanical slice); merge `5a7682b408ca051ba62afa18f5cb10a91127c979`.

- #379: WS7 J2: CSP per-request script nonces + restricted connect-src (row 328); merge `97ccfc315d463b0d3343fe874a12f018b349aa16`.

- #380: WS7 K: require a setup token for Bridge setup saves (row 326); merge `51945e3beb00ca4aae52043871c60572f25a19a2`.

- #381: WS7 L: client-path in-flight key, unified 10s connect timeout, disconnect semantics (row 332); merge `87c6d2e5918afefd1b4cae1ef0506d6aa109cc7b`.

- #382: WS7 M: shared versioned device command schema (row 333); merge `6256b2b80385266f8fa47e9bdfa81f0e8e61376c`.

- #383: WS7 N: reconnect snapshot honesty : hold restored targets until the Bridge confirms (row 334); merge `775c6dfb65eed88375cb2d79ab2e395f3aba7e30`.

- #384: WS7 O: document DO-only chat store and retention reality (row 336); merge `c72ddfce60687b88d777c5135b677cde3b0a9825`.

- #385: WS7 P: single numbered migration history + CI scratch-D1 check (row 335); merge `935de8ba23ccb7a9b0899c4dedcb4aebb5d6e4d9`.

- #386: WS7 G2: per-member check-in secret (row 322, migration 0098); merge `ad94d6f453b881ad371ed8bcb90cea715bfacd29`.

- #387: Cap relay WebSockets and rate-limit inbound socket messages; merge `e37d930dc4d88e40373a6c10100811367a97c94b`.

- #388: Move cron maintenance to retryable Cloudflare Queue jobs; merge `e33472ababda6534757ced98275a40accc7e83bf`.

- #389: Move saved rundown templates into dedicated storage (WS7 S1); merge `b7d21cd3cee0a2bbc9b4ce78c3ac1d8b72884ce2`.

- #390: Move web-funneled org settings into a dedicated org_setting table (WS7 S2a); merge `9778c5e978e585046ef84aead65a331657a5880d`.

- #391: fix: move remaining 22 org settings to org_setting (WS7 S2b); merge `ae7259ab85c86207dd41d38c196d8984c13047eb`.

- #392: WS7 T: relay rollout runbook and Bridge app host pin; merge `f47cba1d0090fd96b74e068c1ee5c223769169a5`.

- #393: WS7 U: roll back failed web verification and document migration pairing; merge `8cab29902d70d4f894a40b6b8747a10d8e484e85`.

- #394: fix: keep fullscreen exit control visible (WS7 V1); merge `9554733acc519eb059e1a8878a7b65a36eaf43da`.

- #395: fix: honor reduced motion for timer danger and overtime warnings; merge `321fb8ed811afd754f1192ae900eeac1a95d317a`.

- #396: fix(web): show failed crew toggles on the affected member row; merge `fb1ba21979ddfe5ca0403ace0461e80e51627b1e`.

- #397: fix(web): add Settings to workspace sidebar; merge `fa5b266f61f60cc8e8ae62afff5a2d086477710b`.

- #398: WS7 V5: native mobile live Pause and Next controls; merge `e8910fdc7122add5a6f983f6da6fea3c760038f1`.

- #399: fix(web): remove unused components (WS7 W); merge `008cb326811d7331cad37f17c27c8c0b8daa0802`.

- #400: WS7 X: enforce dependency hygiene (ledger 356); merge `036bc6594872ac14b33b0ca68db1a8b292852384`.

- #412: Fix concurrent webhook event loss with dedicated event rows; merge `bcd572f8feaafac03ac475bc9a246ddbc9f90541`.

## Dispositions

S3 live-state storage is deferred pending live rehearsal. #376 avatar reads still need signed URLs. J1 session length remains with Rey. Nonce CSP from J2 prevents generate-icons.html from running. Desktop and Bridge Linux .deb packages both ship /usr/bin/showpilot-bridge. Cargo audit is not a CI gate. Chunk X retains 48 allow-listed audit findings, expiring 2027-02-28, with boilerplate rather than finding-specific reasons. Open Dependabot #401 to #411 and #413 form a triage queue; #412 is the merged S4 webhook PR.

## Migration record

0097, 0098, 0099, 0100, 0101 and 0102 are recorded applied to production D1 in [applied-remote.txt](../apps/web/prisma/migrations/applied-remote.txt). Final recording commit: 332f039d.

## End-of-pile list for Rey

- Flip the repo back to private.

- Hardware gates: APC/MTC real session, including pad start/stop/pause/reset, simultaneous APC + MTC, feedback, unplug/replug and DAW stop; LTC feed over audio; local mode with cloud WS down; long-run advances at 00:35:00:00 and 00:45:00:00; end-to-end firing to a real configured external device.

- Booth Bridge evidence: hash installed Bridge/Desktop binaries at 139 Millwick Dr and capture Cloudflare log for 2026-11-15 about 08:31 EST, faithfire-production.

- Demo Bridge handshake key issued by Demo.

- Founding-window end date plus timezone; the mechanism stores bare YYYY-MM-DD.

- Operator session-length call.

- WS4 items 1 and 2 remaining ledger clauses.

- Six (C) chat-text wording questions from the WS4 audit.

- Stripe follow-ups: annual prices in the live account, signing secrets, webhook host check in dashboard.

- Provision the chat-pass signing secret.

## Complete unresolved ledger dispositions

- Row 18 (`a41fbde1046806aa`), **partial**: Phase-order acceptance is not fully satisfied: Phase 2 loading/mutation/viewport gates remained open when Phase 3 proceeded (#353, #356, #357).
- Row 246 (`01938da22bad50e9`), **partial**: The D1 error sink and failure projections shipped (#134, #358, #365), but #356 explicitly leaves ack-success/genuine-failure/lost-ack acceptance and the full mutation checklist unestablished.
- Row 268 (`9a197d9687fde3ba`), **partial**: Checklist-after-delete and the exhaustive equivalent-list/no-indefinite-loader audit remain open; #357 explicitly limits its six checks to mobile initial/settled reads.
- Row 269 (`19ab826391d68d1f`), **partial**: The full catalogued mutation error-plus-retry checklist remains unverified; #356 closes reconnect requeue bounds and honest retirement wording only.
- Row 283 (`5d30364193f8508f`), **partial**: #300 clarifies operator/output labels and #364 unifies Production Chat naming; complete differentiation of the three chat, four rundown, five dashboard, four roster, three copy and lower-thirds surfaces remains unverified.
- Row 284 (`409d9865b4141229`), **partial**: Founding-window end date and timezone still require Rey; #185 closes landing/download mechanics, not that business input.
- Row 285 (`4e2cdcca026fe871`), **partial**: Fresh live sub-xl viewport pass remains pending; #157 and #229 provide historical compiled-fixture navigation/calendar evidence, not the requested fresh live screen-by-screen pass.
- Row 291 (`55182c9ecbc58295`), **partial**: Real APC/MTC session pending: pad start/stop/pause/reset, simultaneous APC + MTC, feedback, unplug/replug and DAW stop; #215 proves virtual-port/fixture coverage only.
- Row 292 (`02774d6317504603`), **partial**: Physical LTC feed over audio pending; #215 and smoke-native-ltc-relay.mjs use generated PCM in place of audio capture hardware.
- Row 293 (`bbc36d7d1b7e4a53`), **partial**: Venue local mode with cloud WS down pending; #216 verifies stopped local Worker, native loopback and an equipment simulator, not the installed venue setup.
- Row 298 (`3277f632c1aea066`), **partial**: Real configured external-device firing and venue long-run advances at 00:35:00:00/00:45:00:00 remain parked; #225 run 42454853635 and simulator/lyrics rehearsals satisfy the text's stub option only.
- Row 299 (`2533590ebd67b0d8`), **partial**: Product-wide UX acceptance remains partial on WS4 mutation checklist, Checklist-after-delete/equivalent-list loading and fresh live sub-xl screen audit (#356, #357).
- Row 308 (`84219ae02728c669`), **partial**: #369 implements annual billing; annual Starter/Pro/Founding prices still need creation in live Stripe.
- Row 312 (`a5bc52cc92687bf4`), **partial**: #371 fixes the documented host to app.showpilot.tech; live Stripe dashboard endpoint host verification remains pending.
- Row 325 (`34578e3f829ffc21`), **deferred**: #376 ships byte sniffing, attachment disposition and private avatar cache; signed expiring avatar-read URLs are explicitly deferred to preserve native image loading.
- Row 328 (`4fa9d31819993c86`), **partial**: #378 pins seven-day sessions rather than short operator expiry and leaves platform-role super-admin, second factor and use alerting for a later build; #379 ships CSP. Session policy remains with Rey.
- Row 336 (`0a600b9ffb2beffa`), **partial**: #384 documents DO-only live chat storage but explicitly confirms no age-based retention pruning; the requirement's pruning limb remains unimplemented.
- Row 337 (`e020640319bf917a`), **blocked**: RundownRelay.ts fetch mismatch branch (lines 711-738) still clears items/timer and persists on writable show/date mismatch; no explicit revision-checked switch-show command exists. #97 fixes active-pointer publication, not this branch.
- Row 353 (`4acaad0d38a10dd9`), **deferred**: S3 deliberately retains live rundown state, active-show pointers and graphics live state in app_setting pending a live rehearsal gate; #389/#390/#391/#412 move templates, editable settings and webhook history only.
- Row 356 (`646ff04058e2627b`), **deferred**: #400 omits reproducible CI cargo audit installation; Dependabot covers Cargo updates. Cargo audit gate remains an explicit deferred gap.
- Row 361 (`1036150e09dfc7f9`), **partial**: #369/#370 implement interval/promo/preselection mechanics; live annual prices and Stripe dashboard webhook host verification remain pending.
- Row 364 (`06abe2ebc5b2979c`), **partial**: Room-open mismatch still wipes state in RundownRelay.ts:711-738 (row 337); #383/#388/#393 satisfy reconnect snapshot, queue retries and rollback limbs.
- Row 372 (`cffc19c3e6de5a28`), **partial**: One complete venue rehearsal is not recorded: real APC/MTC, physical LTC audio, installed cloud-down local mode, long-run venue advances, real external-device firing and live annual checkout remain pending.
- Row 378 (`6eaf7a8e4c663b1c`), **partial**: Changes are split into reviewable PRs, but the gate-between-phases clause remains partial: #353 retains Phase 2 at 68/79 while later Phase 3 work is merged.
- Row 381 (`f25cdee668bf2a3f`), **partial**: #356 explicitly leaves full mutation ack/failure/lost-ack acceptance open; #357 leaves product-wide loading recovery open, despite #134/#358/#365 error reporting.

## Evidence corrections from WS8 review

Row 337 is blocked: the writable show/date mismatch branch in RundownRelay.ts still clears room state on open. Row 364 is partial on that limb. Row 336 is partial because #384 documents DO-only storage but explicitly confirms no age-based pruning. These gaps contradict the first WS8 draft and are not hardware gates. Row 328 also retains the deferred platform-role super-admin, second-factor and use-alerting work described in #378.

## Complete unresolved ledger dispositions

- Row 18 (`a41fbde1046806aa`), **partial**: Phase-order acceptance is not fully satisfied: Phase 2 loading/mutation/viewport gates remained open when Phase 3 proceeded (#353, #356, #357).
- Row 246 (`01938da22bad50e9`), **partial**: The D1 error sink and failure projections shipped (#134, #358, #365), but #356 explicitly leaves ack-success/genuine-failure/lost-ack acceptance and the full mutation checklist unestablished.
- Row 268 (`9a197d9687fde3ba`), **partial**: Checklist-after-delete and the exhaustive equivalent-list/no-indefinite-loader audit remain open; #357 explicitly limits its six checks to mobile initial/settled reads.
- Row 269 (`19ab826391d68d1f`), **partial**: The full catalogued mutation error-plus-retry checklist remains unverified; #356 closes reconnect requeue bounds and honest retirement wording only.
- Row 283 (`5d30364193f8508f`), **partial**: #300 clarifies operator/output labels and #364 unifies Production Chat naming; complete differentiation of the three chat, four rundown, five dashboard, four roster, three copy and lower-thirds surfaces remains unverified.
- Row 284 (`409d9865b4141229`), **partial**: Founding-window end date and timezone still require Rey; #185 closes landing/download mechanics, not that business input.
- Row 285 (`4e2cdcca026fe871`), **partial**: Fresh live sub-xl viewport pass remains pending; #157 and #229 provide historical compiled-fixture navigation/calendar evidence, not the requested fresh live screen-by-screen pass.
- Row 291 (`55182c9ecbc58295`), **partial**: Real APC/MTC session pending: pad start/stop/pause/reset, simultaneous APC + MTC, feedback, unplug/replug and DAW stop; #215 proves virtual-port/fixture coverage only.
- Row 292 (`02774d6317504603`), **partial**: Physical LTC feed over audio pending; #215 and smoke-native-ltc-relay.mjs use generated PCM in place of audio capture hardware.
- Row 293 (`bbc36d7d1b7e4a53`), **partial**: Venue local mode with cloud WS down pending; #216 verifies stopped local Worker, native loopback and an equipment simulator, not the installed venue setup.
- Row 298 (`3277f632c1aea066`), **partial**: Real configured external-device firing and venue long-run advances at 00:35:00:00/00:45:00:00 remain parked; #225 run 42454853635 and simulator/lyrics rehearsals satisfy the text's stub option only.
- Row 299 (`2533590ebd67b0d8`), **partial**: Product-wide UX acceptance remains partial on WS4 mutation checklist, Checklist-after-delete/equivalent-list loading and fresh live sub-xl screen audit (#356, #357).
- Row 308 (`84219ae02728c669`), **partial**: #369 implements annual billing; annual Starter/Pro/Founding prices still need creation in live Stripe.
- Row 312 (`a5bc52cc92687bf4`), **partial**: #371 fixes the documented host to app.showpilot.tech; live Stripe dashboard endpoint host verification remains pending.
- Row 322 (`73a78966b1c11ca2`), **partial**: #375 removes public photo/role and #386 adds opt-in hashed member secrets; unusual-IP/device PM alerts are explicitly scoped out because tracking state and recipient rules do not exist.
- Row 323 (`5ae835748463a719`), **partial**: #372 defaults links to 90 days rather than a show weekend; venue-IP binding is absent and chat passes still use KIOSK_SECRET pending a separate secret/rollover design. #373 closes guest message-type restrictions.
- Row 325 (`34578e3f829ffc21`), **deferred**: #376 ships byte sniffing, attachment disposition and private avatar cache; signed expiring avatar-read URLs are explicitly deferred to preserve native image loading.
- Row 327 (`56d20ede8dc26816`), **partial**: #377 escapes LIKE needles and guards interpolation, but permits 167 reviewed interpolation entries rather than banning all except the two audited files specified by the requirement.
- Row 328 (`4fa9d31819993c86`), **partial**: #378 pins seven-day sessions rather than short operator expiry and leaves platform-role super-admin, second factor and use alerting for a later build; #379 ships script nonces/connect-src but leaves inline styles unchanged. Session policy remains with Rey.
- Row 336 (`0a600b9ffb2beffa`), **partial**: #384 documents DO-only live chat storage but explicitly confirms no age-based retention pruning; the requirement's pruning limb remains unimplemented.
- Row 337 (`e020640319bf917a`), **blocked**: RundownRelay.ts fetch mismatch branch (lines 711-738) still clears items/timer and persists on writable show/date mismatch; no explicit revision-checked switch-show command exists. #97 fixes active-pointer publication, not this branch.
- Row 353 (`4acaad0d38a10dd9`), **deferred**: S3 deliberately retains live rundown state, active-show pointers and graphics live state in app_setting pending a live rehearsal gate; #389/#390/#391/#412 move templates, editable settings and webhook history only.
- Row 356 (`646ff04058e2627b`), **deferred**: #400 omits reproducible CI cargo audit installation; Dependabot covers Cargo updates. Cargo audit gate remains an explicit deferred gap; 13 override comments still say reason unknown rather than naming an advisory.
- Row 361 (`1036150e09dfc7f9`), **partial**: #369/#370 implement interval/promo/preselection mechanics; live annual prices and Stripe dashboard webhook host verification remain pending.
- Row 363 (`06eea448b9fc3c26`), **partial**: #372 provides bounded 90-day token defaults, not the required short show-weekend default; #374 guest prefixes/badges and #376 spoofed-MIME rejection are satisfied.
- Row 364 (`06abe2ebc5b2979c`), **partial**: Room-open mismatch still wipes state in RundownRelay.ts:711-738 (row 337); #383/#388/#393 satisfy reconnect snapshot, queue retries and rollback limbs.
- Row 372 (`cffc19c3e6de5a28`), **partial**: One complete venue rehearsal is not recorded: real APC/MTC, physical LTC audio, installed cloud-down local mode, long-run venue advances, real external-device firing and live annual checkout remain pending.
- Row 378 (`6eaf7a8e4c663b1c`), **partial**: Changes are split into reviewable PRs, but the gate-between-phases clause remains partial: #353 retains Phase 2 at 68/79 while later Phase 3 work is merged.
- Row 381 (`f25cdee668bf2a3f`), **partial**: #356 explicitly leaves full mutation ack/failure/lost-ack acceptance open; #357 leaves product-wide loading recovery open, despite #134/#358/#365 error reporting.

## Evidence corrections from WS8 review

Row 337 is blocked: the writable show/date mismatch branch in RundownRelay.ts still clears room state on open. Row 364 is partial on that limb. Row 336 is partial because #384 documents DO-only storage but explicitly confirms no age-based pruning. These gaps contradict the first WS8 draft and are not hardware gates. Row 328 also retains the deferred platform-role super-admin, second-factor and use-alerting work described in #378.

Additional WS8 clause findings: #386 omits unusual-IP/device PM alerts (row 322). #372 uses 90-day defaults, lacks venue-IP binding and retains shared chat-pass signing (rows 323/363). #377 guards 167 interpolation entries instead of the requested two-file exception (row 327). #379 leaves inline styles unchanged (row 328). #400 records 13 override reasons as unknown (row 356). These are retained as specific open dispositions, not treated as complete.
