# Attendance timestamp repair — Workstream 1

GATE PENDING: Rey's Phase 2/final real-hardware session (APC + MTC, LTC audio,
cloud-down local mode, 35/45-minute advances, real external-device firing).
These gates have not run as part of this change.

## Root cause and behavior

Web Crew attendance and public kiosk attendance bound epoch milliseconds into
`crew_member.lastCheckIn` / `lastCheckOut`. Mobile wrote SQLite UTC text. The
mobile serializer forwarded the mixed storage types, while the native schema
required nullable strings. A single web-toggled row rejected the entire roster
in Check-in, Show Board and Show Workspace, and the screens exposed schema errors.

All three attendance writers now store ISO 8601 UTC strings. The shared mobile
serializer converts legacy numbers, numeric strings and SQLite UTC text to ISO
before the mobile schema runs; null stays null and invalid legacy values become
null rather than making the whole roster unreadable. Raw database values still
participate in revision hashes and conditional-write guards, preserving stale
selection detection. No success/confirmation narration was added.

Check-in and Show Board expose a short failure message and Tap to retry. A failed
attendance write keeps its original intended status for Retry, even if a poll
subsequently changes the displayed status. Show Workspace also uses fixed failure
copy. Check-in row actions and retry targets are at least 44px tall.

## Timestamp audit

`crew_member` has three timestamp columns: `lastCheckIn`, `lastCheckOut`, and
`createdAt` (plus integer `profileRevision`, which is not a timestamp).

- Attendance: `applyCrewAttendance`, `applyPublicAttendanceIntent`, and mobile
  `setCheckInStatus` are the write paths. All now write ISO UTC text.
- Creation: native and web roster mutations both call `writeCrewProfile`, which
  already writes `new Date().toISOString()` for `createdAt`. Onboarding/default
  creation uses the SQL UTC default. Neither attendance toggle rewrites it.
- Reads: Check-in, Show Board, Show Workspace, mobile Team Crew and status mutation
  responses share `serializeCheckInMember`, now normalized. The web roster parser
  uses `z.coerce.date()` for all three dates, and PM dashboard reads use Prisma
  Date values and explicit `.toISOString()`. Attendance/kiosk projections expose
  revisions rather than dates. No additional raw timestamp serializer was found.

## Migration protocol (not applied)

The existing deploy manifest rejects an unapplied numbered migration **before**
deploy. The finish prompt requires the migration's PR merged by Chief **and a
green deploy before remote application**. To preserve both requirements, the
repair is staged at:

`apps/web/prisma/pending-migrations/0096_attendance_iso_timestamps.sql`

It is not in the active migration history or `applied-remote.txt`. CI/tests do not
run it against production. Production reads tolerate old rows before repair.

1. Chief merges this PR. Confirm CI and Deploy succeeded for the exact merged
   main commit, and `/api/health` serves it. Never merge it yourself.
2. Fetch main, check out the merged commit, and verify 0096 remains the next unused
   number. If the applied record or numbering disagrees with observed state, stop
   this workstream and report; do not renumber or force application silently.
3. From `apps/web`, run this read-only preflight using the established Wrangler
   path. Capture its result (counts only; no member data):

   ```sh
   pnpm exec wrangler d1 execute showpilot-db --remote --command="SELECT COUNT(*) AS rows_to_repair, SUM(CASE WHEN (typeof(lastCheckIn) IN ('integer','real') AND strftime('%Y-%m-%dT%H:%M:%fZ',lastCheckIn/1000.0,'unixepoch') IS NULL) OR (typeof(lastCheckOut) IN ('integer','real') AND strftime('%Y-%m-%dT%H:%M:%fZ',lastCheckOut/1000.0,'unixepoch') IS NULL) THEN 1 ELSE 0 END) AS invalid_epochs FROM crew_member WHERE typeof(lastCheckIn) IN ('integer','real') OR typeof(lastCheckOut) IN ('integer','real')"
   ```

   If `invalid_epochs` is nonzero, stop without applying; report the invalid count.
   A null sum with zero rows is expected. This is production repair diagnosis,
   not a live test in a non-Demo org.
