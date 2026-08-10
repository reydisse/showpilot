# SHOWPILOT-MULTISERVICE-SPEC.md
## Breaking the one-service-per-date constraint

*Authored during the PM dashboard work. Not yet executed — this is the
plan, deliberately written before any migration, because the change
touches every operator-facing table in a live product.*

---

## THE PROBLEM

ShowPilot cannot represent two services on the same day.

`Rundown` is `@@unique([orgId, serviceDate])`. Rundown items live in an
`AppSetting` keyed `rundown-items:<YYYY-MM-DD>`, with the timer at
`rundown-timer:<YYYY-MM-DD>`. Six further tables partition on a bare
`serviceDate` string:

| Table | Key |
| --- | --- |
| `rundown` | `@@unique([orgId, serviceDate])` |
| `rundown_item` | `@@unique([orgId, serviceDate, itemId])` |
| `checklist_entry` | `@@index([orgId, serviceDate])` |
| `cue_sheet` | `@@index([orgId, serviceDate])` |
| `incident` | `@@index([orgId, serviceDate])` |
| `mic_assignment` | `@@index([orgId, serviceDate])` |
| `service_assignment` | `@@index([orgId, serviceDate])` |

A date is being used as an identity. It is not one.

**Who this blocks.** Churches running 9am and 11am — reported as common
among the beta churches. A Sunday morning service plus an evening carol
service. Any special event sharing a day with a regular service. The
current workaround is to overwrite, which destroys the first service's
rundown, cues, mics and incident history.

**Why it also blocks the roadmap.** Planning Center Services — the
intended scheduling integration — models *plans*, not dates. A PCO plan
has an id, a title and a datetime, and multiple plans per day are
routine. Any adapter has to invent a mapping until services have
identity, so this change is a prerequisite rather than a nice-to-have.

---

## THE SHAPE

Introduce a `Service` entity. Every table above gains `serviceId` and
eventually stops reading `serviceDate`.

```prisma
model Service {
  id                 String       @id @default(cuid())
  orgId              String
  organization       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  serviceDate        String       // retained: cheap date-range queries
  name               String       @default("")
  scheduledStartTime DateTime?
  status             String       @default("stopped")
  /// Ordinal within the day. 0 for the only/first service.
  sequence           Int          @default(0)
  /// Upstream id when synced from Planning Center or similar.
  externalId         String?
  externalSource     String?
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  @@unique([orgId, serviceDate, sequence])
  @@unique([orgId, externalSource, externalId])
  @@index([orgId, serviceDate])
}
```

`Service` is `Rundown` plus identity. `Rundown` is absorbed rather than
kept alongside it — two tables describing one thing is how this problem
started.

`sequence` rather than a time-only key: two services can share a start
time (rehearsal and service), and a service can have no start time at
all while being planned.

`externalId` is included from the beginning. Adding it later means a
second migration over the same rows.

---

## THE HARD PART

Not the schema. Three other things.

**1. The AppSetting keys.** Rundown items are JSON blobs under
`rundown-items:<date>`. `listRundownDates` derives the list of services
by scanning `key LIKE 'rundown-items:%'` and slicing the prefix — the
key format *is* the index. New format is `rundown-items:<serviceId>`,
and the migration must rewrite every key while keeping the old ones
readable until the deploy has rolled out.

**2. The relational store already dual-writes.** `persistRundownItemsForOrg`
writes both the AppSetting JSON and `rundown_item` rows, and
`getRundownStateFromStorage` prefers the rows and falls back to the JSON,
migrating legacy items on read. That fallback path has to be preserved
through the cutover, so during the transition there are three shapes to
handle, not two.

**3. Durable Objects hold live state.** `RundownRelay` and
`TimecodeRelay` are one instance per org and broadcast rundown state.
If a service is live during a deploy, room state must not be
invalidated. Cut over between services, never during one.

---

## PHASES

Each phase is independently deployable and independently revertible.
No phase leaves the product broken if the next one is delayed.

### Phase 1 — Additive schema *(done: 0013 added `Rundown.name`)*

