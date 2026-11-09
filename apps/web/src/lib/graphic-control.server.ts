import { z } from "zod";
import {
  graphicControlCommandSchema, graphicControlSnapshotSchema,
  type GraphicControlCommand, type GraphicControlResult, type GraphicControlScope,
} from "@showpilot/shared/graphic-control";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { resolveEffectiveAccess, accessHasAnyPermission } from "./effective-access";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import type { Permission } from "./app-permissions";

type Database = Pick<D1Database, "prepare" | "batch">;
export class GraphicControlAccessError extends Error {}
const denied = () => new GraphicControlAccessError("Your account or graphics permission changed. Reopen Lower Thirds.");
async function authority(headers: Headers, scope: GraphicControlScope, db: Database, permission?: Permission) {
  const session = await getAuth().api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== scope.userId) throw denied();
  const effective = await resolveEffectiveAccess(db, scope.userId, scope.orgId);
  if (!effective) throw denied();
  const allowed = (["lowerthird:view", "lowerthird:configure", "lowerthird:trigger"] as const)
    .filter(value => accessHasAnyPermission(effective, [value]));
  const required = permission ?? allowed[0];
  if (!required || !allowed.some(value => value === required)) throw denied();
  const access = await memberPermissionGuard(db, scope.orgId, { userId: scope.userId, sessionId: session.session.id }, [required])
    .catch(error => { if (error instanceof Error && error.message === "Your session or required permission is no longer active.") throw denied(); throw error; });
  if (permission) {
    access.guard += " AND EXISTS(SELECT 1 FROM organization WHERE id=? AND cloud_enabled=1)";
    access.guardArgs.push(scope.orgId);
  }
  return { ...access, canConfigure: allowed.includes("lowerthird:configure"), canTrigger: allowed.includes("lowerthird:trigger") };
}
type Access = Awaited<ReturnType<typeof authority>>;
function statements(db: Database, scope: GraphicControlScope, access: Access) {
  const { orgId } = scope;
  return [
    db.prepare(`SELECT 1 WHERE ${access.guard}`).bind(...access.guardArgs),
    db.prepare(`SELECT cloud_enabled AS cloudEnabled, COALESCE((SELECT revision FROM graphics_output_revision WHERE orgId=?),0) AS programRevision FROM organization WHERE id=? AND ${access.guard}`).bind(orgId, orgId, ...access.guardArgs),
    db.prepare(`SELECT g.id,g.name,g.title,g.subtitle,COALESCE(r.revision,0) AS revision
      FROM graphic_template g LEFT JOIN graphic_template_revision r ON r.orgId=g.orgId AND r.graphicId=g.id
      WHERE g.orgId=? AND ${access.guard} ORDER BY g.createdAt,g.id`).bind(orgId, ...access.guardArgs),
    db.prepare(`SELECT key,value FROM app_setting WHERE orgId=? AND key IN ('active-graphics','active-graphic') AND ${access.guard}`).bind(orgId, ...access.guardArgs),
  ];
}
function snapshot(scope: GraphicControlScope, access: Access, result: D1Result[]) {
  if (!result[0].results.length || !result[1].results.length) throw denied();
  const org = z.object({ cloudEnabled: z.union([z.number(), z.boolean()]), programRevision: z.number() }).parse(result[1].results[0]);
  const values = z.array(z.object({ key: z.string(), value: z.string() })).parse(result[3].results);
  const multi = values.find(row => row.key === "active-graphics"), legacy = values.find(row => row.key === "active-graphic");
  let unknownProgram = false;
  let ids: unknown = [];
  if (multi) { try { ids = JSON.parse(multi.value); } catch { unknownProgram = true; } }
  else if (legacy?.value) ids = [legacy.value];
  if (!Array.isArray(ids)) { ids = []; unknownProgram = true; }
  const activeIds: string[] = [];
  if (Array.isArray(ids)) for (const id of ids) {
    if (typeof id !== "string" || !id.length || id.length > 64) unknownProgram = true;
    else if (!activeIds.includes(id)) activeIds.push(id);
  }
  const templates = graphicControlSnapshotSchema.shape.templates.parse(result[2].results);
  if (activeIds.some(id => !templates.some(template => template.id === id))) unknownProgram = true;
  return graphicControlSnapshotSchema.parse({ ...scope, serverTime: Date.now(), programRevision: org.programRevision,
    cloudEnabled: Boolean(org.cloudEnabled), canConfigure: access.canConfigure, canTrigger: access.canTrigger,
    templates, activeIds, unknownProgram });
}
export async function readGraphicControl(headers: Headers, scope: GraphicControlScope, db: Database = getD1()) {
  const access = await authority(headers, scope, db);
  return snapshot(scope, access, await db.batch(statements(db, scope, access)));
}

/** Receipt, revision checks and mutation commit in one transaction. Reviewing
 * an uncommitted request cancels it before a delayed transport can apply it. */
