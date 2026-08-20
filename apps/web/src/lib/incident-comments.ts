import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { hasAnyPermission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

export interface IncidentComment {
  id: string;
  incidentId: string;
  userId: string;
  authorName: string;
  body: string;
  parentId: string | null;
  createdAt: string;
}

async function assertAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({ where: { organizationId: orgId, userId: session.user.id }, select: { role: true } });
  if (!member || !hasAnyPermission(member.role ?? "member", ["incidents:report", "incidents:access"])) throw new Error("Forbidden");
  return session.user;
}

export const getIncidentComments = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, serviceDate: serviceDateSchema, showId: idSchema.optional() }), value))
  .handler(async ({ data }): Promise<IncidentComment[]> => {
    await assertAccess(data.orgId);
    const rows = await getD1().prepare(`SELECT c.id, c.incidentId, c.userId, c.authorName, c.body, c.parentId, c.createdAt FROM incident_comment c JOIN incident i ON i.id = c.incidentId WHERE c.orgId = ? AND i.orgId = ? AND ${data.showId ? "i.showId = ?" : "i.serviceDate = ?"} ORDER BY c.createdAt ASC`).bind(data.orgId, data.orgId, data.showId ?? data.serviceDate).all<IncidentComment>();
    return rows.results ?? [];
  });

export const addIncidentComment = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, incidentId: idSchema, parentId: idSchema.nullable().optional(), body: z.string().trim().min(1).max(2000) }), value))
  .handler(async ({ data }): Promise<IncidentComment> => {
    const user = await assertAccess(data.orgId);
    const incident = await getD1().prepare("SELECT id, description, reportedBy, serviceDate, showId FROM incident WHERE id = ? AND orgId = ?").bind(data.incidentId, data.orgId).first<{ id: string; description: string; reportedBy: string; serviceDate: string; showId: string | null }>();
    if (!incident) throw new Error("Issue not found");
    let parentAuthorId: string | null = null;
    if (data.parentId) {
      const parent = await getD1().prepare("SELECT userId FROM incident_comment WHERE id = ? AND incidentId = ? AND orgId = ?").bind(data.parentId, data.incidentId, data.orgId).first<{ userId: string }>();
      if (!parent) throw new Error("Reply target not found");
      parentAuthorId = parent.userId;
    }
    const comment: IncidentComment = { id: crypto.randomUUID(), incidentId: data.incidentId, userId: user.id, authorName: user.name, body: data.body.trim(), parentId: data.parentId ?? null, createdAt: new Date().toISOString() };
    await getD1().prepare("INSERT INTO incident_comment (id, orgId, incidentId, userId, authorName, body, parentId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(comment.id, data.orgId, comment.incidentId, comment.userId, comment.authorName, comment.body, comment.parentId, comment.createdAt).run();
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: user.id,
      recipientIds: parentAuthorId ? [parentAuthorId] : [],
      includeLeadership: true,
      type: data.parentId ? "incident-comment-reply" : "incident-comment",
      severity: "warning",
      title: data.parentId ? `${user.name} replied to an issue comment` : `${user.name} commented on an issue`,
      message: comment.body.slice(0, 240),
      actionUrl: `production/incidents?date=${encodeURIComponent(incident.serviceDate)}${incident.showId ? `&show=${encodeURIComponent(incident.showId)}` : ""}&incident=${encodeURIComponent(data.incidentId)}`,
      source: data.incidentId,
      pushTag: `incident-comment-${data.incidentId}`,
    });
    return comment;
  });