`Rundown.name` already shipped so special events can be labelled before
any of this lands. It becomes `Service.name` in phase 2 with no data
transformation.

### Phase 2 — Create `Service`, backfill, dual-read

- Migration: create `service`; add nullable `serviceId` to all seven
  tables; backfill one `Service` row per existing `(orgId, serviceDate)`
  with `sequence = 0`, copying `name`, `scheduledStartTime`, `status`
  from `rundown`; populate `serviceId` on every child row.
- Code: a `resolveService(orgId, { serviceId? , serviceDate? })` helper.
  Reads prefer `serviceId` and fall back to date. Writes set both.
- `Rundown` stays, still written, still authoritative. Nothing user-facing
  changes.
- **Revertible**: drop the columns; nothing depended on them.

### Phase 3 — Writes move to `serviceId`

- All server functions take `serviceId`. `serviceDate` params accepted
  and resolved for one release so in-flight clients keep working.
- AppSetting keys migrate to `rundown-items:<serviceId>`; the reader
  tries the new key, then the legacy date key, and rewrites on read.
- `listRundownDates` becomes `listServices`, reading `service` rather
  than scanning setting keys.
- Still one service per date — the unique index is not relaxed yet, so
  behaviour is unchanged and the risk is purely mechanical.

### Phase 4 — Allow more than one

- Relax to `@@unique([orgId, serviceDate, sequence])`.
- UI: the rundown date stepper becomes a service picker (date plus
  service within the day). The PM dashboard's date `<select>` becomes a
  service select — it already resolves through one function,
  `resolveServiceDate`, which becomes `resolveService`.
- "Add a service to this day" in the plan-next widget, next to
  "Copy last service".
- Durable Object rooms key on `serviceId`, so two services on one day
  cannot share timer state. **This is the change that must not land
  mid-service.**

### Phase 5 — Remove the crutch

- Drop `serviceDate` reads. Keep the column on `service` for date-range
  queries; drop it from the six child tables.
- Delete the legacy AppSetting key fallback once no org has one left —
  verify with a count query before removing, not on a timer.

---

## WHAT COULD GO WRONG

**A live service during cutover.** Phase 4 changes DO room keys. Deploy
Monday to Thursday. The `/api/health` commit SHA tells you what is
actually running.

**Orphaned child rows.** If backfill misses a `(orgId, serviceDate)`
combination — a `cue_sheet` for a date with no `rundown` row, which is
possible today — those rows get a null `serviceId` and silently vanish
from the UI. The backfill must create a `Service` for every distinct
`serviceDate` found across *all seven tables*, not just `rundown`.
Verify with a null-`serviceId` count per table before phase 3.

**Duplicate services from a bad retry.** `@@unique([orgId, serviceDate,
sequence])` makes a repeated backfill safe. Use it rather than trusting
the script to run once.

**Timezones.** `serviceDate` is a bare string produced by
`getTodayDateString(orgTimezone)`. Do not convert it to a timestamp
during migration — an org in Auckland would shift a day. Copy strings
verbatim.

---

## ACCEPTANCE

- [ ] Two services on one date, each with its own rundown, cues, mics,
      checklist entries and incidents, neither affecting the other
- [ ] A live timer on the 9am is unaffected by edits to the 11am
- [ ] Every pre-existing service retains its full history, verified by
      row counts per table before and after
- [ ] Zero null `serviceId` rows across all seven tables at the end of
      phase 3
- [ ] `service.externalId` populated by a PCO sync without further
      schema change
- [ ] `pnpm --filter @showpilot/web test` green, including new tests for
      `resolveService` precedence and the legacy-key fallback

---

## ESTIMATE

Phase 2 is half a day. Phase 3 is the bulk — one to two days, mostly
mechanical but touching live paths. Phase 4 is a day including UI.
Phase 5 is an hour, weeks later, once telemetry says the fallback is
unused.

Do not compress phases 2 and 3 into one deploy. The backfill wants to
sit in production, verified by queries, before anything reads from it.
