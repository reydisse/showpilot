# ShowPilot safety-pass finish run: WS8 final gate

Started 2026-11-15. Closed for reporting 2026-11-18.

Final main: `332f039d6095559e8e070971efe400ddf13000a7`. Acceptance remains partial.

## Final ledger counts

Verified means complete within the recorded evidence scope.


| Phase | Complete | Partial | Deferred | Blocked |

| :--- | ---: | ---: | ---: | ---: |

| global | 0 | 9 | 0 | 0 |

| 0 | 37 | 1 | 0 | 0 |

| 1 | 37 | 0 | 0 | 0 |

| 2 | 64 | 15 | 0 | 0 |

| 3 | 29 | 8 | 3 | 0 |

| final | 1 | 7 | 0 | 0 |

## Phase 0

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows are enumerated below.

- Row 54 (`7fdc93392190474b`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

## Phase 0.4

Display-pass work is indexed under Phase 0 by the source ledger. Its accumulated verification is retained; unresolved integrated verification is not promoted.

## Phase 1

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows are enumerated below.

## Phase 2

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows are enumerated below.

WS4 shipped #356 to #365: bounded pending recovery, settled mobile content, chat wording and reactions, mobile failure reporting, role confirmation, touch targets and room naming. Items 1 and 2 remaining ledger clauses stay partial. Item 2 loading-state clauses and a fresh live sub-xl viewport pass were not verified in this run. The six (C) chat-text wording questions remain with Rey.

- Row 246 (`01938da22bad50e9`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 268 (`9a197d9687fde3ba`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 269 (`19ab826391d68d1f`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 270 (`b4ee5ed6e65805a2`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 275 (`8fb2f980425e345c`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 283 (`5d30364193f8508f`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 284 (`409d9865b4141229`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 285 (`4e2cdcca026fe871`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 286 (`36fbbe0b66ff1b12`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 291 (`55182c9ecbc58295`): Real APC/MTC session (start/stop/pause/reset, simultaneous APC + MTC, feedback, unplug/replug, DAW stop); LTC over audio; cloud-WS-down local mode; long-run advances at 00:35:00:00 and 00:45:00:00; real configured external-device firing remain parked. Recorded fixture coverage is retained.

- Row 292 (`02774d6317504603`): Real APC/MTC session (start/stop/pause/reset, simultaneous APC + MTC, feedback, unplug/replug, DAW stop); LTC over audio; cloud-WS-down local mode; long-run advances at 00:35:00:00 and 00:45:00:00; real configured external-device firing remain parked. Recorded fixture coverage is retained.

- Row 293 (`bbc36d7d1b7e4a53`): Real APC/MTC session (start/stop/pause/reset, simultaneous APC + MTC, feedback, unplug/replug, DAW stop); LTC over audio; cloud-WS-down local mode; long-run advances at 00:35:00:00 and 00:45:00:00; real configured external-device firing remain parked. Recorded fixture coverage is retained.

- Row 298 (`3277f632c1aea066`): Real APC/MTC session (start/stop/pause/reset, simultaneous APC + MTC, feedback, unplug/replug, DAW stop); LTC over audio; cloud-WS-down local mode; long-run advances at 00:35:00:00 and 00:45:00:00; real configured external-device firing remain parked. Recorded fixture coverage is retained.

- Row 299 (`2533590ebd67b0d8`): WS4 items 1 and 2 remaining clauses, item 2 loading-state coverage and fresh live sub-xl viewport pass remain unverified.

- Row 300 (`eb3b89162acf053d`): WS4 items 1 and 2 remaining clauses, item 2 loading-state coverage and fresh live sub-xl viewport pass remain unverified.

## Phase 3

The ledger preserves each recorded verification-only closure and its original test scope. Outstanding rows are enumerated below.

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

- Row 308 (`84219ae02728c669`): Annual prices must still be created in the live Stripe account.

- Row 312 (`a5bc52cc92687bf4`): Documentation host corrected; Stripe dashboard webhook host verification remains with Rey.

- Row 313 (`6f4a8e5e54e2beba`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 325 (`34578e3f829ffc21`): Deferred avatar signed-URL follow-up from #376; other upload hardening shipped.

- Row 328 (`4fa9d31819993c86`): J1 operator session-length policy remains a Rey decision; J2 nonce CSP shipped.

- Row 337 (`e020640319bf917a`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 345 (`04543f6834589263`): Requirement-wide closure not demonstrated by the accumulated evidence; clause-specific verification remains open.

- Row 353 (`4acaad0d38a10dd9`): S3 deferred: live rundown state, active-show pointers and graphics live state remain in app_setting; moving the show-critical path requires a live rehearsal gate.

- Row 356 (`646ff04058e2627b`): Cargo updates covered by Dependabot; CI cargo audit gate deferred.

- Row 361 (`1036150e09dfc7f9`): Live annual prices and Stripe dashboard webhook host verification remain pending.

- Row 364 (`06abe2ebc5b2979c`): Room-switch limb requires further evidence review; reconnect, queue and rollback limbs shipped.

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
