import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { z } from "zod";
import { kioskTeamCommandSchema } from "./kiosk-team-contract";
import { executeKioskTeamCommand } from "./kiosk-team-command.server";
import { idSchema, parseOrThrow } from "@/lib/validation";


// ─────────────────────────────────────────────────────────────
// Admin CRUD for the kiosk Org Chart (teams) and On-Duty roster.
// Writes to the raw D1 tables added in migration 0005 (not in the
// Prisma client), gated by the same "settings:members" permission used
// for managing org people.
// ─────────────────────────────────────────────────────────────

const db = () => getD1();

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
  revision: number;
  members: { userId: string; name: string; image: string | null; role: string }[];
}

export const getKioskTeams = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<AdminTeam[]> => {
    await assertKioskAdmin(data.orgId);
    // Read each team's revision and membership from one SQLite snapshot.
    const teams = await db().prepare(`SELECT t.id,t.name,t.color,t.sortOrder,t.revision,
      (SELECT json_group_array(json_object('userId',people.userId,'name',people.name,'image',people.image,'role',people.role)) FROM (
        SELECT tm.userId,u.name,u.image,tm.role FROM team_member tm
        JOIN user u ON u.id=tm.userId JOIN member m ON m.userId=tm.userId AND m.organizationId=t.orgId
        WHERE tm.teamId=t.id ORDER BY CASE tm.role WHEN 'lead' THEN 0 ELSE 1 END,tm.sortOrder,u.name
      ) people) AS members
      FROM team t WHERE t.orgId=? ORDER BY t.sortOrder,t.name`).bind(data.orgId)
      .all<{id:string;name:string;color:string;sortOrder:number;revision:number;members:string}>();
    const membersSchema=z.array(z.object({userId:idSchema,name:z.string(),image:z.string().nullable(),role:z.string()}));
    return teams.results.map(team=>({...team,members:membersSchema.parse(JSON.parse(team.members))}));
  });

export const writeKioskTeam = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(kioskTeamCommandSchema, data))
  .handler(async ({ data }) => {
    const { getAuth } = await import("./auth");
    const session = await getAuth().api.getSession({ headers: getRequestHeaders(), query: { disableCookieCache: true } });
    if (!session) throw new Error("Sign in before editing kiosk teams.");
    return executeKioskTeamCommand(data, { userId: session.user.id, sessionId: session.session.id });
  });
