# Web audit follow-up — 28 September 2026

## Scope

Reviewed the 20 September `AUDIT.md`, `FIXED-LOCAL.md` and `finding-status.json` in the supplied Downloads audit folder. The register contains 113 findings: 111 recorded as fixed locally, with A09 (release evidence) and A22 (native push configuration) partial. Those candidate fixes are already in repository history; this follow-up does not claim to have reproduced all 113 findings again.

The user authorized commit, push and deployment, then limited this release to web. Native binaries, Expo project linkage, APNs/FCM setup and signed-device push acceptance remain deferred. The proposed move to `app.showpilot.tech` is a separate task.

## First release completed

The requested production fixes were committed in `1621c34f81142701200ceada808d1f9778234c6c`. A chat test fixture needed to support multiple active resize observers; that correction is `1ffe13c91d292b3a9aacce5677428ee555591b55`.

- [CI passed for 1ffe13c](https://github.com/reydisse/showpilot/actions/runs/36500364934).
- [Deployment succeeded](https://github.com/reydisse/showpilot/actions/runs/36500770388).
- Production `/api/health` independently returned `status: ok` and that exact full commit.

This release includes device-timezone call-time display/editing, shared Schedule/Rundown call-time persistence, end-show confirmation, mobile chat layout, notification inbox handling, device cockpit controls and incident navigation. The local missing assignment-owner column was repaired with existing migration 0042. That local repair is separate from production migration evidence.

## Audit follow-up included with this report

| Finding | Change | Evidence |
| --- | --- | --- |
| A09 | Deploy injects the exact CI-approved source SHA, checks production health against it, and retains a `web-release.json` artifact with commit, CI/deploy links and verification time. | The first release above already has matching CI and health evidence. Subsequent successful deployments require this check automatically. Native release manifests are outside this release scope. |
| A95 / A25 | Schedule captures relay revision before checking the form's database version. Rundown metadata/status timestamps advance at least one millisecond, including rapid edits. | Real Worker coverage checks Schedule → relay → D1, Rundown → D1, timezone display, clearing call time, strictly advancing versions and rejection of an older form. |
| A102 | Assignment response versions include the resolved call time: individual override, inherited show call, or configured lead before start. Personal assignments, public crew portal and the deployed schedule API use the same resolution. | Version regression and API regression reject an acceptance after the inherited show call changes, without writing or notifying. |

Local follow-up checks passed: web TypeScript, migration manifest checks, client boundary checks, 1,020 unit tests and 40 Worker tests. The resulting deployment's release artifact records its final SHA; a local pass alone is not production evidence.

## Follow-up release verified

Production now serves `4660b7040fceb164e04286210e8911db82877416`.

- [CI run 36501228350 passed](https://github.com/reydisse/showpilot/actions/runs/36501228350). Its logs confirm 1,020 web unit tests across 149 files, 40 Worker tests across 15 files, seven migration checks and 29 boundary checks. Web TypeScript and the other blocking repository jobs passed.
- [Deploy run 36501645745 passed](https://github.com/reydisse/showpilot/actions/runs/36501645745). It built and deployed the web Worker, verified the exact commit, saved the release manifest, deployed the landing Worker and passed the landing download smoke check.
- Web Worker version: `efeb0617-5a4f-475e-b094-a3c82bb8d7ba`.
- The workflow verified health at `2026-09-29T00:10:40.370Z`, or 20:10 on 28 September in Toronto. An independent uncached request also returned `{"status":"ok","commit":"4660b7040fceb164e04286210e8911db82877416"}`.
- The downloaded workflow artifact is retained verbatim as [web-4660b70.json](releases/web-4660b70.json). It explicitly excludes a native release.

A09 is complete for this web release. The historical requirement for native versions, binary checksums and installed-device checks remains outside the authorized release scope. Health proves Worker liveness and revision identity; it does not prove authenticated workflows or venue behavior.

## Remaining findings reconciled with current code

The source register has 111 `fixed-local` entries and two `partial` entries, A09 and A22. This release closes A09's web requirement. A22 remains deferred. The following checks resolve the stale or partial statements relevant to this follow-up; they do not represent a new acceptance run for all 113 findings.

| Finding | Current evidence | Remaining limit |
| --- | --- | --- |
| A25, A95 | `rundown-meta-update.server.ts` captures the relay revision before checking the form version. `RundownRelay.ts` advances the persisted timestamp on metadata and status writes. CI passed `rundown-meta-update.worker.test.ts`, which writes Schedule metadata, reads relay and D1 state, changes the call through the relay, rejects the older form and clears the call through Schedule. | Broader simultaneous-operator and outage rehearsal remains in V04. |
| A35, A92 | Schedule, Rundown, Show Flow, My assignments and the public crew portal use `useDeviceTimeZone`. The hook starts with UTC for hydration, then reads the device timezone. The Schedule editor passes that timezone into conversion; Rundown edits use the same conversion. The Worker regression displays the same saved call as 09:15 Toronto and 13:15 Accra. | This supersedes A92's older organization-timezone display note. Venue timezone still interprets legacy individual assignment wall times in storage. Physical-device timezone and accessibility acceptance remains open. |
| A102 | `schedule.ts`, `crew-schedule.ts` and `mobile-api.server.ts` include resolved call time in the reviewed assignment version. Resolution is individual override, show call, then configured lead before start. CI passed the inherited-call change rejection test, including no write and no notification. | Public email delivery, native response controls and simultaneous-response acceptance remain in V04. |
| A16, A36, A91, A104, A106, A109, A110 | The production manifest includes migrations through 0046. Read-only production queries independently found the three member-limit triggers, assignment owner column/index, lane-specific report-note unique index, song slide identity, checklist category/revision and equipment revision. The old report-note index is absent. | Schema presence does not prove every migrated data row or runtime workflow. The local 0042 repair is separate evidence. |
| A104 | Both `personal-notifications.ts` and `mobile-api.server.ts` order and paginate by `julianday(createdAt)` plus ID. CI passed the actual D1 mixed-format ordering test. Production contains three valid `+00:00` creation timestamps; the remaining creation timestamps and all non-null read timestamps use the canonical `Z` form. | Do not claim every stored timestamp is normalized. The remaining valid alternate representations are supported by the readers. |

The production checks used only schema reads and timestamp aggregates. D1 reported zero rows written. No migration was reapplied.

## Remaining acceptance work

A22 remains deferred by the web-only release decision. V02–V05 retain the audit's limits: complete authenticated/native chat behavior, actual venue equipment, wider roles/concurrency/account workflows, and physical-device/accessibility acceptance. Component, API and relay checks do not establish physical-device behavior. No venue commands or real notification-delivery trials were sent during this follow-up.

| Gap | Acceptance still needed |
| --- | --- |
| V02 | Full authenticated chat routes, delayed history and room races, offline recovery, keyboard changes, attachment cases and native message links. The historical local two-account and component results remain bounded evidence. |
| V03 | Actual camera, mixer, projector, lighting, MIDI and ProPresenter acknowledgement/state checks; unplug/reconnect, bridge takeover and partial import failures during a controlled venue window. |
| V04 | Wider role and account transitions, concurrent operators, grant expiry, failed/lost responses, billing sandbox, public invitation links and real notification delivery. No new production sign-in, signup, billing or live-show mutation smoke was performed for this release. |
| V05 | Installed iPhone, iPad, Android, macOS and Windows acceptance, assistive technology, largest text, orientation, external displays, sleep/wake and offline startup. |

No native binary, EAS project linkage or APNs/FCM setup was released. The `app.showpilot.tech` migration has not started.

The supplied audit files remain the historical record. This tracked report reconciles their old “not committed/deployed” status with the release evidence above.
