/**
 * Cue sheet data layer.
 *
 * The cue sheet does not own its rows. Rows are the rundown items for a
 * service date; this module only stores what each department has to do
 * against them. That is the whole point of the rebuild — the previous
 * CueSheet model kept its own copy of the running order, so the service
 * had to be typed twice and the two drifted the moment anything moved.
 *
 * Columns and notes are read and written with raw D1 rather than the
 * Prisma client, following the same precedent as `loadRosterDuty` in
 * pm-dashboard.ts: the generated client is produced per-machine and lags
 * a schema change until someone runs `pnpm db:generate`, and a cue sheet
 * that 500s because a teammate has a stale client is not acceptable on a
 * Sunday morning. Every statement is parameterised and orgId-scoped.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import type { Permission } from "@/lib/app-permissions";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { ACTIVE_SERVICE_DATE_KEY, getRundownStateForOrg } from "@/lib/rundown";
import {
  resolveCueSheetDate,
  toCueRows,
  type CueColumnRow,
  type CueRow,
} from "@/lib/cue-sheet-derive";
import { resolveRundownOpeningShow } from "@/lib/rundown-opening";
import type { RundownItem } from "@/types/rundown";
import { markDefaultCueColumnsInitialized, seedDefaultCueColumnsOnce } from "@/lib/cue-column-seed";

export { resolveCueSheetDate, toCueRows };
export type { CueColumnRow, CueRow };

import { CUE_COLUMN_COLORS, cueSheetOperationSchema } from "./cue-sheet-writes";
export { CUE_COLUMN_COLORS } from "./cue-sheet-writes";
export type CueColumnColor = (typeof CUE_COLUMN_COLORS)[number];

/**
 * What a new org gets the first time it opens the cue sheet. Seeded from
 * the departments ShowPilot already understands rather than one church's
 * column names — anything else is renamed or deleted in seconds.
 */

/**
 * Columns added to the defaults after an org already seeded.
 *
 * ensureColumns only fires on an empty sheet, so a new default would
 * never reach an existing org. The backfill runs exactly once per org,
 * tracked by the marker below — checking "does a column named Show
 * Caller exist?" on every load would re-create one the operator
 * deliberately deleted, which is the app arguing with its user.
 */
const BACKFILL_MARKER_KEY = "cue-columns-backfill";
const BACKFILL_VERSION = "1";
const BACKFILL_COLUMNS: { label: string; color: CueColumnColor }[] = [
  { label: "Show Caller", color: "red" },
];

export interface CueSheetModel {
  showId: string | null;
  serviceDate: string;
  serviceName: string;
  scheduledStartTime: string | null;
  rundownStatus: "stopped" | "live" | "complete";
  currentItemId: string | null;
  columns: CueColumnRow[];
  rows: CueRow[];
  /** Every show this org has a rundown for, newest first. */
  shows: Array<{
    id: string;
    serviceDate: string;
    name: string;
    scheduledStartTime: string | null;
  }>;
}

async function loadShows(orgId: string) {
  const prisma = getPrisma();
  return prisma.rundown.findMany({
    where: { orgId },
    orderBy: [
      { serviceDate: "asc" },
      { scheduledStartTime: "asc" },
      { createdAt: "asc" },
    ],
    select: { id: true, serviceDate: true, name: true, scheduledStartTime: true },
  });
}

async function readActiveShow(orgId: string): Promise<{ serviceDate: string | null; showId: string | null }> {
  const prisma = getPrisma();
  const [dateRow, showRow] = await Promise.all([
    prisma.appSetting.findUnique({
      where: { orgId_key: { orgId, key: ACTIVE_SERVICE_DATE_KEY } },
      select: { value: true },
    }),
    prisma.appSetting.findUnique({
      where: { orgId_key: { orgId, key: "active-show-id" } },
      select: { value: true },
    }),
  ]);
  return { serviceDate: dateRow?.value || null, showId: showRow?.value || null };
}

async function assertCuePermission(orgId: string, permissions: Permission[]) {
  const { user } = await assertEffectiveOrgPermission(orgId, permissions);
  return user.name;
}

// ─── Columns ─────────────────────────────────────────────────

async function readColumns(orgId: string): Promise<CueColumnRow[]> {
  const rows =
    (
      await getD1()
        .prepare(
          `SELECT id, label, color, sortOrder, width
             FROM cue_column
            WHERE orgId = ?
            ORDER BY sortOrder ASC, createdAt ASC, id ASC`,
        )
        .bind(orgId)
        .all<CueColumnRow>()
    ).results ?? [];
  return rows;
}

/**
 * An empty cue sheet with no columns is a table with nothing in it and
 * no obvious way forward, so the first read seeds a starting set. Seeding
 * on read rather than at signup means orgs that predate this feature get
 * them too.
 */
