import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";

const colorSchema = z.string().max(30); // hex or css color token
const weekStartSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// ─────────────────────────────────────────────────────────────
// Admin CRUD for the kiosk Org Chart (teams) and On-Duty roster.
// Writes to the raw D1 tables added in migration 0005 (not in the
// Prisma client), gated by the same "settings:members" permission used
// for managing org people.
// ─────────────────────────────────────────────────────────────

const db = () => getD1();
const uid = () => crypto.randomUUID();

async function getOrgMemberRole(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role) throw new Error("Forbidden");
  return role;
}

async function assertKioskAdmin(orgId: string) {
  const role = await getOrgMemberRole(orgId);
  if (!hasPermission(role, "settings:members")) throw new Error("Forbidden");
}

// ─── Org members (for people pickers) ────────────────────────

export const getKioskOrgMembers = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    const rows =
      (
        await db()
          .prepare(
            `SELECT u.id AS id, u.name AS name, u.image AS image
             FROM member m JOIN user u ON u.id = m.userId
             WHERE m.organizationId = ? ORDER BY u.name`,
          )
          .bind(data.orgId)
          .all<{ id: string; name: string; image: string | null }>()
      ).results ?? [];
    return rows;
  });

// ─── Teams (org chart) ───────────────────────────────────────

export interface AdminTeam {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  members: { userId: string; name: string; image: string | null; role: string }[];
}

export const getKioskTeams = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<AdminTeam[]> => {
    await assertKioskAdmin(data.orgId);
    const teams =
      (
        await db()
          .prepare("SELECT id, name, color, sortOrder FROM team WHERE orgId = ? ORDER BY sortOrder, name")
          .bind(data.orgId)
          .all<{ id: string; name: string; color: string; sortOrder: number }>()
      ).results ?? [];
    const members =
      (
        await db()
          .prepare(
            `SELECT tm.teamId AS teamId, tm.userId AS userId, tm.role AS role, u.name AS name, u.image AS image
             FROM team_member tm
             JOIN team t ON t.id = tm.teamId
             JOIN user u ON u.id = tm.userId
             WHERE t.orgId = ?
             ORDER BY CASE tm.role WHEN 'lead' THEN 0 ELSE 1 END, tm.sortOrder, u.name`,
          )
          .bind(data.orgId)
          .all<{ teamId: string; userId: string; role: string; name: string; image: string | null }>()
      ).results ?? [];
    return teams.map((t) => ({
      ...t,
      members: members
        .filter((m) => m.teamId === t.id)
        .map((m) => ({ userId: m.userId, name: m.name, image: m.image, role: m.role })),
    }));
  });

export const createTeam = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, name: labelSchema, color: colorSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    const next = await db()
      .prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS n FROM team WHERE orgId = ?")
      .bind(data.orgId)
      .first<{ n: number }>();
    const id = uid();
    await db()
      .prepare("INSERT INTO team (id, orgId, name, color, sortOrder) VALUES (?, ?, ?, ?, ?)")
      .bind(id, data.orgId, data.name.trim() || "Team", data.color || "#3b82f6", next?.n ?? 1)
      .run();
    return { id };
  });

export const updateTeam = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, id: idSchema, name: z.string().max(200), color: colorSchema }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    await db()
      .prepare("UPDATE team SET name = ?, color = ? WHERE id = ? AND orgId = ?")
      .bind(data.name.trim() || "Team", data.color || "#3b82f6", data.id, data.orgId)
      .run();
  });

export const deleteTeam = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    // Explicit child delete — D1 doesn't enforce FK cascades by default.
    await db().prepare("DELETE FROM team_member WHERE teamId = ?").bind(data.id).run();
    await db().prepare("DELETE FROM team WHERE id = ? AND orgId = ?").bind(data.id, data.orgId).run();
  });

export const setTeamMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        teamId: idSchema,
        userId: idSchema,
        role: z.enum(["lead", "member"]),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    const owns = await db()
      .prepare("SELECT 1 AS ok FROM team WHERE id = ? AND orgId = ? LIMIT 1")
      .bind(data.teamId, data.orgId)
      .first<{ ok: number }>();
    if (!owns) throw new Error("Not found");
    // Only one lead per team.
    if (data.role === "lead") {
      await db()
        .prepare("UPDATE team_member SET role = 'member' WHERE teamId = ? AND role = 'lead'")
        .bind(data.teamId)
        .run();
    }
    const next = await db()
      .prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS n FROM team_member WHERE teamId = ?")
      .bind(data.teamId)
      .first<{ n: number }>();
    await db()
      .prepare(
        "INSERT OR REPLACE INTO team_member (teamId, userId, role, sortOrder) VALUES (?, ?, ?, ?)",
      )
      .bind(data.teamId, data.userId, data.role, next?.n ?? 1)
      .run();
  });

