import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { hasAnyPermission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

export interface IncidentComment { id: string; incidentId: string; userId: string; authorName: string; body: string; createdAt: string; }

async function assertAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({ where: { organizationId: orgId, userId: session.user.id }, select: { role: true } });
  if (!member || !hasAnyPermission(member.role ?? "member", ["incidents:report", "incidents:access"])) throw new Error("Forbidden");
  return session.user;
}

export const getIncidentComments = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema }), value))
  .handler(async ({ data }): Promise<IncidentComment[]> => {
    await assertAccess(data.orgId);
    const rows = await getD1().prepare(`SELECT c.id, c.incidentId, c.userId, c.authorName, c.body, c.createdAt FROM incident_comment c JOIN incident i ON i.id = c.incidentId WHERE c.orgId = ? AND i.orgId = ? AND i.serviceDate = ? ORDER BY c.createdAt ASC`).bind(data.orgId, data.orgId, data.serviceDate).all<IncidentComment>();
    return rows.results ?? [];
  });

export const addIncidentComment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, incidentId: idSchema, body: z.string().trim().min(1).max(2000) }), value))
  .handler(async ({ data }): Promise<IncidentComment> => {
    const user = await assertAccess(data.orgId);
    const incident = await getD1().prepare("SELECT id FROM incident WHERE id = ? AND orgId = ?").bind(data.incidentId, data.orgId).first<{ id: string }>();
    if (!incident) throw new Error("Issue not found");
    const comment: IncidentComment = { id: crypto.randomUUID(), incidentId: data.incidentId, userId: user.id, authorName: user.name, body: data.body.trim(), createdAt: new Date().toISOString() };
    await getD1().prepare("INSERT INTO incident_comment (id, orgId, incidentId, userId, authorName, body, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(comment.id, data.orgId, comment.incidentId, comment.userId, comment.authorName, comment.body, comment.createdAt).run();
    return comment;
  });
