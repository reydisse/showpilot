import { NEXT_UPDATED_AT_SQL } from "./sqlite-timestamp.server";
import { z } from "zod";
import {
  replacementCommandSchema,
  type ReplacementCommand,
  type ReplacementResult,
} from "./rundown-replacement-contract";
import { rundownDetailsAuthority } from "./rundown-details-authority.server";
import { readShowDetailsSnapshot } from "./show-details-write.server";
import { readStoredRundownItems } from "./rundown-item-storage.server";
import { parseRelayTimer } from "./rundown-relay-payload";
type Database = Pick<D1Database, "prepare" | "batch">;
export class RundownReplacementError extends Error {}
const receiptSchema = z.object({
  actorId: z.string(),
  showId: z.string(),
  fingerprint: z.string(),
  outcome: z.enum(["applied", "cancelled", "conflict", "removed"]),
  revision: z.number().nullable(),
});
export type PendingReplacement = Pick<
  ReplacementCommand,
  "orgId" | "showId" | "requestId"
> & { actorId: string };
export const replacementTimer = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
} as const;

/** Only the serialized show relay calls this writer. The receipt, metadata,
 * stopped timer and replacement rows share one guarded D1 transaction. */
export async function writeRundownReplacement(
  db: Database,
  input: ReplacementCommand,
  actor: { sessionId: string; pin: string | null },
  mode: "save" | "review",
  live: { revision: number; stopped: boolean },
  beforeCommit: () => Promise<void>,
): Promise<ReplacementResult> {
  const command = replacementCommandSchema.parse(input);
  const { orgId, userId, showId, requestId } = command;
  const access = await rundownDetailsAuthority(
    db,
    orgId,
    { userId, sessionId: actor.sessionId },
    actor.pin,
  );
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(command)),
  );
  const fingerprint = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const read = `SELECT actorId,showId,fingerprint,outcome,revision FROM rundown_replacement_request WHERE orgId=? AND requestId=? AND ${access.guard}`;
  const args = [orgId, requestId, ...access.guardArgs];
  let row: unknown = await db
    .prepare(read)
    .bind(...args)
    .first();
  if (!row) {
    const current = await readShowDetailsSnapshot(db, orgId, showId);
    const candidate =
      mode === "save" &&
      live.stopped &&
      live.revision === command.expectedRevision &&
      current?.snapshot.updatedAt === command.expectedUpdatedAt &&
      current.snapshot.serviceDate === command.serviceDate;
    const nonce = crypto.randomUUID();
    const owns =
      "EXISTS(SELECT 1 FROM rundown_replacement_request WHERE orgId=? AND requestId=? AND nonce=? AND outcome='applied')";
    const ownArgs = [orgId, requestId, nonce];
    await beforeCommit();
    const statements = [
      db
        .prepare(
          `INSERT INTO rundown_replacement_request(orgId,requestId,actorId,showId,fingerprint,nonce,outcome,revision)
      SELECT ?,?,?,?,?,?,CASE WHEN ?='review' THEN 'cancelled'
        WHEN NOT EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=?) THEN 'removed'
        WHEN ?=1 AND EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND serviceDate=? AND updatedAt=?
          AND NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=rundown.orgId AND key='show-deleting:'||rundown.id)) THEN 'applied'
        ELSE 'conflict' END,? WHERE ${access.guard} ON CONFLICT(orgId,requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          requestId,
          userId,
          showId,
          fingerprint,
          nonce,
          mode,
          orgId,
          showId,
          candidate ? 1 : 0,
          orgId,
          showId,
          command.serviceDate,
          current?.storedVersion ?? "",
          live.revision + 1,
          ...access.guardArgs,
        ),
    ];
    if (mode === "save") {
      statements.push(
        db
          .prepare(
            `DELETE FROM rundown_item WHERE orgId=? AND showId=? AND ${owns}`,
          )
          .bind(orgId, showId, ...ownArgs),
      );
      command.copy.items.forEach((item, index) =>
        statements.push(
          db
            .prepare(
              `INSERT INTO rundown_item
        (id,orgId,showId,serviceDate,itemId,title,type,duration,notes,assignee,cue,status,sortOrder,hardStop,lowerThirdId,scheduledStart,expectedEnd,actualStart,actualEnd,createdAt,updatedAt)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,'upcoming',?,?,?,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP WHERE ${owns}`,
            )
            .bind(
              crypto.randomUUID(),
              orgId,
              showId,
              command.serviceDate,
              `${requestId}-item-${index}`,
              item.title,
              item.type,
              item.duration,
              item.notes,
              item.assignee,
              item.cue,
              index,
              item.hardStop ? 1 : 0,
              item.lowerThirdId ?? null,
              ...ownArgs,
            ),
        ),
      );
      statements.push(
        db
          .prepare(
            `UPDATE rundown SET name=?,location=?,scheduledStartTime=?,status='stopped',
        updatedAt=${NEXT_UPDATED_AT_SQL}
        WHERE orgId=? AND id=? AND ${owns}`,
          )
          .bind(
            command.copy.serviceName,
            command.copy.location,
            command.copy.scheduledStartTime,
            orgId,
            showId,
            ...ownArgs,
          ),
      );
      for (const [key, value] of [
        [`rundown-timer:${showId}`, JSON.stringify(replacementTimer)],
        [`rundown-items-storage:${showId}`, "rows-v1"],
      ])
        statements.push(
          db
            .prepare(
              `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${owns}
          ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
            )
            .bind(crypto.randomUUID(), orgId, key, value, ...ownArgs),
        );
      statements.push(
        db
          .prepare(
            `DELETE FROM app_setting WHERE orgId=? AND key=? AND ${owns}`,
          )
          .bind(orgId, `rundown-items:${showId}`, ...ownArgs),
      );
      statements.push(
        db
          .prepare(
            `DELETE FROM app_setting WHERE orgId=? AND key=? AND ${owns} AND ?=
        (SELECT id FROM rundown WHERE orgId=? AND serviceDate=? ORDER BY scheduledStartTime ASC,createdAt ASC LIMIT 1)`,
          )
          .bind(
            orgId,
            `rundown-items:${command.serviceDate}`,
            ...ownArgs,
            showId,
            orgId,
            command.serviceDate,
          ),
      );
    }
    await db.batch(statements);
    row = await db
      .prepare(read)
      .bind(...args)
      .first();
  }
  if (!row)
    throw new RundownReplacementError(
      "Your session or rundown editing permission changed. Review the original replacement after signing in again.",
    );
  const receipt = receiptSchema.parse(row);
  if (
    receipt.actorId !== userId ||
    receipt.showId !== showId ||
    receipt.fingerprint !== fingerprint
  )
    throw new RundownReplacementError(
      "This replacement belongs to a different reviewed copy. Reopen the original request.",
    );
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${access.guard}`)
      .bind(...access.guardArgs)
      .first())
  )
    throw new RundownReplacementError(
      "Your rundown editing authority changed. Review the original replacement after signing in again.",
    );
  const exists =
    receipt.outcome !== "applied" ||
    (await db
      .prepare("SELECT id FROM rundown WHERE orgId=? AND id=?")
      .bind(orgId, showId)
      .first());
  return {
    orgId,
    userId,
    showId,
    requestId,
    outcome: exists ? receipt.outcome : "removed",
    revision: receipt.outcome === "applied" ? receipt.revision : null,
  };
}

/** Recover current committed state, never replay the old replacement payload. */
export async function readCommittedReplacement(
  db: Database,
  pending: PendingReplacement,
) {
  const receipt = await db
    .prepare(
      "SELECT outcome,revision FROM rundown_replacement_request WHERE orgId=? AND requestId=? AND showId=? AND actorId=?",
    )
    .bind(pending.orgId, pending.requestId, pending.showId, pending.actorId)
    .first<{ outcome: string; revision: number }>();
  if (receipt?.outcome !== "applied") return null;
  const show = (
    await readShowDetailsSnapshot(db, pending.orgId, pending.showId)
  )?.snapshot;
  if (!show) return null;
  const items = await readStoredRundownItems(db, {
    orgId: pending.orgId,
    showId: pending.showId,
    serviceDate: show.serviceDate,
  });
  const stored = await db
    .prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?")
    .bind(pending.orgId, `rundown-timer:${pending.showId}`)
    .first<{ value: string }>();
  const timer = stored && parseRelayTimer(JSON.parse(stored.value));
  if (!timer)
    throw new RundownReplacementError(
      "The committed rundown timer could not be recovered.",
    );
  return { show, items, timer, revision: receipt.revision };
}
