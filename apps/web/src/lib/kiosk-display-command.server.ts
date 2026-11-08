import { z } from "zod";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import {
  interpretBlankedValue,
  kioskDisplayCommandSchema,
  kioskDisplaySnapshotSchema,
  type KioskDisplayCommand,
  type KioskDisplayResult,
} from "./kiosk-display-contract";
export type KioskDisplayDatabase = Pick<D1Database, "prepare" | "batch">;
type Actor = { userId: string; sessionId: string };
type ControlSurface = "settings" | "technical";
async function authority(
  database: KioskDisplayDatabase,
  orgId: string,
  actor: Actor,
  surface: ControlSurface,
) {
  return memberPermissionGuard(
    database,
    orgId,
    actor,
    [surface === "technical" ? "dashboard:tm" : "settings:members"],
    surface === "technical",
  );
}
export async function readKioskDisplaySnapshot(
  orgId: string,
  database: KioskDisplayDatabase = getD1(),
) {
  const row = await database
    .prepare(
      `SELECT
    (SELECT value FROM app_setting WHERE orgId=? AND key='kiosk_blanked') AS blanked,
    (SELECT value FROM app_setting WHERE orgId=? AND key='kiosk-blank-revision') AS revision`,
    )
    .bind(orgId, orgId)
    .first<{ blanked: string | null; revision: string | null }>();
  if (!row || ![null, "true", "false"].includes(row.blanked))
    throw new Error("The saved kiosk display command could not be read.");
  return kioskDisplaySnapshotSchema.parse({
    blanked: row.blanked === "true",
    revision: row.revision,
  });
}
export async function readMemberKioskDisplay(
  orgId: string,
  actor: Actor,
  surface: ControlSurface = "settings",
) {
  await authority(getD1(), orgId, actor, surface);
  return readKioskDisplaySnapshot(orgId);
}
/** Companion keeps the existing boolean contract while advancing the reviewed revision. */
export async function setKioskBlanked(orgId: string, blanked: boolean) {
  const database = getD1();
  await database.batch([
    database
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'kiosk_blanked',?)
      ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
      )
      .bind(crypto.randomUUID(), orgId, String(blanked)),
    database
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'kiosk-blank-revision',?)
      ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
      )
      .bind(crypto.randomUUID(), orgId, crypto.randomUUID()),
  ]);
}
const receiptSchema = z.object({
  fingerprint: z.string(),
  revision: z.uuid(),
  outcome: z.enum(["applied", "conflict"]),
});
/** Receipt, desired state and revision commit together; replays only observe. */
export async function writeKioskDisplay({
  command: input,
  actor,
  database = getD1(),
  surface = "settings",
}: {
  command: KioskDisplayCommand;
  actor: Actor;
  database?: KioskDisplayDatabase;
  surface?: ControlSurface;
}): Promise<KioskDisplayResult> {
  const command = kioskDisplayCommandSchema.parse(input);
  const { guard, guardArgs } = await authority(
    database,
    command.orgId,
    actor,
    surface,
  );
  const key = `kiosk-display-command:${actor.userId}:${command.requestId}`;
  const fingerprint = JSON.stringify([
    command.blanked,
    command.expectedRevision,
  ]);
  const revision = crypto.randomUUID();
  const owns = `EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND json_extract(value,'$.revision')=? AND json_extract(value,'$.outcome')='applied')`;
  await database.batch([
    database
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,?,json_object('fingerprint',?,'revision',?,'outcome',CASE WHEN
        (SELECT value FROM app_setting WHERE orgId=? AND key='kiosk-blank-revision') IS ? THEN 'applied' ELSE 'conflict' END)
      WHERE ${guard} ON CONFLICT(orgId,key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        command.orgId,
        key,
        fingerprint,
        revision,
        command.orgId,
        command.expectedRevision,
        ...guardArgs,
      ),
    database
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,'kiosk_blanked',? WHERE ${owns} ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
      )
      .bind(
        crypto.randomUUID(),
        command.orgId,
        String(command.blanked),
        command.orgId,
        key,
        revision,
      ),
    database
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,'kiosk-blank-revision',? WHERE ${owns} ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
      )
      .bind(
        crypto.randomUUID(),
        command.orgId,
        revision,
        command.orgId,
        key,
        revision,
      ),
  ]);
  const stored = await database
    .prepare(
      `SELECT value FROM app_setting WHERE orgId=? AND key=? AND ${guard}`,
    )
    .bind(command.orgId, key, ...guardArgs)
    .first<{ value: string }>();
  if (!stored)
    throw new Error(
      "Your access changed before the display command was confirmed. Review access and retry.",
    );
  const receipt = receiptSchema.parse(JSON.parse(stored.value));
  if (receipt.fingerprint !== fingerprint)
    throw new Error(
      "This request already refers to a different kiosk display command.",
    );
  const snapshot = await readKioskDisplaySnapshot(command.orgId, database);
  return {
    requestId: command.requestId,
    outcome:
      receipt.outcome === "conflict"
        ? "conflict"
        : snapshot.revision === receipt.revision
          ? "applied"
          : "superseded",
    snapshot,
  };
}

export async function getKioskBlanked(orgId: string): Promise<boolean> {
  const row = await getD1()
    .prepare(
      "SELECT value FROM app_setting WHERE orgId=? AND key='kiosk_blanked'",
    )
    .bind(orgId)
    .first<{ value: string }>();
  return interpretBlankedValue(row?.value);
}
