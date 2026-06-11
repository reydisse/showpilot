Rundown Persistence Migration Notes

Date: 2026-05-14

Goal
- Move `rundown-items:<serviceDate>` persistence from JSON in `AppSetting` into relational rows.
- Keep legacy `rundown-*` behavior intact for timer, message, and non-item usage.
- Maintain an additive fallback model (new rows + legacy rows) until migration is fully warm.

Scope and constraints
- Migration-only change; do not alter rundown runtime UI behavior.
- Preserve `rundown-timer:<serviceDate>` behavior and `pp-slide`/`rundown-message` behavior.
- Do not delete legacy `app_setting` rows.
- Use Prisma D1 adapter in `apps/web/src/lib/db.ts` as currently implemented.

Current central write path
- `apps/web/src/lib/rundown.ts` is currently authoritative for rundown items/timer writes.
- `getRundownState`, `saveRundownItems`, and `saveRundownTimer` are currently pure `AppSetting` reads/writes for items/timer.

Direct AppSetting callers currently outside `lib/rundown`
- `apps/web/src/routes/timer/$orgSlug.tsx`
  - Reads:
    - `rundown-items:<serviceDate>`
    - `rundown-timer:<serviceDate>`
    - `rundown-message:<serviceDate>`
    - `rundown-ppslide:<serviceDate>`
    - `propresenter-stage-display`
- `apps/web/src/lib/report.ts`
  - Reads:
    - `rundown-items:<serviceDate>`
    - `rundown-timer:<serviceDate>`
    - `rundown-message:<serviceDate>`

Legacy JSON shape inventory for `rundown-items:<serviceDate>`
- Example from seed for 2026-03-12 (`apps/web/scripts/seed-test-tenant.sql`, key `rundown-items:2026-03-12`):
  - fields observed: `id`, `title`, `type`, `duration`, `notes`, `assignee`
  - missing in some rows:
    - `cue`
    - `status`
    - `sortOrder`
    - `hardStop`
    - `lowerThirdId`
- Other seeded rows (e.g. 2026-03-13+ in same seed file) often include
  - `cue`, `status`, `sortOrder`, `hardStop`, `lowerThirdId` generally omitted.

Legacy rundown timer shape
- `rundown-timer:<serviceDate>` currently stores `NativeTimerState` JSON:
  - `playback`, `currentItemId`, `elapsed`, `startedAt`, `pausedAt`, `mode`, `serverTime`.
- Timer `mode` may be `count-down` (primary), `count-up`, or `clock`.
- `rundown-timer:2026-03-12` sample contains `currentItemId: "rd-01"`; many other seeded timers are `currentItemId: null`.

Compatibility considerations
- `apps/web/src/durable-objects/RundownRelay.ts` timer payload schema is still `count-up | count-down` and does not include `clock`.
- `apps/web/src/hooks/useRundownSync.ts` also normalizes timer mode to `count-up | count-down`.
- `apps/web/src/types/rundown.ts` still defines `NativeTimerState.mode` as `count-up | count-down | clock`.
- Therefore migration must normalize legacy item fields only; timer mode behavior must remain untouched.

Schema target
- Add relational model in Prisma for per-org/per-date rundown items.
- Keep legacy `rundown-*` keys in `app_setting` for fallback compatibility.
- New model should include:
  - `orgId`, `serviceDate`, canonical item `itemId`, `title`, `type`, `duration`, `notes`, `assignee`, `cue`, `status`, `sortOrder`, `hardStop`, optional `lowerThirdId`, timestamps.

Validation requirements
- After schema/migration edits, run:
  - `pnpm --filter @showpilot/web prisma migrate dev --name rundown_items_relational`
  - `pnpm --filter @showpilot/web build`
