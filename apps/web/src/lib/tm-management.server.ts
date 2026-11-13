import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { resolveEffectiveAccess } from "./effective-access";
import { isAdminTier } from "./app-permissions";
import {
  memberCapabilityGuard,
  memberPermissionGuard,
} from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import { notifyOperationalEvent } from "./operational-notifications.server";
import { withOperationTimeout } from "./operation-timeout";
import {
  completeTmLayout,
  defaultTmLayout,
  tmLayoutSchema,
  tmManagementCommandSchema,
  tmManagementResultSchema,
  tmManagementStateSchema,
  type TmManagementScope,
  type TmManagementCommand,
  type TmManagementResult,
} from "./tm-management-contract";
type Database = Pick<D1Database, "prepare" | "batch">;
const denied = () =>
  new Error(
    "Your session or Tech Manager permission changed. Reopen the dashboard.",
  );
async function authority(
  headers: Headers,
  scope: TmManagementScope,
  db: Database,
  incidentWrite = false,
) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== scope.userId) throw denied();
  const access = await resolveEffectiveAccess(db, scope.userId, scope.orgId);
  if (!access) throw denied();
  const guard = await memberPermissionGuard(
    db,
    scope.orgId,
    { userId: scope.userId, sessionId: session.session.id },
    incidentWrite ? ["dashboard:tm", "incidents:access"] : ["dashboard:tm"],
  );
  return {
    ...guard,
    role: guard.role,
    name: session.user.name,
    canManageIncidents: access.permissions.includes("incidents:access"),
    canAssignPeople:
      isAdminTier(guard.role) &&
      access.permissions.includes("incidents:access"),
  };
}
type Access = Awaited<ReturnType<typeof authority>>;
async function state(scope: TmManagementScope, access: Access, db: Database) {
  const row = await db
    .prepare(
      `SELECT
    (SELECT layout FROM dashboard_layout WHERE orgId=? AND userId=? AND dashboard='tech-manager') AS layout,
    COALESCE((SELECT revision FROM dashboard_layout_revision WHERE orgId=? AND userId=? AND dashboard='tech-manager'),0) AS layoutRevision,
    (SELECT COUNT(*) FROM tm_management_request WHERE orgId=? AND notificationStatus='pending') AS pendingNotifications
    WHERE ${access.guard}`,
    )
    .bind(
      scope.orgId,
      scope.userId,
      scope.orgId,
      scope.userId,
      scope.orgId,
      ...access.guardArgs,
    )
    .first<{
      layout: string | null;
      layoutRevision: number;
      pendingNotifications: number;
    }>();
  if (!row) throw denied();
  let layout = defaultTmLayout(),
    layoutUnknown = false;
  if (row.layout !== null) {
    try {
      layout = completeTmLayout(tmLayoutSchema.parse(JSON.parse(row.layout)));
    } catch {
      layoutUnknown = true;
    }
  }
  return tmManagementStateSchema.parse({
    ...scope,
    serverTime: Date.now(),
    layout,
    layoutUnknown,
    layoutRevision: row.layoutRevision,
    pendingNotifications: row.pendingNotifications,
    canManageIncidents: access.canManageIncidents,
    canAssignPeople: access.canAssignPeople,
  });
}
export async function readTmManagement(
  headers: Headers,
  scope: TmManagementScope,
  db: Database = getD1(),
) {
  return await state(scope, await authority(headers, scope, db), db);
}
const notificationPayload = z.object({
  actorName: z.string(),
  kind: z.enum(["assign", "acknowledge", "resolve"]),
  assignedTo: z.string().nullable(),
  assignedName: z.string(),
});
type Receipt = {
  fingerprint: string;
  outcome: TmManagementResult["outcome"];
  notificationStatus: TmManagementResult["notification"];
  notification: string | null;
  incidentId: string | null;
  appliedRevision: number | null;
};
async function deliverReceiptNotification(
  db: Database,
  scope: TmManagementScope,
  requestId: string,
  receipt: Receipt,
) {
  if (
    receipt.notificationStatus !== "pending" ||
    !receipt.notification ||
    !receipt.incidentId
  )
    return;
  const { orgId, userId } = scope;
  const revision = await db
    .prepare(
      `SELECT r.revision FROM incident i JOIN incident_management_revision r ON r.orgId=i.orgId AND r.incidentId=i.id WHERE i.orgId=? AND i.id=?`,
    )
    .bind(orgId, receipt.incidentId)
    .first<{ revision: number }>();
  if (revision?.revision !== receipt.appliedRevision) {
    await db
      .prepare(
        "UPDATE tm_management_request SET notificationStatus='skipped' WHERE orgId=? AND actorId=? AND requestId=? AND notificationStatus='pending'",
      )
      .bind(orgId, userId, requestId)
      .run();
    return;
  }
  const payload = notificationPayload.parse(JSON.parse(receipt.notification));
  const assigned = payload.kind === "assign" && payload.assignedTo !== null;
  await notifyOperationalEvent({
    orgId,
    actorId: userId,
    includeLeadership: true,
    recipientIds:
      payload.kind === "assign" && payload.assignedTo
        ? [payload.assignedTo]
        : [],
    category: "incidents",
    type:
      payload.kind === "assign"
        ? assigned
          ? "incident-assigned"
          : "incident-unassigned"
        : payload.kind === "acknowledge"
          ? "incident-acknowledged"
          : "incident-resolved",
    severity: payload.kind === "resolve" ? "info" : "warning",
    title:
      payload.kind === "assign"
        ? "Incident assignment changed"
        : payload.kind === "acknowledge"
          ? "Incident acknowledged"
          : "Incident resolved",
    message: `${payload.kind === "assign" ? (assigned ? `${payload.assignedName} was assigned this issue.` : `${payload.actorName} returned this issue to the queue.`) : payload.kind === "acknowledge" ? `${payload.actorName} acknowledged this issue.` : `${payload.actorName} marked this issue resolved.`} Open it to check the current status.`,
    actionUrl: `production/incidents?incident=${encodeURIComponent(receipt.incidentId)}`,
    source: receipt.incidentId,
    pushTag: `incident-${receipt.incidentId}`,
    dedupeKey: `tm-management:${userId}:${requestId}`,
    once: true,
    requireInbox: true,
  });
  await db
    .prepare(
      "UPDATE tm_management_request SET notificationStatus='delivered' WHERE orgId=? AND actorId=? AND requestId=? AND notificationStatus='pending'",
    )
    .bind(orgId, userId, requestId)
    .run();
}
async function attemptNotification(
  db: Database,
  scope: TmManagementScope,
  requestId: string,
  receipt: Receipt,
) {
  // A notification failure never changes the committed business outcome. The
  // durable receipt stays pending, and inbox dedupe also fences concurrent retries.
  const work = deliverReceiptNotification(db, scope, requestId, receipt).catch(
    () => {},
  );
  waitUntil(work);
  try {
    await withOperationTimeout(
      work,
      3_000,
      "Notification delivery is still pending.",
    );
  } catch {
    /* Exposed through notificationStatus and the retry action. */
  }
}
export async function retryTmManagementNotifications(
  headers: Headers,
  scope: TmManagementScope,
  db: Database = getD1(),
) {
  const access = await authority(headers, scope, db, true);
  const jobs = await db
    .prepare(
      `SELECT actorId,requestId,fingerprint,outcome,notificationStatus,notification,incidentId,appliedRevision FROM tm_management_request WHERE orgId=? AND notificationStatus='pending' AND ${access.guard} LIMIT 12`,
    )
    .bind(scope.orgId, ...access.guardArgs)
    .all<Receipt & { actorId: string; requestId: string }>();
  markDatabaseWrite();
  await Promise.all(
    jobs.results.map((job) =>
      attemptNotification(
        db,
        { orgId: scope.orgId, userId: job.actorId },
        job.requestId,
        job,
      ),
    ),
  );
  return state(scope, access, db);
}
export async function writeTmManagement(
  headers: Headers,
  input: TmManagementCommand,
  mode: "write" | "review",
  db: Database = getD1(),
): Promise<TmManagementResult> {
  const command = tmManagementCommandSchema.parse(input),
    op = command.operation;
  const { orgId, userId, requestId } = command;
  const access = await authority(
    headers,
    command,
    db,
    mode === "write" && op.kind !== "layout",
  );
  const key = [orgId, userId, requestId],
    fingerprint = JSON.stringify(command),
    nonce = crypto.randomUUID();
  const receipt = () =>
    db
      .prepare(
        `SELECT fingerprint,outcome,notificationStatus,notification,incidentId,appliedRevision FROM tm_management_request WHERE orgId=? AND actorId=? AND requestId=? AND ${access.guard}`,
      )
      .bind(...key, ...access.guardArgs)
      .first<Receipt>();
  let saved = await receipt();
  if (saved?.fingerprint !== undefined && saved.fingerprint !== fingerprint)
    throw new Error(
      "This request was already used for a different dashboard change.",
    );
  if (!saved) {
    if (mode === "write" && command.expiresAt > Date.now() + 30_000)
      throw new Error(
        "Refresh the dashboard before submitting another change.",
      );
    const checks: string[] = [],
      values: (string | number | null)[] = [];
    let assignedName = "";
    if (op.kind === "layout") {
      checks.push(
        "COALESCE((SELECT revision FROM dashboard_layout_revision WHERE orgId=? AND userId=? AND dashboard='tech-manager'),0)=?",
      );
      values.push(orgId, userId, op.expectedRevision);
    } else {
      checks.push(
        "EXISTS(SELECT 1 FROM incident i JOIN incident_management_revision r ON r.orgId=i.orgId AND r.incidentId=i.id WHERE i.orgId=? AND i.id=? AND i.status<>'resolved' AND r.revision=?)",
      );
      values.push(orgId, op.id, op.expectedRevision);
      if (
        op.kind === "acknowledge" ||
        (op.kind === "assign" &&
          op.assignedTo === null &&
          !access.canAssignPeople)
      ) {
        checks.push(
          "EXISTS(SELECT 1 FROM incident WHERE orgId=? AND id=? AND assignedTo=?)",
        );
        values.push(orgId, op.id, userId);
      }
      if (op.kind === "assign" && op.assignedTo !== null && mode === "write") {
        if (op.assignedTo !== userId && !access.canAssignPeople)
          throw new Error(
            "Only a team administrator can assign another operator.",
          );
        const target = await memberCapabilityGuard(
          db,
          orgId,
          { userId: op.assignedTo },
          ["incidents:access"],
        );
        checks.push(target.guard);
        values.push(...target.guardArgs);
        const member = await db
          .prepare(
            "SELECT u.name FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND m.userId=?",
          )
          .bind(orgId, op.assignedTo)
          .first<{ name: string }>();
        if (!member)
          throw new Error(
            "That operator is no longer a member of this workspace.",
          );
        assignedName = member.name;
      }
    }
    // Reject a guessed future revision as well as changes arriving at commit.
    const matchesNow = await db
      .prepare(`SELECT 1 WHERE ${checks.join(" AND ")}`)
      .bind(...values)
      .first();
    checks.push("?=1");
    values.push(matchesNow ? 1 : 0);
    const owns =
      "EXISTS(SELECT 1 FROM tm_management_request WHERE orgId=? AND actorId=? AND requestId=? AND nonce=? AND outcome='applied')";
    const claim = [...key, nonce];
    const changes: D1PreparedStatement[] = [];
    if (op.kind === "layout") {
      changes.push(
        db
          .prepare(
            `INSERT INTO dashboard_layout(id,orgId,userId,dashboard,layout,updatedAt) SELECT ?,?,?,'tech-manager',?,CURRENT_TIMESTAMP WHERE ${owns}
        ON CONFLICT(orgId,userId,dashboard) DO UPDATE SET layout=excluded.layout,updatedAt=CURRENT_TIMESTAMP`,
          )
          .bind(
            crypto.randomUUID(),
            orgId,
            userId,
            JSON.stringify(completeTmLayout(op.layout)),
            ...claim,
          ),
      );
    } else if (op.kind === "assign") {
      const now = new Date().toISOString();
      changes.push(
        db
          .prepare(
            `UPDATE incident SET assignedTo=?,assignedName=?,acknowledgedAt=?,assignedBy=?,assignedAt=? WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(
            op.assignedTo,
            assignedName,
            op.assignedTo === userId ? now : null,
            op.assignedTo ? userId : null,
            op.assignedTo ? now : null,
            orgId,
            op.id,
            ...claim,
          ),
      );
    } else if (op.kind === "acknowledge") {
      changes.push(
        db
          .prepare(
            `UPDATE incident SET acknowledgedAt=? WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(new Date().toISOString(), orgId, op.id, ...claim),
      );
    } else {
      changes.push(
        db
          .prepare(
            `UPDATE incident SET status='resolved',resolvedAt=?,resolvedBy=? WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(new Date().toISOString(), access.name, orgId, op.id, ...claim),
      );
    }
    const note =
      op.kind === "layout"
        ? null
        : JSON.stringify({
            actorName: access.name,
            kind: op.kind,
            assignedTo: op.kind === "assign" ? op.assignedTo : null,
            assignedName,
          });
    const insert = db
      .prepare(
        `INSERT INTO tm_management_request(orgId,actorId,requestId,fingerprint,nonce,outcome,incidentId,appliedRevision,notification)
      SELECT ?,?,?,?,?,CASE WHEN ?='review' THEN 'cancelled' WHEN ?<=(julianday('now')-2440587.5)*86400000 THEN 'expired' WHEN ${checks.join(" AND ")} THEN 'applied' ELSE 'conflict' END,?,?,?
      WHERE ${access.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
      )
      .bind(
        ...key,
        fingerprint,
        nonce,
        mode,
        command.expiresAt,
        ...values,
        op.kind === "layout" ? null : op.id,
        op.expectedRevision + 1,
        note,
        ...access.guardArgs,
      );
    changes.push(
      db
        .prepare(
          `UPDATE tm_management_request SET notificationStatus='pending' WHERE orgId=? AND actorId=? AND requestId=? AND nonce=? AND outcome='applied' AND notification IS NOT NULL`,
        )
        .bind(...claim),
    );
    markDatabaseWrite();
    await db.batch([insert, ...changes]);
    saved = await receipt();
  }
  if (!saved) throw denied();
  if (saved.fingerprint !== fingerprint)
    throw new Error(
      "This request was already used for a different dashboard change.",
    );
  if (saved.notificationStatus === "pending") {
    await attemptNotification(db, command, requestId, saved);
    saved = await receipt();
  }
  if (!saved) throw denied();
  return tmManagementResultSchema.parse({
    requestId,
    outcome: saved.outcome,
    notification: saved.notificationStatus,
    snapshot: await state(command, access, db),
  });
}
