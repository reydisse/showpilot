import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getD1 } from "./d1";
import { assertOrgPermission } from "./org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "./validation";
import { incidentWriteSchema, incidentRowSchema, incidentCommentSchema, incidentReactionSchema } from "./incident-writes";
import { applyIncidentWrite, incidentDeleteSnapshotSql } from "./incident-writes.server";

export const getIncidentSnapshot = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, showId: idSchema.nullable(), serviceDate: serviceDateSchema }), value))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, ["incidents:report", "incidents:access"]);
    const db = getD1(), scope = [data.orgId, data.showId ?? data.serviceDate];
    const where = data.showId ? "i.orgId = ? AND i.showId = ?" : "i.orgId = ? AND i.showId IS NULL AND i.serviceDate = ?";
    // One transaction gives the page a consistent incident/discussion/reaction
    // snapshot, with no caller-supplied target list or SQL parameter limit.
    const rows = await db.batch([
      db.prepare(`SELECT i.id, i.category, i.severity, i.description, i.reportedBy, strftime('%Y-%m-%dT%H:%M:%fZ', i.timestamp) AS timestamp, i.status, i.assignedTo, i.assignedName, strftime('%Y-%m-%dT%H:%M:%fZ', i.acknowledgedAt) AS acknowledgedAt, ${incidentDeleteSnapshotSql} AS deleteSnapshot FROM incident i WHERE ${where} ORDER BY i.timestamp DESC, i.id`).bind(...scope),
      db.prepare(`SELECT c.id, c.incidentId, c.userId, c.authorName, c.body, c.parentId, strftime('%Y-%m-%dT%H:%M:%fZ', c.createdAt) AS createdAt FROM incident_comment c JOIN incident i ON i.id=c.incidentId AND i.orgId=c.orgId WHERE ${where} ORDER BY c.createdAt, c.id`).bind(...scope),
      db.prepare(`SELECT r.id, r.targetId, r.userId, r.authorName, r.emoji, strftime('%Y-%m-%dT%H:%M:%fZ', r.createdAt) AS createdAt FROM content_reaction r JOIN incident_comment c ON c.id=r.targetId AND c.orgId=r.orgId JOIN incident i ON i.id=c.incidentId AND i.orgId=c.orgId WHERE ${where} AND r.targetType='incident-comment' ORDER BY r.createdAt, r.id`).bind(...scope),
    ]);
    // D1 batch's single result generic cannot represent heterogeneous statements.
    // Parse rows at the storage boundary before publishing the combined snapshot.
    const incidents = z.array(incidentRowSchema).parse(rows[0].results);
    const comments = z.array(incidentCommentSchema).parse(rows[1].results);
    const reactions = z.array(incidentReactionSchema).parse(rows[2].results);
    return { incidents, comments, reactions, viewerId: user.id };
  });

export const mutateIncident = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(incidentWriteSchema, value))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, data.operation.kind === "delete" ? "incidents:access" : ["incidents:report", "incidents:access"]);
    const { result, notification } = await applyIncidentWrite(getD1(), data, user);
    if (notification) {
      const { scheduleIncidentNotification } = await import("./incident-notification.server");
      scheduleIncidentNotification(notification);
    }
    return result;
  });