export async function writeGraphicControl(headers: Headers, input: GraphicControlCommand, mode: "save" | "review", db: Database = getD1()): Promise<GraphicControlResult> {
  const command = graphicControlCommandSchema.parse(input);
  const { orgId, userId, requestId, operation } = command;
  const output = operation.kind === "show" || operation.kind === "hide" || operation.kind === "clear";
  const access = await authority(headers, command, db, mode === "save" ? output ? "lowerthird:trigger" : "lowerthird:configure" : undefined);
  const before = snapshot(command, access, await db.batch(statements(db, command, access)));
  const fingerprint = JSON.stringify(command), nonce = crypto.randomUUID(), key = [orgId, userId, requestId];
  const owns = "EXISTS(SELECT 1 FROM graphic_control_request WHERE orgId=? AND actorId=? AND requestId=? AND nonce=? AND outcome='applied')";
  const receipt = db.prepare(`SELECT fingerprint,outcome FROM graphic_control_request WHERE orgId=? AND actorId=? AND requestId=? AND ${access.guard}`).bind(...key, ...access.guardArgs);
  // Existing receipts remain recoverable after their original send deadline.
  const existing = await receipt.first();
  if (mode === "save" && output && !existing && operation.expiresAt > Date.now() + 5_000)
    throw new Error("Refresh graphics before sending another output change.");
  const checks: string[] = [], args: unknown[] = [];
  if (operation.kind === "create") {
    checks.push("NOT EXISTS(SELECT 1 FROM graphic_template WHERE id=?)"); args.push(requestId);
  } else {
    // The canonical ids below come from this snapshot, never a newer revision
    // that happened to match a caller-supplied future revision during commit.
    checks.push("?=1"); args.push(before.programRevision === operation.expectedProgramRevision ? 1 : 0);
    checks.push("COALESCE((SELECT revision FROM graphics_output_revision WHERE orgId=?),0)=?");
    args.push(orgId, operation.expectedProgramRevision);
    if (operation.kind !== "clear") {
      checks.push(`EXISTS(SELECT 1 FROM graphic_template g JOIN graphic_template_revision r ON r.orgId=g.orgId AND r.graphicId=g.id WHERE g.orgId=? AND g.id=? AND r.revision=?)`);
      args.push(orgId, operation.id, operation.expectedGraphicRevision);
      checks.push("?=1"); args.push(before.unknownProgram ? 0 : 1);
    }
  }
  const insert = db.prepare(`INSERT INTO graphic_control_request(orgId,actorId,requestId,fingerprint,nonce,outcome)
    SELECT ?,?,?,?,?,CASE WHEN ?='review' THEN 'cancelled'
      WHEN ? IS NOT NULL AND ?<=(julianday('now')-2440587.5)*86400000 THEN 'expired'
      WHEN ${checks.join(" AND ")} THEN 'applied' ELSE 'conflict' END
    WHERE ${access.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`)
    .bind(...key, fingerprint, nonce, mode, output ? operation.expiresAt : null, output ? operation.expiresAt : null, ...args, ...access.guardArgs);
  const changes: D1PreparedStatement[] = [];
  if (operation.kind === "create") {
    changes.push(db.prepare(`INSERT INTO graphic_template(id,orgId,name,title,subtitle,style,createdAt,updatedAt)
      SELECT ?,?,?,?,?,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP WHERE ${owns}`)
      .bind(requestId, orgId, operation.content.name, operation.content.title, operation.content.subtitle, ...key, nonce));
  } else if (operation.kind === "update") {
    changes.push(db.prepare(`UPDATE graphic_template SET name=?,title=?,subtitle=?,updatedAt=CURRENT_TIMESTAMP WHERE orgId=? AND id=? AND ${owns}`)
      .bind(operation.content.name, operation.content.title, operation.content.subtitle, orgId, operation.id, ...key, nonce));
  } else if (operation.kind === "delete") {
    changes.push(db.prepare(`DELETE FROM graphic_template WHERE orgId=? AND id=? AND ${owns}`).bind(orgId, operation.id, ...key, nonce));
  }
  if (output || (operation.kind === "delete" && before.activeIds.includes(operation.id))) {
    const ids = operation.kind === "clear" ? [] : operation.kind === "show"
      ? [...new Set([...before.activeIds, operation.id])]
      : operation.kind === "hide" || operation.kind === "delete" ? before.activeIds.filter(id => id !== operation.id) : before.activeIds;
    changes.push(db.prepare(`INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,'active-graphics',? WHERE ${owns}
      ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`).bind(crypto.randomUUID(), orgId, JSON.stringify(ids), ...key, nonce));
    changes.push(db.prepare(`DELETE FROM app_setting WHERE orgId=? AND key='active-graphic' AND ${owns}`).bind(orgId, ...key, nonce));
  }
  const result = await db.batch([insert, ...changes, receipt, ...statements(db, command, access)]);
  markDatabaseWrite();
  const row = result[changes.length + 1].results[0];
  if (!row) throw denied();
  const saved = z.object({ fingerprint: z.string(), outcome: z.enum(["applied", "conflict", "cancelled", "expired"]) }).parse(row);
  if (saved.fingerprint !== fingerprint) throw new Error("This request belongs to a different graphics change. Retry the original request.");
  return { orgId, userId, requestId, outcome: saved.outcome, snapshot: snapshot(command, access, result.slice(changes.length + 2)) };
}
