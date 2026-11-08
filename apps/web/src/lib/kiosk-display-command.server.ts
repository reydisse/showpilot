import { z } from "zod";
import { getD1 } from "./d1";
import { hasPermission } from "./app-permissions";
import {
  interpretBlankedValue,
  kioskDisplayCommandSchema,
  kioskDisplaySnapshotSchema,
  type KioskDisplayCommand,
  type KioskDisplayResult,
} from "./kiosk-display-contract";
export type KioskDisplayDatabase = Pick<D1Database, "prepare" | "batch">;
type Actor = { userId: string; sessionId: string };
const activeSession = `(CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000`;
const notDeleting = `NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=m.organizationId AND key='organization-deleting')`;
type ControlSurface = "settings" | "technical";
async function authority(
  database: KioskDisplayDatabase,
  orgId: string,
  actor: Actor,
  surface: ControlSurface,
) {
  const member = await database
    .prepare(
      `SELECT m.id,m.role,m.managementRevision FROM member m JOIN session s ON s.userId=m.userId
    WHERE m.organizationId=? AND m.userId=? AND s.id=? AND ${activeSession} AND ${notDeleting}`,
    )
    .bind(orgId, actor.userId, actor.sessionId)
    .first<{ id: string; role: string; managementRevision: number }>();
  if (!member)
    throw new Error(
      "Your session or permission to control kiosk displays is no longer active.",
    );
  const guard = [
    `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=? AND ${activeSession} AND ${notDeleting})`,
  ];
  const guardArgs: (string | number | null)[] = [
    orgId,
    member.id,
    actor.userId,
    member.role,
    member.managementRevision,
    actor.sessionId,
  ];
  const required =
    surface === "technical" ? "dashboard:tm" : "settings:members";
  if (!hasPermission(member.role, required)) {
    // Settings retains its permanent management permission. The technical
    // dashboard also supports the existing temporary device-operator grant.
    if (surface !== "technical")
      throw new Error(
        "Your session or permission to control kiosk displays is no longer active.",
      );
    const timezone =
      (
        await database
          .prepare(
            "SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'",
          )
          .bind(orgId)
          .first<{ value: string }>()
      )?.value ?? "";
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const now = Date.now(),
      today = formatter.format(new Date(now));
    const grant = `EXISTS(SELECT 1 FROM member_permission_grant g WHERE g.orgId=? AND g.userId=? AND g.revokedAt IS NULL AND g.startsOn<=? AND (g.expiresOn IS NULL OR g.expiresOn>?) AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(g.permissions) AND json_type(g.permissions)='array' THEN g.permissions ELSE '[]' END) p WHERE p.value='dashboard:tm'))`;
    const grantArgs = [orgId, actor.userId, today, today];
    if (
      !(await database
        .prepare(`SELECT 1 WHERE ${grant}`)
        .bind(...grantArgs)
        .first())
    )
      throw new Error(
        "Your session or permission to control kiosk displays is no longer active.",
      );
    // SQLite cannot evaluate IANA timezones. Bound the reviewed local date at
    // its actual next transition, including shortened/extended DST days.
    let low = now,
      high = now + 48 * 60 * 60 * 1000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (formatter.format(new Date(middle)) === today) low = middle;
      else high = middle;
    }
    guard.push(
      grant,
      "COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'),'')=?",
      "julianday('now')<julianday(?)",
    );
    guardArgs.push(...grantArgs, orgId, timezone, new Date(high).toISOString());
  }
  return { guard: guard.join(" AND "), guardArgs };
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
