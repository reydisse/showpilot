import { BridgeTargetError, parseBridgeEndpoint, resolveBridgeEndpoints, type BridgeEndpoint } from "./bridge-target";

export interface ApprovedBridgeTarget extends BridgeEndpoint {
  id: string;
  label: string;
  approvedByUserId: string;
  approvedAt: number;
}
export type BridgeTargetActor =
  | { source: "operator"; actorUserId: string }
  | { source: "automation"; actorUserId: string | null; executionId: string };

function audit(db: D1Database, orgId: string, actor: BridgeTargetActor, action: "approved" | "removed" | "connection-requested" | "rejected", endpoint: BridgeEndpoint | null, reason: string | null = null) {
  return db.prepare(`INSERT INTO bridge_target_audit (id, orgId, action, actorUserId, source, executionId, host, port, protocol, reason, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), orgId, action, actor.actorUserId, actor.source,
    actor.source === "automation" ? actor.executionId : null,
    endpoint?.host ?? null, endpoint?.port ?? null, endpoint?.protocol ?? null, reason, Date.now(),
  );
}
export async function listBridgeTargets(db: D1Database, orgId: string): Promise<ApprovedBridgeTarget[]> {
  return (await db.prepare(`SELECT id, label, host, port, protocol, approvedByUserId, approvedAt
    FROM bridge_target_allowlist WHERE orgId = ? ORDER BY label, host, port, protocol`).bind(orgId).all<ApprovedBridgeTarget>()).results;
}

/** Call only after settings:api_keys or settings:integrations authorization. */
export async function approveBridgeTarget(db: D1Database, input: { orgId: string; label: string; endpoint: BridgeEndpoint; actorUserId: string }): Promise<void> {
  const endpoint = parseBridgeEndpoint(input.endpoint);
  const label = input.label.trim();
  if (!label || label.length > 80) throw new Error("Enter a destination name of up to 80 characters.");
  await db.batch([
    db.prepare(`INSERT INTO bridge_target_allowlist (id, orgId, label, host, port, protocol, approvedByUserId, approvedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(orgId, host, port, protocol) DO UPDATE SET label = excluded.label, approvedByUserId = excluded.approvedByUserId, approvedAt = excluded.approvedAt`)
      .bind(crypto.randomUUID(), input.orgId, label, endpoint.host, endpoint.port, endpoint.protocol, input.actorUserId, Date.now()),
    audit(db, input.orgId, { source: "operator", actorUserId: input.actorUserId }, "approved", endpoint),
  ]);
}

/** Delete and audit the exact row atomically; another organization's ID is never accepted. */
export async function removeBridgeTarget(db: D1Database, input: { orgId: string; id: string; actorUserId: string }): Promise<void> {
  const results = await db.batch([
    db.prepare(`INSERT INTO bridge_target_audit (id, orgId, action, actorUserId, source, host, port, protocol, createdAt)
      SELECT ?, orgId, 'removed', ?, 'operator', host, port, protocol, ? FROM bridge_target_allowlist WHERE orgId = ? AND id = ?`)
      .bind(crypto.randomUUID(), input.actorUserId, Date.now(), input.orgId, input.id),
    db.prepare("DELETE FROM bridge_target_allowlist WHERE orgId = ? AND id = ?").bind(input.orgId, input.id),
  ]);
  if (results[1].meta.changes !== 1) throw new Error("Approved Bridge destination no longer exists. Refresh the list.");
}

/** Resolve and authorize every effective endpoint; denied input never appears in audit payloads. */
export async function authorizeBridgeTarget(db: D1Database, orgId: string, input: unknown, actor: BridgeTargetActor): Promise<BridgeEndpoint[]> {
  let endpoints: BridgeEndpoint[];
  try { endpoints = resolveBridgeEndpoints(input); }
  catch (error) {
    if (!(error instanceof BridgeTargetError)) throw error;
    await audit(db, orgId, actor, "rejected", null, error.code).run();
    throw error;
  }
  if (typeof input === "object" && input !== null && "type" in input && input.type === "connect-device") {
    await db.batch(endpoints.map(endpoint => audit(db, orgId, actor, "connection-requested", endpoint)));
  }
  // One D1 batch gives all destinations the same authorization snapshot.
  const approvals = await db.batch(endpoints.map(endpoint => db.prepare(
    "SELECT id FROM bridge_target_allowlist WHERE orgId = ? AND host = ? AND port = ? AND protocol = ?",
  ).bind(orgId, endpoint.host, endpoint.port, endpoint.protocol)));
  const denied = endpoints.find((_, index) => approvals[index].results.length === 0);
  if (denied) {
    await audit(db, orgId, actor, "rejected", denied, "unapproved-target").run();
    throw new BridgeTargetError("unapproved-target");
  }
  return endpoints;
}
