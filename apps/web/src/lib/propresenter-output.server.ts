import { z } from "zod";
import {
  proPresenterOutputCommandSchema,
  proPresenterOutputSnapshotSchema,
  type ProPresenterOutputCommand,
  type ProPresenterOutputResult,
} from "@showpilot/shared/propresenter-output";
import { resolveEffectiveAccess } from "./effective-access";
import { memberPermissionGuard } from "./member-permission-guard.server";
import {
  resolveRundownAccess,
  RUNDOWN_PIN_SETTING_KEY,
} from "./rundown-pin.server";
import type { LiveRundownAuthorityClaim } from "./live-rundown-authority.server";
import type { Permission } from "./permissions";

interface OutputStatement {
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface ProPresenterOutputDatabase {
  prepare(sql: string): { bind(...values: unknown[]): OutputStatement };
  batch(statements: OutputStatement[]): Promise<unknown>;
}
export type ProPresenterOutputSurface = "rundown" | "settings";
export class ProPresenterOutputAccessError extends Error {
  constructor(public readonly code: "pin_required" | "forbidden") {
    super(code === "pin_required"
      ? "Unlock the rundown before changing output."
      : "Your output-control permission is no longer active.");
    this.name = "ProPresenterOutputAccessError";
  }
}
export const PRO_PRESENTER_OUTPUT_KEY = "propresenter-stage-display";
export const PRO_PRESENTER_OUTPUT_REVISION_KEY = "propresenter-output-revision";
const nowSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";

/** Workspace-wide revision: show room revisions cannot protect a shared output. */
export async function readProPresenterOutputSnapshot(
  database: ProPresenterOutputDatabase,
  orgId: string,
) {
  const row = await database
    .prepare(
      `SELECT
    (SELECT value FROM app_setting WHERE orgId=? AND key=?) AS enabled,
    (SELECT value FROM app_setting WHERE orgId=? AND key=?) AS revision`,
    )
    .bind(
      orgId,
      PRO_PRESENTER_OUTPUT_KEY,
      orgId,
      PRO_PRESENTER_OUTPUT_REVISION_KEY,
    )
    .first<{ enabled: string | null; revision: string | null }>();
  if (!row || ![null, "true", "false"].includes(row.enabled))
    throw new Error("The saved ProPresenter output state could not be read.");
  return proPresenterOutputSnapshotSchema.parse({
    enabled: row.enabled === "true",
    revision: row.revision,
    serverTime: Date.now(),
  });
}
async function authority(
  database: ProPresenterOutputDatabase,
  actor: LiveRundownAuthorityClaim,
  surface: ProPresenterOutputSurface,
) {
  const access = await resolveEffectiveAccess(
    database,
    actor.userId,
    actor.orgId,
  );
  if (!access) throw new ProPresenterOutputAccessError("forbidden");
  const pin =
    (
      await database
        .prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?")
        .bind(actor.orgId, RUNDOWN_PIN_SETTING_KEY)
        .first<{ value: string }>()
    )?.value ?? null;
  let required: Permission[];
  if (surface === "settings") required = ["settings:integrations"];
  else {
    const rundown = await resolveRundownAccess(
      database,
      actor.orgId,
      access,
      actor.rundownPin,
    );
    const permission = (["rundown:edit", "rundown:control"] as const).find(
      (value) => rundown.permissions.includes(value),
    );
    if (!permission)
      throw new ProPresenterOutputAccessError(
        rundown.pin === "locked" ? "pin_required" : "forbidden",
      );
    // An unlocked PIN can supply a TM's permission; the role/session and exact
    // PIN configuration are still guarded in the committing transaction.
    required = access.permissions.includes(permission) ? [permission] : [];
  }
  const result = await memberPermissionGuard(
    database,
    actor.orgId,
    actor,
    required,
    surface === "rundown",
  );
  if (surface === "rundown") {
    result.guard +=
      " AND (SELECT value FROM app_setting WHERE orgId=? AND key=?) IS ?";
    result.guardArgs.push(actor.orgId, RUNDOWN_PIN_SETTING_KEY, pin);
  }
  return result;
}
export async function readMemberProPresenterOutput(
  database: ProPresenterOutputDatabase,
  actor: LiveRundownAuthorityClaim,
  surface: ProPresenterOutputSurface = "rundown",
) {
  await authority(database, actor, surface);
  return readProPresenterOutputSnapshot(database, actor.orgId);
}
const receiptSchema = z.object({
  fingerprint: z.string(),
  revision: z.uuid(),
  outcome: z.enum(["applied", "conflict", "expired"]),
});
/** Claim, desired value and revision commit in one D1 transaction. Replays only
 * read the original receipt and cannot overwrite a later output change. */
export async function writeProPresenterOutput(
  database: ProPresenterOutputDatabase,
  input: ProPresenterOutputCommand,
  actor: LiveRundownAuthorityClaim,
  surface: ProPresenterOutputSurface = "rundown",
): Promise<ProPresenterOutputResult> {
  const command = proPresenterOutputCommandSchema.parse(input);
  if (command.orgId !== actor.orgId || command.userId !== actor.userId)
    throw new Error(
      "Return to the account and workspace that started this output change.",
    );
  const { guard, guardArgs } = await authority(database, actor, surface);
  const key = `pp-output-command:${actor.userId}:${command.requestId}`;
  const fingerprint = JSON.stringify(command);
  const readReceipt = async () => {
    const row = await database
      .prepare(
        `SELECT value FROM app_setting WHERE orgId=? AND key=? AND ${guard}`,
      )
      .bind(command.orgId, key, ...guardArgs)
      .first<{ value: string }>();
    if (!row) return null;
    const receipt = receiptSchema.parse(JSON.parse(row.value));
    if (receipt.fingerprint !== fingerprint)
      throw new Error("This request belongs to a different output change.");
    return receipt;
  };
  let receipt = await readReceipt();
  if (!receipt) {
    const revision = crypto.randomUUID();
    const owns =
      "EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND json_extract(value,'$.revision')=? AND json_extract(value,'$.outcome')='applied')";
    await database.batch([
      database
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value)
        SELECT ?,?,?,json_object('fingerprint',?,'revision',?,'outcome',CASE
          WHEN ?<=${nowSql} OR ?>${nowSql}+10000 THEN 'expired'
          WHEN (SELECT value FROM app_setting WHERE orgId=? AND key=?) IS ? THEN 'applied'
          ELSE 'conflict' END) WHERE ${guard} ON CONFLICT(orgId,key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          command.orgId,
          key,
          fingerprint,
          revision,
          command.expiresAt,
          command.expiresAt,
          command.orgId,
          PRO_PRESENTER_OUTPUT_REVISION_KEY,
          command.expectedRevision,
          ...guardArgs,
        ),
      database
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${owns}
        ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
        )
        .bind(
          crypto.randomUUID(),
          command.orgId,
          PRO_PRESENTER_OUTPUT_KEY,
          String(command.enabled),
          command.orgId,
          key,
          revision,
        ),
      database
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${owns}
        ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
        )
        .bind(
          crypto.randomUUID(),
          command.orgId,
          PRO_PRESENTER_OUTPUT_REVISION_KEY,
          revision,
          command.orgId,
          key,
          revision,
        ),
    ]);
    receipt = await readReceipt();
  }
  if (!receipt)
    throw new Error(
      "Your access changed before the output command was confirmed. Check access and retry the same command.",
    );
  const snapshot = await readProPresenterOutputSnapshot(database, actor.orgId);
  return {
    ...command,
    snapshot,
    outcome:
      receipt.outcome === "applied" &&
      (receipt.revision !== snapshot.revision ||
        command.enabled !== snapshot.enabled)
        ? "superseded"
        : receipt.outcome,
  };
}