async function ensureColumns(orgId: string): Promise<CueColumnRow[]> {
  const existing = await readColumns(orgId);
  const db = getD1();
  const now = new Date().toISOString();

  if (existing.length === 0) {
    await seedDefaultCueColumnsOnce(db, orgId, now);
    // A fresh seed already contains everything in the backfill, so record
    // it as done rather than adding a second Show Caller next load.
    await markBackfillDone(orgId);
    return readColumns(orgId);
  }

  // Existing organizations count as initialized. If they later intentionally
  // delete every column, the empty sheet stays empty instead of silently
  // recreating defaults.
  await markDefaultCueColumnsInitialized(db, orgId);

  const prisma = getPrisma();
  const marker = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: BACKFILL_MARKER_KEY } },
    select: { value: true },
  });
  if (marker?.value === BACKFILL_VERSION) return existing;

  // Ahead of the existing columns: Show Caller leads the sheet.
  const missing = BACKFILL_COLUMNS.filter(
    (column) => !existing.some((e) => e.label.toLowerCase() === column.label.toLowerCase()),
  );
  if (missing.length > 0) {
    const lowest = Math.min(...existing.map((column) => column.sortOrder));
    await db.batch(
      missing.map((column, index) =>
        db
          .prepare(
            `INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            orgId,
            column.label,
            column.color,
            lowest - missing.length + index,
            160,
            now,
            now,
          ),
      ),
    );
  }
  await markBackfillDone(orgId);
  return missing.length > 0 ? readColumns(orgId) : existing;
}


async function markBackfillDone(orgId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key: BACKFILL_MARKER_KEY } },
    update: { value: BACKFILL_VERSION },
    create: { orgId, key: BACKFILL_MARKER_KEY, value: BACKFILL_VERSION },
  });
}

// ─── Read ────────────────────────────────────────────────────

export const getCueSheet = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        /** Omitted on first load — the server picks the right service. */
        serviceDate: serviceDateSchema.optional(),
        showId: idSchema.optional(),
        today: serviceDateSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }): Promise<CueSheetModel> => {
    await assertCuePermission(data.orgId, [
      "cuesheet:view",
      "cuesheet:edit",
      "cuesheet:add_notes",
    ]);

    const [shows, active] = await Promise.all([
      loadShows(data.orgId),
      readActiveShow(data.orgId),
    ]);
    const target = resolveRundownOpeningShow({
      shows,
      today: data.today,
      requestedShowId: data.showId,
      requestedServiceDate: data.serviceDate,
      activeShowId: active.showId ?? undefined,
      activeServiceDate: active.serviceDate ?? undefined,
    });
    const serviceDate = target?.serviceDate ?? data.serviceDate ?? data.today;
    const showId = target?.id;

    const [columns, state, noteRows] = await Promise.all([
      ensureColumns(data.orgId),
      getRundownStateForOrg({ orgId: data.orgId, serviceDate, showId }),
      readNotes(data.orgId, serviceDate, showId),
    ]);

    const rows = toCueRows(state.items ?? [], state.meta, noteRows);

    return {
      showId: showId ?? null,
      serviceDate,
      serviceName: state.meta?.name ?? "",
      scheduledStartTime: state.meta?.scheduledStartTime ?? null,
      rundownStatus: state.meta?.status ?? "stopped",
      currentItemId: state.timer?.currentItemId ?? null,
      columns,
      rows,
      shows: [...shows].reverse().map((show) => ({
        id: show.id,
        serviceDate: show.serviceDate,
        name: show.name,
        scheduledStartTime: show.scheduledStartTime?.toISOString() ?? null,
      })),
    };
  });

async function readNotes(
  orgId: string,
  serviceDate: string,
  showId?: string,
): Promise<{ itemId: string; columnId: string; text: string }[]> {
  return (
    (
      await getD1()
        .prepare(
          `SELECT itemId, columnId, text
             FROM cue_note
            WHERE orgId = ? AND ${showId ? "showId = ?" : "serviceDate = ?"} AND text <> ''`,
        )
        .bind(orgId, showId ?? serviceDate)
        .all<{ itemId: string; columnId: string; text: string }>()
    ).results ?? []
  );
}

// All cue-sheet writes use captured requests with atomic receipts. Current
// permissions are checked on every attempt, including an idempotent retry.
export const mutateCueSheet = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, requestId: z.string().uuid(), operation: cueSheetOperationSchema }), data))
  .handler(async ({ data }) => {
    const userName = await assertCuePermission(data.orgId, data.operation.kind === "note"
      ? ["cuesheet:edit", "cuesheet:add_notes"] : ["cuesheet:edit"]);
    const { applyCueSheetWrite } = await import("./cue-sheet-writes.server");
    return applyCueSheetWrite(getD1(), data, userName);
  });

/** Exported for tests: the shape the page renders from. */
export type { RundownItem };