export const removeTeamMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, teamId: idSchema, userId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    const owns = await db()
      .prepare("SELECT 1 AS ok FROM team WHERE id = ? AND orgId = ? LIMIT 1")
      .bind(data.teamId, data.orgId)
      .first<{ ok: number }>();
    if (!owns) return;
    await db()
      .prepare("DELETE FROM team_member WHERE teamId = ? AND userId = ?")
      .bind(data.teamId, data.userId)
      .run();
  });

// ─── Roster roles ────────────────────────────────────────────

export interface RosterRole {
  id: string;
  code: string;
  name: string;
  short: string;
  sortOrder: number;
}

const DEFAULT_ROSTER_ROLES: { code: string; name: string; short: string }[] = [
  { code: "tm", name: "Technical Manager", short: "TM" },
  { code: "audio", name: "Audio / FOH", short: "Audio" },
  { code: "cam1", name: "Camera 1", short: "Cam 1" },
  { code: "cam2", name: "Camera 2", short: "Cam 2" },
  { code: "pro", name: "ProPresenter", short: "Pro" },
  { code: "stream", name: "Stream", short: "Stream" },
];

export const getRosterRoles = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<RosterRole[]> => {
    await assertKioskAdmin(data.orgId);
    return (
      (
        await db()
          .prepare("SELECT id, code, name, short, sortOrder FROM roster_role WHERE orgId = ? ORDER BY sortOrder, code")
          .bind(data.orgId)
          .all<RosterRole>()
      ).results ?? []
    );
  });

export const seedRosterRoles = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    const existing = await db()
      .prepare("SELECT COUNT(*) AS c FROM roster_role WHERE orgId = ?")
      .bind(data.orgId)
      .first<{ c: number }>();
    if ((existing?.c ?? 0) > 0) return;
    let i = 1;
    for (const r of DEFAULT_ROSTER_ROLES) {
      await db()
        .prepare("INSERT INTO roster_role (id, orgId, code, name, short, sortOrder) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(uid(), data.orgId, r.code, r.name, r.short, i++)
        .run();
    }
  });

export const createRosterRole = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        code: z.string().max(50),
        name: labelSchema,
        short: z.string().max(10),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    const code = data.code.trim().toLowerCase().replace(/\s+/g, "-");
    if (!code) throw new Error("Role code required");
    const next = await db()
      .prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS n FROM roster_role WHERE orgId = ?")
      .bind(data.orgId)
      .first<{ n: number }>();
    await db()
      .prepare(
        "INSERT OR IGNORE INTO roster_role (id, orgId, code, name, short, sortOrder) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(uid(), data.orgId, code, data.name.trim() || code, data.short.trim() || code, next?.n ?? 1)
      .run();
  });

export const deleteRosterRole = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    await db().prepare("DELETE FROM roster_assignment WHERE orgId = ? AND roleId = ?").bind(data.orgId, data.id).run();
    await db().prepare("DELETE FROM roster_role WHERE id = ? AND orgId = ?").bind(data.id, data.orgId).run();
  });

// ─── Roster week assignments ─────────────────────────────────

export const getRosterWeek = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; weekStart: string }) => data)
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    const rows =
      (
        await db()
          .prepare("SELECT kind, roleId, userId FROM roster_assignment WHERE orgId = ? AND weekStart = ?")
          .bind(data.orgId, data.weekStart)
          .all<{ kind: string; roleId: string | null; userId: string }>()
      ).results ?? [];
    const tech: Record<string, string> = {};
    let pmUserId: string | null = null;
    for (const r of rows) {
      if (r.kind === "pm") pmUserId = r.userId;
      else if (r.roleId) tech[r.roleId] = r.userId;
    }
    return { tech, pmUserId };
  });

export const saveRosterWeek = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        weekStart: weekStartSchema,
        tech: z.array(z.object({ roleId: idSchema, userId: idSchema })).max(100),
        pmUserId: idSchema.nullable(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertKioskAdmin(data.orgId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.weekStart)) throw new Error("Invalid week");
    // Replace the whole week atomically-ish.
    await db()
      .prepare("DELETE FROM roster_assignment WHERE orgId = ? AND weekStart = ?")
      .bind(data.orgId, data.weekStart)
      .run();
    for (const t of data.tech) {
      if (!t.userId) continue;
      await db()
        .prepare(
          "INSERT INTO roster_assignment (id, orgId, weekStart, kind, roleId, userId) VALUES (?, ?, ?, 'tech', ?, ?)",
        )
        .bind(uid(), data.orgId, data.weekStart, t.roleId, t.userId)
        .run();
    }
    if (data.pmUserId) {
      await db()
        .prepare(
          "INSERT INTO roster_assignment (id, orgId, weekStart, kind, roleId, userId) VALUES (?, ?, ?, 'pm', NULL, ?)",
        )
        .bind(uid(), data.orgId, data.weekStart, data.pmUserId)
        .run();
    }
  });
