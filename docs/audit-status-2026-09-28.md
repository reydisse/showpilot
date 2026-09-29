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

## Remaining acceptance work

A22 remains deferred by the web-only release decision. V02–V05 retain the audit's limits: complete authenticated/native chat behavior, actual venue equipment, wider roles/concurrency/account workflows, and physical-device/accessibility acceptance. Component, API and relay checks do not establish physical-device behavior. No venue commands or real notification-delivery trials were sent during this follow-up.

The supplied audit files remain the historical record. This tracked report reconciles their old “not committed/deployed” status with the release evidence above.
