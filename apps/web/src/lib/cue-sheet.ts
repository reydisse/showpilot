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
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { hasAnyPermission, type Permission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";
import { getRundownStateForOrg } from "@/lib/rundown";
import { computeCascadedTimes } from "@/lib/rundown-timing";
import { isHeaderItem, type RundownItem } from "@/types/rundown";

/** Column header tints. A fixed palette so contrast is guaranteed. */
export const CUE_COLUMN_COLORS = [
  "slate",
  "amber",
  "green",
  "blue",
  "purple",
  "pink",
  "cyan",
  "red",
] as const;
export type CueColumnColor = (typeof CUE_COLUMN_COLORS)[number];

/** Widths a resizer may persist. Narrow enough to fit, wide enough to read. */
const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 640;

/** A cue note cell is a line or two of instruction, not an essay. */
const MAX_NOTE_LENGTH = 2000;

/**
 * What a new org gets the first time it opens the cue sheet. Seeded from
 * the departments ShowPilot already understands rather than one church's
 * column names — anything else is renamed or deleted in seconds.
 */
const DEFAULT_COLUMNS: { label: string; color: CueColumnColor }[] = [
  { label: "Production", color: "amber" },
  { label: "Pro Ops", color: "green" },
  { label: "LX", color: "blue" },
  { label: "Sound", color: "purple" },
];

export interface CueColumnRow {
  id: string;
  label: string;
  color: string;
  sortOrder: number;
  width: number;
}

/** One row of the sheet — a rundown item, with its notes attached. */
export interface CueRow {
  itemId: string;
  title: string;
  type: string;
  /** True for a section band: no times, no cue, spans the table. */
  isSection: boolean;
  cue: string;
  durationMs: number;
  scheduledStart: string | null;
  expectedEnd: string | null;
  status: string;
  /** columnId → text. Only cells with content are present. */
  notes: Record<string, string>;
}

export interface CueSheetModel {
  serviceDate: string;
  serviceName: string;
  scheduledStartTime: string | null;
  rundownStatus: "stopped" | "live" | "complete";
  currentItemId: string | null;
  columns: CueColumnRow[];
  rows: CueRow[];
}

async function getOrgMemberRole(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  if (!member) throw new Error("Forbidden");

  return { role: member.role ?? "member", userName: session.user.name ?? "" };
}

async function assertCuePermission(orgId: string, permissions: Permission[]) {
  const { role, userName } = await getOrgMemberRole(orgId);
  if (!hasAnyPermission(role, permissions)) throw new Error("Forbidden");
  return userName;
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
            ORDER BY sortOrder ASC, createdAt ASC`,
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
  if (existing.length > 0) return existing;

  const db = getD1();
  const now = new Date().toISOString();
  await db.batch(
    DEFAULT_COLUMNS.map((column, index) =>
      db
        .prepare(
          `INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), orgId, column.label, column.color, index, 160, now, now),
    ),
  );
  return readColumns(orgId);
}

// ─── Read ────────────────────────────────────────────────────

export const getCueSheet = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema }), data),
  )
  .handler(async ({ data }): Promise<CueSheetModel> => {
    await assertCuePermission(data.orgId, [
      "cuesheet:view",
      "cuesheet:edit",
      "cuesheet:add_notes",
    ]);

    const [columns, state, noteRows] = await Promise.all([
      ensureColumns(data.orgId),
      getRundownStateForOrg({ orgId: data.orgId, serviceDate: data.serviceDate }),
      readNotes(data.orgId, data.serviceDate),
    ]);

    const items = state.items ?? [];
    // Times come from the same cascade the rundown and the dashboard use,
    // so a start time changed in the rundown is right here too.
    const timed = computeCascadedTimes(items, state.meta);

    const notesByItem = new Map<string, Record<string, string>>();
    for (const note of noteRows) {
      const bucket = notesByItem.get(note.itemId) ?? {};
      bucket[note.columnId] = note.text;
      notesByItem.set(note.itemId, bucket);
    }

    const rows: CueRow[] = timed.map((item) => ({
      itemId: item.id,
      title: item.title,
      type: item.type,
      isSection: isHeaderItem(item),
      cue: item.cue ?? "",
      durationMs: isHeaderItem(item) ? 0 : item.duration,
      scheduledStart: isHeaderItem(item) ? null : item.scheduledStart,
      expectedEnd: isHeaderItem(item) ? null : item.expectedEnd,
      status: item.status,
      notes: notesByItem.get(item.id) ?? {},
    }));

    return {
      serviceDate: data.serviceDate,
      serviceName: state.meta?.name ?? "",
      scheduledStartTime: state.meta?.scheduledStartTime ?? null,
      rundownStatus: state.meta?.status ?? "stopped",
      currentItemId: state.timer?.currentItemId ?? null,
      columns,
      rows,
    };
  });

