import { env } from "cloudflare:workers";
import { z } from "zod";
import { destinationControlCommandSchema, destinationControlSnapshotSchema, type DestinationControlScope, type DestinationControlCommand, type DestinationControlResult } from "@showpilot/shared/destination-control";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { resolveEffectiveAccess, accessHasAnyPermission } from "./effective-access";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import { getOutputStatusesForOrg } from "./stream-destinations";
import { saveStreamDestinationForOrg } from "./stream-destination-write.server";
import { runStreamOutputCommand } from "./stream-output-command.server";

export class DestinationControlAccessError extends Error {}
const denied = () => new DestinationControlAccessError("Your account or streaming permission changed. Reopen destinations.");
async function authority(headers: Headers, scope: DestinationControlScope, write = false) {
  const session = await getAuth().api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session || session.user.id !== scope.userId) throw denied();
  const db = getD1(), effective = await resolveEffectiveAccess(db, scope.userId, scope.orgId);
  if (!effective) throw denied();
  const allowed = (["stream_health:view", "stream_health:manage", "streaming_suite:access"] as const).filter(p => accessHasAnyPermission(effective, [p]));
  const permission = write ? "stream_health:manage" : allowed[0];
  if (!permission || !allowed.includes(permission)) throw denied();
  const guard = await memberPermissionGuard(db, scope.orgId, { userId: scope.userId, sessionId: session.session.id }, [permission])
    .catch(error => { if (error instanceof Error && error.message === "Your session or required permission is no longer active.") throw denied(); throw error; });
  return { ...guard, canManage: allowed.includes("stream_health:manage") };
}
export async function readDestinationControl(headers: Headers, scope: DestinationControlScope) {
  const access = await authority(headers, scope), db = getD1();
  const result = await db.batch([
    db.prepare(`SELECT 1 WHERE ${access.guard}`).bind(...access.guardArgs),
    db.prepare(`SELECT d.id,d.name,d.platform,d.rtmpUrl,d.enabled AS selected,d.cfOutputId,d.liveInputId,
      CASE WHEN d.streamKey='' THEN 0 ELSE 1 END AS hasStreamKey,COALESCE(r.revision,0) AS revision
      FROM stream_destination d LEFT JOIN destination_control_revision r ON r.orgId=d.orgId AND r.destinationId=d.id
      WHERE d.orgId=? AND ${access.guard} ORDER BY d.createdAt,d.id`).bind(scope.orgId, ...access.guardArgs),
  ]);
  if (!result[0].results.length) throw denied();
  const rows = z.array(z.object({ id: z.string(), name: z.string(), platform: z.string(), rtmpUrl: z.string(), selected: z.number(), hasStreamKey: z.number(), revision: z.number(), cfOutputId: z.string(), liveInputId: z.string() })).parse(result[1].results);
  const statuses = await getOutputStatusesForOrg(scope.orgId, rows.filter(row => row.cfOutputId));
  // A provider read may take seconds; don't attach its answer to changed metadata.
  const confirmed = await db.batch([
    db.prepare(`SELECT 1 WHERE ${access.guard}`).bind(...access.guardArgs),
    db.prepare("SELECT destinationId,revision FROM destination_control_revision WHERE orgId=?").bind(scope.orgId),
  ]);
  if (!confirmed[0].results.length) throw denied();
  const revisions = z.array(z.object({ destinationId: z.string(), revision: z.number() })).parse(confirmed[1].results);
  return destinationControlSnapshotSchema.parse({ ...scope, serverTime: Date.now(), canManage: access.canManage,
    destinations: rows.map(row => ({ ...row, selected: Boolean(row.selected), hasStreamKey: Boolean(row.hasStreamKey),
      ...(revisions.some(current => current.destinationId === row.id && current.revision === row.revision)
        ? row.cfOutputId ? statuses[row.id] ?? { status: "unknown", error: "Output status was not confirmed." } : { status: "none" }
        : { status: "unknown", error: "The destination changed while its status was being checked. Refresh to review it." }),
    })),
  });
}
async function fingerprint(command: DestinationControlCommand) {
  if (!env.BETTER_AUTH_SECRET) throw new Error("Destination retry confirmation is unavailable.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(["native-destination-control-v1", command])));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
const receiptSchema = z.object({
  fingerprint: z.string(), outcome: z.enum(["pending", "applied", "conflict", "cancelled", "expired", "superseded"]),
  destinationId: z.string(), savedId: z.string().nullable(), outputCommandId: z.string().nullable(), completed: z.string().nullable(), currentCommandId: z.string().nullable(),
});
/** Admission and both existing mutation engines share a transaction predicate.
 * Review can fence an unsent request without pretending an admitted provider call stopped. */
export async function writeDestinationControl(headers: Headers, input: DestinationControlCommand, mode: "save" | "review"): Promise<DestinationControlResult> {
  const command = destinationControlCommandSchema.parse(input), { orgId, userId, requestId, operation } = command;
  const access = await authority(headers, command, mode === "save"), db = getD1();
  const key = [orgId, userId, requestId], hash = await fingerprint(command);
  const output = operation.kind !== "create" && operation.kind !== "update";
  const expiresAt = output ? operation.expiresAt : null;
  const readReceipt = async () => {
    const row = await db.prepare(`SELECT r.fingerprint,r.outcome,r.destinationId,w.destinationId AS savedId,c.id AS outputCommandId,c.completed,i.commandId AS currentCommandId
      FROM destination_control_request r
      LEFT JOIN stream_destination_write_receipt w ON w.orgId=r.orgId AND w.actorId=r.actorId AND w.requestId=r.requestId
      LEFT JOIN stream_output_command c ON c.orgId=r.orgId AND c.actorId=r.actorId AND c.requestId=r.requestId
      LEFT JOIN stream_output_intent i ON i.orgId=r.orgId AND i.destinationId=r.destinationId
      WHERE r.orgId=? AND r.actorId=? AND r.requestId=?`).bind(...key).first();
    if (!row) return null;
    const receipt = receiptSchema.parse(row);
    if (receipt.fingerprint !== hash) throw new Error("This request belongs to different destination changes. Retry the original request.");
    return receipt;
  };
  const prior = await readReceipt();
  if (!prior && mode === "save" && expiresAt !== null && expiresAt > Date.now() + 5000) throw new Error("Refresh destinations before sending this change.");
  const matches = operation.kind === "create" ? "1" : "EXISTS(SELECT 1 FROM stream_destination d JOIN destination_control_revision r ON r.orgId=d.orgId AND r.destinationId=d.id WHERE d.orgId=? AND d.id=? AND r.revision=?)";
  const revisionArgs = operation.kind === "create" ? [] : [orgId, operation.id, operation.expectedRevision];
  const notCommitted = `NOT EXISTS(SELECT 1 FROM stream_destination_write_receipt w WHERE w.orgId=destination_control_request.orgId AND w.actorId=destination_control_request.actorId AND w.requestId=destination_control_request.requestId)
    AND NOT EXISTS(SELECT 1 FROM stream_output_command c WHERE c.orgId=destination_control_request.orgId AND c.actorId=destination_control_request.actorId AND c.requestId=destination_control_request.requestId)`;
  await db.prepare(`INSERT INTO destination_control_request(orgId,actorId,requestId,fingerprint,destinationId,outcome)
    SELECT ?,?,?,?,?,CASE WHEN ?='review' THEN 'cancelled' WHEN ? IS NOT NULL AND ?<=(julianday('now')-2440587.5)*86400000 THEN 'expired' WHEN ${matches} THEN 'pending' ELSE 'conflict' END
    WHERE ${access.guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`)
    .bind(...key, hash, operation.kind === "create" ? "" : operation.id, mode, expiresAt, expiresAt, ...revisionArgs, ...access.guardArgs).run();
  markDatabaseWrite();
  const finish = async () => {
    // Each condition is re-evaluated in the UPDATE, not from a stale JS read.
    await db.prepare(`UPDATE destination_control_request SET outcome=CASE
      WHEN EXISTS(SELECT 1 FROM stream_destination_write_receipt w WHERE w.orgId=destination_control_request.orgId AND w.actorId=destination_control_request.actorId AND w.requestId=destination_control_request.requestId) THEN 'applied'
      WHEN EXISTS(SELECT 1 FROM stream_output_command c WHERE c.orgId=destination_control_request.orgId AND c.actorId=destination_control_request.actorId AND c.requestId=destination_control_request.requestId AND EXISTS(SELECT 1 FROM json_each(c.completed) done WHERE done.key=destination_control_request.destinationId AND done.value=1)) THEN 'applied'
      WHEN EXISTS(SELECT 1 FROM stream_output_command c WHERE c.orgId=destination_control_request.orgId AND c.actorId=destination_control_request.actorId AND c.requestId=destination_control_request.requestId AND NOT EXISTS(SELECT 1 FROM stream_output_intent i WHERE i.orgId=c.orgId AND i.destinationId=destination_control_request.destinationId AND i.commandId=c.id)) THEN 'superseded'
      WHEN ${notCommitted} THEN CASE WHEN ?='review' THEN 'cancelled' WHEN ? IS NOT NULL AND ?<=(julianday('now')-2440587.5)*86400000 THEN 'expired' WHEN NOT (${matches}) THEN 'conflict' ELSE 'pending' END
      ELSE 'pending' END,
      destinationId=COALESCE((SELECT w.destinationId FROM stream_destination_write_receipt w WHERE w.orgId=destination_control_request.orgId AND w.actorId=destination_control_request.actorId AND w.requestId=destination_control_request.requestId),destinationId)
      WHERE orgId=? AND actorId=? AND requestId=? AND outcome='pending'`)
      .bind(mode, expiresAt, expiresAt, ...revisionArgs, ...key).run();
    const saved = await readReceipt();
    if (!saved) throw denied();
    return saved;
  };
  let saved = await finish();
  if (saved.outcome === "pending" && mode === "save") {
    // A retry of an admitted command uses its original engine receipt. This
    // predicate applies only to the first atomic admission/write.
    const commitGuard = { sql: `(${access.guard}) AND EXISTS(SELECT 1 FROM destination_control_request WHERE orgId=? AND actorId=? AND requestId=? AND outcome='pending') AND (${matches}) AND (? IS NULL OR ?>(julianday('now')-2440587.5)*86400000)`,
      values: [...access.guardArgs, ...key, ...revisionArgs, expiresAt, expiresAt] };
    let message: string | undefined;
    try {
      if (operation.kind === "create") {
        if (!operation.fields.streamKey.trim()) throw new Error("A stream key is required for a new destination.");
        await saveStreamDestinationForOrg({ orgId, actorId: userId, requestId, kind: "create", fields: operation.fields, commitGuard });
      } else if (operation.kind === "update") {
        await saveStreamDestinationForOrg({ orgId, actorId: userId, requestId, kind: "update", id: operation.id, fields: operation.fields, commitGuard });
      } else {
        await runStreamOutputCommand({ orgId, actorId: userId, requestId, destinationId: operation.id, action: operation.kind, commitGuard });
      }
    } catch (error) {
      if (error instanceof Error && ["Disable this destination before changing its RTMP credentials.", "A stream key is required for a new destination."].includes(error.message)) message = error.message;
    }
    saved = await finish();
    if (saved.outcome === "pending") return { orgId, userId, requestId, outcome: "unconfirmed", destinationId: saved.destinationId,
      message: message ?? "The destination change is not confirmed. Retry the original request, or review its current result." };
  }
  return { orgId, userId, requestId, outcome: saved.outcome === "pending" ? "unconfirmed" : saved.outcome, destinationId: saved.destinationId,
    ...(saved.outcome === "pending" ? { message: "This command was admitted but is not confirmed. Retry the original request to reconcile it; review does not stop an in-flight provider call." } : {}) };
}
