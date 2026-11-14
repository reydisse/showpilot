import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { resolveEffectiveAccess } from "./effective-access";
import { markDatabaseWrite } from "./request-database.server";
import {
  equipmentCommandSchema,
  equipmentOutcomeSchema,
  equipmentStateSchema,
  type EquipmentCommand,
  type EquipmentOutcome,
} from "./equipment-command-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
const receiptSchema = z.object({
  fingerprint: z.string(),
  token: z.uuid(),
  result: equipmentOutcomeSchema,
});
async function authority(
  headers: Headers,
  orgId: string,
  db: Database,
  userId?: string,
) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || (userId && session.user.id !== userId))
    throw new Error("Your account changed. Reopen Assets before continuing.");
  const actor = { userId: session.user.id, sessionId: session.session.id };
  const guard = await memberPermissionGuard(
    db,
    orgId,
    actor,
    userId ? ["assets:view", "assets:manage"] : ["assets:view"],
  );
  return { ...guard, ...actor };
}
export async function readEquipmentState(
  headers: Headers,
  orgId: string,
  db: Database = getD1(),
) {
  const access = await authority(headers, orgId, db);
  const permissions = await resolveEffectiveAccess(db, access.userId, orgId);
  const rows = await db
    .prepare(
      `SELECT id,name,category,status,location,serialNumber,notes,revision FROM equipment WHERE orgId=? AND ${access.guard} ORDER BY name,id`,
    )
    .bind(orgId, ...access.guardArgs)
    .all();
  // An empty inventory must never conceal an authorization change during the read.
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${access.guard}`)
      .bind(...access.guardArgs)
      .first())
  )
    throw new Error("Asset access changed. Reopen Assets.");
  return equipmentStateSchema.parse({
    orgId,
    userId: access.userId,
    serverTime: Date.now(),
    equipment: rows.results,
    canManage: permissions?.permissions.includes("assets:manage") ?? false,
  });
}

/** A receipt and its equipment changes commit together. Reusing a request recovers
 * its original outcome; it never applies that change to a newer inventory state. */
export async function writeEquipmentCommand(
  headers: Headers,
  input: EquipmentCommand,
  mode: "write" | "review",
  db: Database = getD1(),
): Promise<EquipmentOutcome> {
  const command = equipmentCommandSchema.parse(input),
    { orgId, userId, requestId, operation: op } = command;
  const access = await authority(headers, orgId, db, userId);
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(command)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = `equipment-command:${requestId}`;
  const readReceipt = async () => {
    const row = await db
      .prepare(
        `SELECT value FROM app_setting WHERE orgId=? AND key=? AND ${access.guard}`,
      )
      .bind(orgId, key, ...access.guardArgs)
      .first<{ value: string }>();
    if (!row) return null;
    const receipt = receiptSchema.parse(JSON.parse(row.value));
    if (receipt.fingerprint !== fingerprint)
      throw new Error(
        "This request belongs to a different asset change. Reopen Assets.",
      );
    return receipt.result;
  };
  const prior = await readReceipt();
  if (prior) return prior;
  const token = crypto.randomUUID(),
    ids =
      op.kind === "create"
        ? Array.from({ length: op.quantity }, () => crypto.randomUUID())
        : [op.id];
  const result = (outcome: EquipmentOutcome["outcome"]) =>
    JSON.stringify({
      fingerprint,
      token,
      result: { requestId, outcome, ids: outcome === "applied" ? ids : [] },
    });
  const expiry = new Date(command.expiresAt).toISOString();
  const condition =
    op.kind === "create"
      ? "1"
      : "EXISTS(SELECT 1 FROM equipment WHERE orgId=? AND id=? AND revision=?)";
  const conditionArgs =
    op.kind === "create" ? [] : [orgId, op.id, op.expectedRevision];
  const claim = `EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND json_extract(value,'$.token')=? AND json_extract(value,'$.result.outcome')='applied')`;
  const claimArgs = [orgId, key, token];
  const statements = [
    db
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value)
    SELECT ?,?,?,CASE WHEN ?='review' THEN ?
      WHEN julianday(?)<=julianday('now') OR julianday(?)>julianday('now','+30 seconds') THEN ?
      WHEN ${condition} THEN ? ELSE ? END
    WHERE ${access.guard} ON CONFLICT(orgId,key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        key,
        mode,
        result("cancelled"),
        expiry,
        expiry,
        result("expired"),
        ...conditionArgs,
        result("applied"),
        result("conflict"),
        ...access.guardArgs,
      ),
  ];
  if (op.kind === "create") {
    const f = op.fields;
    for (const id of ids)
      statements.push(
        db
          .prepare(
            `INSERT INTO equipment(id,orgId,name,category,status,location,serialNumber,notes,revision,createdAt,updatedAt)
      SELECT ?,?,?,?,?,?,?,?,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP WHERE ${claim}`,
          )
          .bind(
            id,
            orgId,
            f.name,
            f.category,
            f.status,
            f.location,
            op.quantity === 1 ? f.serialNumber : "",
            f.notes,
            ...claimArgs,
          ),
      );
  } else if (op.kind === "update") {
    const fields = [
      "name",
      "category",
      "status",
      "location",
      "serialNumber",
      "notes",
    ] as const;
    const changed = fields.flatMap((field) => {
      const value = op.updates[field];
      return value === undefined ? [] : [{ field, value }];
    });
    statements.push(
      db
        .prepare(
          `UPDATE equipment SET ${changed.map(({ field }) => `${field}=?`).join(",")},revision=revision+1,updatedAt=CURRENT_TIMESTAMP WHERE orgId=? AND id=? AND revision=? AND ${claim}`,
        )
        .bind(
          ...changed.map(({ value }) => value),
          orgId,
          op.id,
          op.expectedRevision,
          ...claimArgs,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `DELETE FROM equipment WHERE orgId=? AND id=? AND revision=? AND ${claim}`,
        )
        .bind(orgId, op.id, op.expectedRevision, ...claimArgs),
    );
  }
  markDatabaseWrite();
  await db.batch(statements);
  const saved = await readReceipt();
  if (!saved)
    throw new Error(
      "Asset change was not confirmed. Retry the original request.",
    );
  return saved;
}