async function readNotes(
  orgId: string,
  serviceDate: string,
): Promise<{ itemId: string; columnId: string; text: string }[]> {
  return (
    (
      await getD1()
        .prepare(
          `SELECT itemId, columnId, text
             FROM cue_note
            WHERE orgId = ? AND serviceDate = ? AND text <> ''`,
        )
        .bind(orgId, serviceDate)
        .all<{ itemId: string; columnId: string; text: string }>()
    ).results ?? []
  );
}

// ─── Write: cells ────────────────────────────────────────────

export const setCueNote = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        serviceDate: serviceDateSchema,
        itemId: z.string().min(1).max(200),
        columnId: idSchema,
        text: z.string().max(MAX_NOTE_LENGTH),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    // add_notes is deliberately enough: a camera operator writing in the
    // Camera column should not need rights to restructure the sheet.
    const userName = await assertCuePermission(data.orgId, [
      "cuesheet:edit",
      "cuesheet:add_notes",
    ]);

    // The column must belong to this org. Without this a valid columnId
    // from another tenant would key a row into their sheet.
    const owns = await getD1()
      .prepare(`SELECT id FROM cue_column WHERE id = ? AND orgId = ?`)
      .bind(data.columnId, data.orgId)
      .first<{ id: string }>();
    if (!owns) throw new Error("Unknown column");

    const now = new Date().toISOString();
    // ON CONFLICT against the unique cell index: two operators typing in
    // the same cell converge on one row rather than racing to insert two.
    await getD1()
      .prepare(
        `INSERT INTO cue_note (id, orgId, serviceDate, itemId, columnId, text, updatedAt, updatedBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (orgId, serviceDate, itemId, columnId)
         DO UPDATE SET text = excluded.text, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
      )
      .bind(
        crypto.randomUUID(),
        data.orgId,
        data.serviceDate,
        data.itemId,
        data.columnId,
        data.text,
        now,
        userName,
      )
      .run();

    return { ok: true as const };
  });

// ─── Write: columns ──────────────────────────────────────────

export const addCueColumn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        label: z.string().min(1).max(60),
        color: z.enum(CUE_COLUMN_COLORS).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertCuePermission(data.orgId, ["cuesheet:edit"]);
    const db = getD1();
    const next = await db
      .prepare(`SELECT COALESCE(MAX(sortOrder), -1) + 1 AS next FROM cue_column WHERE orgId = ?`)
      .bind(data.orgId)
      .first<{ next: number }>();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO cue_column (id, orgId, label, color, sortOrder, width, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, data.orgId, data.label.trim(), data.color ?? "slate", next?.next ?? 0, 160, now, now)
      .run();
    return { id };
  });

export const updateCueColumn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        label: z.string().min(1).max(60).optional(),
        color: z.enum(CUE_COLUMN_COLORS).optional(),
        width: z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertCuePermission(data.orgId, ["cuesheet:edit"]);

    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (data.label !== undefined) {
      sets.push("label = ?");
      values.push(data.label.trim());
    }
    if (data.color !== undefined) {
      sets.push("color = ?");
      values.push(data.color);
    }
    if (data.width !== undefined) {
      sets.push("width = ?");
      values.push(data.width);
    }
    if (sets.length === 0) return { ok: true as const };
    sets.push("updatedAt = ?");
    values.push(new Date().toISOString());

    // orgId in the WHERE, not just the permission check: the check proves
    // the caller may edit their own columns, not that this one is theirs.
    await getD1()
      .prepare(`UPDATE cue_column SET ${sets.join(", ")} WHERE id = ? AND orgId = ?`)
      .bind(...values, data.id, data.orgId)
      .run();

    return { ok: true as const };
  });

export const reorderCueColumns = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, ids: z.array(idSchema).min(1).max(40) }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertCuePermission(data.orgId, ["cuesheet:edit"]);
    const db = getD1();
    const now = new Date().toISOString();
    await db.batch(
      data.ids.map((id, index) =>
        db
          .prepare(`UPDATE cue_column SET sortOrder = ?, updatedAt = ? WHERE id = ? AND orgId = ?`)
          .bind(index, now, id, data.orgId),
      ),
    );
    return { ok: true as const };
  });

export const deleteCueColumn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertCuePermission(data.orgId, ["cuesheet:edit"]);
    const db = getD1();
    // The notes are deleted explicitly rather than left to ON DELETE
    // CASCADE. The foreign key only fires when the connection has
    // `PRAGMA foreign_keys = ON`, which is an environment setting, not a
    // property of the schema — verified: with it off the notes survive
    // their column and become unreachable rows that still count against
    // storage. Deleting both is deterministic everywhere.
    //
    // This is destructive across every service date, which is why the UI
    // requires typing the column name before calling it.
    await db.batch([
      db.prepare(`DELETE FROM cue_note WHERE orgId = ? AND columnId = ?`).bind(data.orgId, data.id),
      db.prepare(`DELETE FROM cue_column WHERE id = ? AND orgId = ?`).bind(data.id, data.orgId),
    ]);
    return { ok: true as const };
  });

/** Exported for tests: the shape the page renders from. */
export type { RundownItem };
