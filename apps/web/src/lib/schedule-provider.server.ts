import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import {
  scheduleProviderSnapshotSchema,
  type ScheduleProviderCommand,
  type ScheduleProviderResult,
} from "./schedule-provider-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
async function authority(headers: Headers, orgId: string, db: Database) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new Error("Sign in before changing the scheduling source.");
  const actor = { userId: session.user.id, sessionId: session.session.id };
  return {
    ...actor,
    ...(await memberPermissionGuard(db, orgId, actor, ["schedule:manage"])),
  };
}
const snapshotSql = `SELECT
  COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='schedule-provider'),'native') AS provider,
  COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='schedule-provider-url'),'') AS url,
  COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='schedule-provider-label'),'') AS label,
  (SELECT value FROM app_setting WHERE orgId=? AND key='schedule-provider-revision') AS revision`;
function snapshot(row: unknown, orgId: string, userId: string) {
  const stored = z
    .object({
      provider: z.string(),
      url: z.string(),
      label: z.string(),
      revision: z.string().nullable(),
    })
    .parse(row);
  return scheduleProviderSnapshotSchema.parse({
    orgId,
    userId,
    revision: stored.revision,
    config: {
      provider: stored.provider,
      url: stored.provider === "native" ? "" : stored.url,
      label: stored.provider === "other" ? stored.label : "",
    },
  });
}
const denied = () =>
  new Error(
    "Your account or scheduling permission changed. Reopen the schedule before saving.",
  );
export async function readScheduleProvider(
  headers: Headers,
  orgId: string,
  db: Database = getD1(),
) {
  const actor = await authority(headers, orgId, db);
  const row = await db
    .prepare(`${snapshotSql} WHERE ${actor.guard}`)
    .bind(orgId, orgId, orgId, orgId, ...actor.guardArgs)
    .first();
  if (!row) throw denied();
  return snapshot(row, orgId, actor.userId);
}

/** Receipt, all three fields and the final revision commit in one D1 batch. */
export async function writeScheduleProvider(
  headers: Headers,
  command: ScheduleProviderCommand,
  db: Database = getD1(),
): Promise<ScheduleProviderResult> {
  const actor = await authority(headers, command.orgId, db);
  if (actor.userId !== command.userId) throw denied();
  const { orgId, config, requestId, expectedRevision } = command;
  const receiptKey = `schedule-provider-write:${actor.userId}:${requestId}`;
  const fingerprint = JSON.stringify([
    expectedRevision,
    config.provider,
    config.url,
    config.label,
  ]);
  const revision = crypto.randomUUID();
  const owns = `EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND json_extract(value,'$.revision')=? AND json_extract(value,'$.outcome')='applied')`;
  const entries = [
    ["schedule-provider", config.provider],
    ["schedule-provider-url", config.url],
    ["schedule-provider-label", config.label],
    ["schedule-provider-revision", revision],
  ];
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,?,json_object('fingerprint',?,'revision',?,'outcome',CASE WHEN
        (SELECT value FROM app_setting WHERE orgId=? AND key='schedule-provider-revision') IS ?
        THEN 'applied' ELSE 'conflict' END)
      WHERE ${actor.guard} ON CONFLICT(orgId,key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        receiptKey,
        fingerprint,
        revision,
        orgId,
        expectedRevision,
        ...actor.guardArgs,
      ),
    ...entries.map(([key, value]) =>
      db
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,?,? WHERE ${owns} ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          key,
          value,
          orgId,
          receiptKey,
          revision,
        ),
    ),
    db
      .prepare(
        `SELECT value FROM app_setting WHERE orgId=? AND key=? AND ${actor.guard}`,
      )
      .bind(orgId, receiptKey, ...actor.guardArgs),
    db
      .prepare(`${snapshotSql} WHERE ${actor.guard}`)
      .bind(orgId, orgId, orgId, orgId, ...actor.guardArgs),
  ]);
  const receiptRow = result[5].results[0],
    stateRow = result[6].results[0];
  if (!receiptRow || !stateRow) throw denied();
  const receipt = z
    .object({
      fingerprint: z.string(),
      revision: z.string(),
      outcome: z.enum(["applied", "conflict"]),
    })
    .parse(JSON.parse(z.object({ value: z.string() }).parse(receiptRow).value));
  if (receipt.fingerprint !== fingerprint)
    throw new Error(
      "This request belongs to a different scheduling source change.",
    );
  markDatabaseWrite();
  const current = snapshot(stateRow, orgId, actor.userId);
  return {
    requestId,
    outcome:
      receipt.outcome === "conflict"
        ? "conflict"
        : current.revision === receipt.revision
          ? "applied"
          : "superseded",
    snapshot: current,
  };
}
