import { z } from "zod";
import { resolveWorkspaceProfile, WORKSPACE_SETTING_KEYS, WORKSPACE_DEFINITIONS } from "@showpilot/shared";
import { workspaceChangeSchema, type WorkspaceChange, type WorkspaceChangeResult } from "@showpilot/shared/workspace-change";
import { getAuth } from "../auth";
import { getD1 } from "../d1";
import { memberPermissionGuard } from "../member-permission-guard.server";
import { markDatabaseWrite } from "../request-database.server";
import { workspaceEntries } from "./profile.server";
import { WORKSPACE_REVISION_KEY } from "./profile-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
export class WorkspaceChangeAccessError extends Error {}
const denied = () => new WorkspaceChangeAccessError("Your account or workspace permission changed. Reopen Workspace settings.");
async function authority(headers: Headers, scope: { orgId: string; userId: string }, db: Database) {
  const session = await getAuth().api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== scope.userId) throw denied();
  const actor = { userId: session.user.id, sessionId: session.session.id };
  const access = await memberPermissionGuard(db, scope.orgId, actor, ["settings:organization"], false).catch(() => { throw denied(); });
  // Workspace management has always required an owner/admin, even if other
  // roles gain a settings permission in future.
  return { ...access, guard: `${access.guard} AND EXISTS(SELECT 1 FROM member WHERE organizationId=? AND userId=? AND role IN ('owner','admin'))`, guardArgs: [...access.guardArgs, scope.orgId, scope.userId] };
}
const settingKeys = [...WORKSPACE_SETTING_KEYS, WORKSPACE_REVISION_KEY];
function stateStatement(db: Database, orgId: string, access: Awaited<ReturnType<typeof authority>>) {
  return db.prepare(`SELECT key,value FROM app_setting WHERE orgId=? AND key IN (${settingKeys.map(() => "?").join(",")}) AND ${access.guard}`).bind(orgId, ...settingKeys, ...access.guardArgs);
}
function snapshot(scope: { orgId: string; userId: string }, rows: unknown[]) {
  const settings = Object.fromEntries(z.array(z.object({ key: z.string(), value: z.string() })).parse(rows).map(row => [row.key, row.value]));
  return { ...scope, revision: settings[WORKSPACE_REVISION_KEY] ?? null, profile: resolveWorkspaceProfile(settings), settings };
}
export async function readWorkspaceChange(headers: Headers, scope: { orgId: string; userId: string }, db: Database = getD1()) {
  const access = await authority(headers, scope, db);
  const result = await db.batch([
    db.prepare(`SELECT 1 WHERE ${access.guard}`).bind(...access.guardArgs),
    stateStatement(db, scope.orgId, access),
  ]);
  if (!result[0].results.length) throw denied();
  const { settings: _settings, ...current } = snapshot(scope, result[1].results);
  return current;
}

/** The outcome and settings commit together. Review records cancellation when
 * a save has not committed, so an old delayed request cannot apply afterwards. */
export async function writeWorkspaceChange(headers: Headers, input: WorkspaceChange, mode: "save" | "review", db: Database = getD1()): Promise<WorkspaceChangeResult> {
  const command = workspaceChangeSchema.parse(input);
  const { orgId, userId, requestId, expectedRevision, operation } = command;
  const access = await authority(headers, command, db);
  const before = snapshot({ orgId, userId }, (await stateStatement(db, orgId, access).all()).results);
  const candidate = mode === "save" && before.revision === expectedRevision && (operation.kind !== "custom" || WORKSPACE_DEFINITIONS[before.profile.type].customizable);
  const entries = candidate ? workspaceEntries(before.settings, operation.kind === "module"
    ? { kind: "modules", modules: operation.enabled ? [...before.profile.modules, operation.module] : before.profile.modules.filter(id => id !== operation.module) }
    : operation) : [];
  const nonce = crypto.randomUUID();
  const fingerprint = JSON.stringify([expectedRevision, operation]);
  const key = [orgId, userId, requestId];
  const owns = "EXISTS(SELECT 1 FROM workspace_change_request WHERE orgId=? AND actorId=? AND requestId=? AND nonce=? AND outcome='applied')";
  const result = await db.batch([
    db.prepare(`INSERT INTO workspace_change_request(orgId,actorId,requestId,fingerprint,nonce,outcome)
      SELECT ?,?,?,?,?,CASE WHEN ?='review' THEN 'cancelled' WHEN ?=1 AND
      (SELECT value FROM app_setting WHERE orgId=? AND key=?) IS ? THEN 'applied' ELSE 'conflict' END
      WHERE ${access.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`)
      .bind(...key, fingerprint, nonce, mode, candidate ? 1 : 0, orgId, WORKSPACE_REVISION_KEY, expectedRevision, ...access.guardArgs),
    ...[...entries, [WORKSPACE_REVISION_KEY, nonce]].map(([name, value]) => db.prepare(`INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,?,? WHERE ${owns} ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`)
      .bind(crypto.randomUUID(), orgId, name, value, ...key, nonce)),
    db.prepare(`SELECT fingerprint,nonce,outcome FROM workspace_change_request WHERE orgId=? AND actorId=? AND requestId=? AND ${access.guard}`).bind(...key, ...access.guardArgs),
    stateStatement(db, orgId, access),
  ]);
  markDatabaseWrite();
  const row = result[result.length - 2].results[0];
  if (!row) throw denied();
  const receipt = z.object({ fingerprint: z.string(), nonce: z.string(), outcome: z.enum(["applied", "conflict", "cancelled"]) }).parse(row);
  if (receipt.fingerprint !== fingerprint) throw new Error("This request belongs to a different workspace change. Retry the original change.");
  const { settings: _settings, ...current } = snapshot({ orgId, userId }, result[result.length - 1].results);
  return { orgId, userId, requestId, snapshot: current, outcome: receipt.outcome === "applied" && current.revision !== receipt.nonce ? "superseded" : receipt.outcome };
}
