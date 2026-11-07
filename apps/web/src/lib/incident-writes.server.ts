import type { OperationalNotification } from "./operational-notifications.server";
import type { IncidentWrite, IncidentWriteResult } from "./incident-writes";

// Compare all mutable incident fields and the discussion size in the same
// transaction as removal. This also detects edits made through existing mobile
// and dashboard APIs without inventing a separate revision those APIs cannot see.
export const incidentDeleteSnapshotSql = `json_array(i.category, i.severity, i.description, i.reportedBy, i.serviceDate,
  i.status, i.resolvedAt, i.resolvedBy, i.assignedTo, i.assignedName, i.acknowledgedAt, i.assignedBy, i.assignedAt,
  (SELECT COUNT(*) FROM incident_comment c WHERE c.orgId = i.orgId AND c.incidentId = i.id))`;

export async function applyIncidentWrite(db: Pick<D1Database, "prepare" | "batch">, input: IncidentWrite, user: { id: string; name: string }): Promise<{ result: IncidentWriteResult; notification: OperationalNotification | null }> {
  const { orgId, showId, serviceDate, requestId, operation: op } = input;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ showId, serviceDate, userId: user.id, operation: op }))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `incident-write:${requestId}`, token = crypto.randomUUID();
  const readReceipt = async () => {
    const row = await db.prepare("SELECT json_extract(value, '$.digest') AS digest, json_extract(value, '$.token') AS token, json_extract(value, '$.outcome') AS outcome FROM app_setting WHERE orgId = ? AND key = ?")
      .bind(orgId, key).first<{ digest: string; token: string; outcome: string }>();
    if (!row) return null;
    if (row.digest !== digest) throw new Error("This request was already used for a different incident change.");
    if (row.outcome !== "applied" && row.outcome !== "conflict") throw new Error("Invalid incident acknowledgement.");
    const result: IncidentWriteResult = { requestId, outcome: row.outcome };
    return { result, token: row.token };
  };
  const existing = await readReceipt();
  if (existing) return { result: existing.result, notification: null };
  const applied = JSON.stringify({ digest, token, outcome: "applied" }), conflict = JSON.stringify({ digest, token, outcome: "conflict" });
  const guard = "EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)";
  const claim = [orgId, key, applied];
  // Mobile can record an incident by date without a show. Keep its existing
  // discussion manageable, but never let a date-only command touch a show row.
  const incidentScope = showId ? "i.orgId = ? AND i.showId = ?" : "i.orgId = ? AND i.showId IS NULL AND i.serviceDate = ?";
  const scope = [orgId, showId ?? serviceDate];
  let condition = showId ? "EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND id = ? AND serviceDate = ?)" : "1";
  const conditions: (string | null)[] = showId ? [orgId, showId, serviceDate] : [];
  const mutations: D1PreparedStatement[] = [];
  let notification: OperationalNotification | null = null;
  const path = (id: string) => `production/incidents?date=${encodeURIComponent(serviceDate)}${showId ? `&show=${encodeURIComponent(showId)}` : ""}&incident=${encodeURIComponent(id)}`;
  const common = { orgId, actorId: user.id, category: "incidents", dedupeKey: `incident-write:${requestId}`, once: true } as const;
  switch (op.kind) {
    case "report": {
      const id = `incident-${requestId}`;
      condition += " AND NOT EXISTS (SELECT 1 FROM incident WHERE id = ?)"; conditions.push(id);
      mutations.push(db.prepare(`INSERT INTO incident (id, orgId, showId, serviceDate, category, severity, description, reportedBy, timestamp)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`).bind(id, orgId, showId, serviceDate, op.category, op.severity, op.description, op.reportedBy, new Date().toISOString(), ...claim));
      notification = { ...common, includeLeadership: true, type: "incident-created", severity: op.severity === "high" || op.severity === "critical" ? "critical" : "warning", title: `New ${op.severity} ${op.category} issue`, message: op.description.slice(0, 240), actionUrl: path(id), source: id, pushTag: `incident-${id}` };
      break;
    }
    case "delete":
      condition += ` AND EXISTS (SELECT 1 FROM incident i WHERE ${incidentScope} AND i.id = ? AND ${incidentDeleteSnapshotSql} = ?)`;
      conditions.push(...scope, op.id, op.snapshot);
      mutations.push(db.prepare(`DELETE FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment'
        AND targetId IN (SELECT id FROM incident_comment WHERE orgId = ? AND incidentId = ?) AND ${guard}`).bind(orgId, orgId, op.id, ...claim));
      mutations.push(db.prepare(`DELETE FROM incident WHERE orgId = ? AND showId IS ? AND id = ? AND ${guard}`).bind(orgId, showId, op.id, ...claim));
      break;
    case "comment": {
      const id = `comment-${requestId}`;
      condition += ` AND EXISTS (SELECT 1 FROM incident i WHERE ${incidentScope} AND i.id = ?) AND NOT EXISTS (SELECT 1 FROM incident_comment WHERE id = ?)`;
      conditions.push(...scope, op.incidentId, id);
      let parentAuthorId: string | null = null;
      if (op.parentId) {
        condition += " AND EXISTS (SELECT 1 FROM incident_comment WHERE orgId = ? AND incidentId = ? AND id = ?)";
        conditions.push(orgId, op.incidentId, op.parentId);
        parentAuthorId = (await db.prepare("SELECT userId FROM incident_comment WHERE orgId = ? AND incidentId = ? AND id = ?").bind(orgId, op.incidentId, op.parentId).first<{ userId: string }>())?.userId ?? null;
      }
      mutations.push(db.prepare(`INSERT INTO incident_comment (id, orgId, incidentId, userId, authorName, body, parentId, createdAt)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`).bind(id, orgId, op.incidentId, user.id, user.name, op.body, op.parentId, new Date().toISOString(), ...claim));
      notification = { ...common, includeLeadership: true, recipientIds: parentAuthorId ? [parentAuthorId] : [], type: op.parentId ? "incident-comment-reply" : "incident-comment", severity: "warning", title: op.parentId ? `${user.name} replied to an issue comment` : `${user.name} commented on an issue`, message: op.body.slice(0, 240), actionUrl: path(op.incidentId), source: op.incidentId, pushTag: `incident-comment-${op.incidentId}` };
      break;
    }
    case "reaction": {
      condition += ` AND EXISTS (SELECT 1 FROM incident_comment c JOIN incident i ON i.id = c.incidentId AND i.orgId = c.orgId WHERE ${incidentScope} AND c.id = ?)
        AND (SELECT id FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment' AND targetId = ? AND userId = ? AND emoji = ?) IS ?`;
      conditions.push(...scope, op.commentId, orgId, op.commentId, user.id, op.emoji, op.expectedId);
      if (op.active) {
        mutations.push(db.prepare(`INSERT INTO content_reaction (id, orgId, targetType, targetId, userId, authorName, emoji)
          SELECT ?, ?, 'incident-comment', ?, ?, ?, ? WHERE ${guard} ON CONFLICT (orgId, targetType, targetId, userId, emoji) DO NOTHING`)
          .bind(`reaction-${requestId}`, orgId, op.commentId, user.id, user.name, op.emoji, ...claim));
        const target = await db.prepare(`SELECT c.userId, c.incidentId FROM incident_comment c JOIN incident i ON i.id=c.incidentId AND i.orgId=c.orgId WHERE ${incidentScope} AND c.id=?`).bind(...scope, op.commentId).first<{ userId: string; incidentId: string }>();
        if (target && target.userId !== user.id) notification = { ...common, recipientIds: [target.userId], type: "comment-reaction", title: `${user.name} reacted ${op.emoji} to your comment`, message: "Open the incident discussion to view the reaction.", actionUrl: path(target.incidentId), source: op.commentId, pushTag: `comment-reaction-${op.commentId}` };
      } else mutations.push(db.prepare(`DELETE FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment' AND targetId = ? AND userId = ? AND emoji = ? AND ${guard}`).bind(orgId, op.commentId, user.id, op.emoji, ...claim));
      break;
    }
    default: { const unexpected: never = op; throw new Error(`Unknown incident change: ${String(unexpected)}`); }
  }
  const receipt = db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
    VALUES (?, ?, ?, CASE WHEN ${condition} THEN ? ELSE ? END) ON CONFLICT(orgId, key) DO NOTHING`).bind(crypto.randomUUID(), orgId, key, ...conditions, applied, conflict);
  await db.batch([receipt, ...mutations]);
  const saved = await readReceipt();
  if (!saved) throw new Error("Missing incident acknowledgement.");
  return { result: saved.result, notification: saved.token === token && saved.result.outcome === "applied" ? notification : null };
}