4. Apply only after the merge/deploy checks above:

   ```sh
   pnpm exec wrangler d1 execute showpilot-db --remote --file=prisma/pending-migrations/0096_attendance_iso_timestamps.sql
   ```

5. Repeat the count query. Require `rows_to_repair = 0`. Record the timestamp,
   merged SHA, deploy run, command result and postcondition. Any failure stops the
   workstream: never force, skip, or falsely add an applied entry.
6. Create a separate record chore PR moving the **unchanged SQL** into
   `prisma/migrations/0096_attendance_iso_timestamps.sql`, appending that filename
   to `applied-remote.txt` only after the postcondition passes. Update the test's
   raw SQL import to its new path, update this report and ledger evidence with
   the application time, rebase on main, run checks and leave merging to Chief.
   Keep the 175,000-byte gzip budget.

The repair only changes numeric attendance dates. Existing text, nulls, identities,
attendance booleans and receipt records are preserved. Revision hashes for repaired
rows intentionally change; stale captured edits must refresh rather than replay.
The repair is idempotent. A code rollback must not undo the repaired timestamps.

## Named acceptance tests

- `crew-attendance.worker.test.ts`: “web attendance then mobile check-in parses
  the production mobile schema, including an opposite mobile write”; “mobile
  attendance then web attendance parses the production mobile schema in the reverse
  order”; legacy numeric reads across Check-in, Show Board, Show Workspace and a
  kiosk write; staged migration preservation and idempotence against real D1.
- `mobile-checkin.test.ts`: mixed legacy roster rows parse the actual shared
  native Check-in and Show Board schemas without one numeric row poisoning all.
- `mobile-operations-api.test.ts`: Show Workspace normalizes the shared crew schema.
- `native-checkin-errors.test.js`: actual native Check-in/Show Board screen logic
  hides raw failures, reloads on Tap to retry, and retries an attendance intent
  unchanged after a refreshed snapshot. Native host APIs are stubbed.
- `attendance-timestamp.test.ts`: epoch, numeric-string, UTC SQL text, offset ISO,
  Date, zero, null and invalid-value normalization.

Production application and Demo live verification remain pending until the merged
code is deployed. Native screen changes require a subsequent mobile build; the
server compatibility fix protects installed build 11's string schema immediately
once deployed. This work does not close the broad 2.8 / 2.11 umbrella requirements.

## Verification recorded 2026-11-15 (before review)

- **FAILED — full web suite:** 3,565 unit tests passed (397 files). Worker result:
  1,882 passed, 1 failed (164 files). The failing test was
  `destination-control.worker.test.ts` → “legacy native saves acknowledge their
  receipt with destination revision triggers enabled”, which exceeded the existing
  5,000ms deadline. This run does not establish whether it also fails on main.
  No deadline was raised and no unrelated destination code was changed. The phase
  is stopped under the finish prompt's failed-gate rule. This PR is a draft,
  not ready for review/merge, pending resolution and an actually green full gate.
- Targeted attendance/public-kiosk Worker tests: 27 passed, including all new
  cross-client and staged-migration cases.
- Targeted mobile Check-in/timestamp unit tests: 20 passed. Native error-screen
  and mobile-operations tests: 19 passed; final native screen rerun: 3 passed.
- Web, shared and mobile typechecks passed. Mobile verification passed all 18
  Expo checks, iOS/Android/web export and polling-boundary checks (15 lint warnings,
  zero errors; existing parity inventory still reports one missing surface).
- Production web build passed: 171,349 / 175,000 gzip bytes. Budget unchanged.
- Ledger remains at 67/79 verified for Phase 2. New evidence is partial for the
  broad 2.8 and 2.11 requirements; the failed full-suite gate is explicitly recorded.
- No production migration applied, no production test, no Demo live test, no native
  release and no hardware rehearsal performed. Chief has not merged this change.
- Workstreams 2–8 remain unstarted in this run because the full-suite gate failed.
