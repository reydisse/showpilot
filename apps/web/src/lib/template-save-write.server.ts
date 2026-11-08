import { z } from "zod";
import {
  templateSaveCommandSchema,
  type TemplateSaveCommand,
  type TemplateSaveResult,
} from "./template-save-contract";
import { rundownDetailsAuthority } from "./rundown-details-authority.server";
import { savedRundownIdentity } from "./saved-rundown-create.server";
import { SAVED_RUNDOWN_REMOVED_RECEIPT } from "./saved-rundown-delete.server";
const receiptSchema = z.object({
  actorId: z.string(),
  showId: z.string(),
  fingerprint: z.string(),
  outcome: z.enum(["applied", "cancelled", "conflict", "removed"]),
});
export class TemplateSaveRequestError extends Error {}

/** The request receipt, legacy-client fence and saved copy commit atomically.
 * Review claims an undelivered request without creating its template. */
export async function writeTemplateSave(
  db: Pick<D1Database, "prepare" | "batch">,
  input: TemplateSaveCommand,
  actor: { sessionId: string; pin: string | null },
  mode: "save" | "review",
  beforeCommit: () => Promise<void> = async () => {},
): Promise<TemplateSaveResult> {
  const command = templateSaveCommandSchema.parse(input);
  const { orgId, userId, showId, requestId } = command;
  const access = await rundownDetailsAuthority(
    db,
    orgId,
    { userId, sessionId: actor.sessionId },
    actor.pin,
  );
  const { canonical, digest } = await savedRundownIdentity({
    id: requestId,
    name: command.name,
    serviceName: command.serviceName,
    scheduledStartTime: command.scheduledStartTime,
    items: command.items,
  });
  const fingerprint = JSON.stringify([showId, digest]);
  const key = `rundown-saved:${requestId}`,
    legacyKey = `rundown-template-save:${requestId}`;
  const read = `SELECT actorId,showId,fingerprint,outcome FROM template_save_request WHERE orgId=? AND requestId=? AND ${access.guard}`;
  const args = [orgId, requestId, ...access.guardArgs];
  let row: unknown = await db
    .prepare(read)
    .bind(...args)
    .first();
  if (!row) {
    const nonce = crypto.randomUUID(),
      now = new Date().toISOString();
    const owns =
      "EXISTS(SELECT 1 FROM template_save_request WHERE orgId=? AND requestId=? AND nonce=? AND outcome=?)";
    await beforeCommit();
    await db.batch([
      db
        .prepare(
          `INSERT INTO template_save_request(orgId,requestId,actorId,showId,fingerprint,nonce,outcome)
        SELECT ?,?,?,?,?,?,CASE
          WHEN EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND value=?) THEN 'removed'
          WHEN EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key IN (?,?)) THEN 'conflict'
          WHEN NOT EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=?)
            OR EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=?) THEN 'removed'
          ELSE ? END WHERE ${access.guard}
        ON CONFLICT(orgId,requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          requestId,
          userId,
          showId,
          fingerprint,
          nonce,
          orgId,
          legacyKey,
          SAVED_RUNDOWN_REMOVED_RECEIPT,
          orgId,
          key,
          legacyKey,
          orgId,
          showId,
          orgId,
          `show-deleting:${showId}`,
          mode === "review" ? "cancelled" : "applied",
          ...access.guardArgs,
        ),
      db
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${owns}
        ON CONFLICT(orgId,key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          legacyKey,
          digest,
          orgId,
          requestId,
          nonce,
          "applied",
        ),
      db
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${owns}
        ON CONFLICT(orgId,key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          legacyKey,
          SAVED_RUNDOWN_REMOVED_RECEIPT,
          orgId,
          requestId,
          nonce,
          "cancelled",
        ),
      db
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${owns}
        ON CONFLICT(orgId,key) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          legacyKey,
          SAVED_RUNDOWN_REMOVED_RECEIPT,
          orgId,
          requestId,
          nonce,
          "removed",
        ),
      ...(mode === "save"
        ? [
            db
              .prepare(
                `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${owns}
        ON CONFLICT(orgId,key) DO NOTHING`,
              )
              .bind(
                crypto.randomUUID(),
                orgId,
                key,
                JSON.stringify({
                  ...canonical,
                  createdAt: now,
                  updatedAt: now,
                }),
                orgId,
                requestId,
                nonce,
                "applied",
              ),
          ]
        : []),
    ]);
    row = await db
      .prepare(read)
      .bind(...args)
      .first();
  }
  if (!row)
    throw new TemplateSaveRequestError(
      "Your session or rundown editing permission changed. Review the original save after signing in again.",
    );
  const receipt = receiptSchema.parse(row);
  if (
    receipt.actorId !== userId ||
    receipt.showId !== showId ||
    receipt.fingerprint !== fingerprint
  )
    throw new TemplateSaveRequestError(
      "This request belongs to another template save. Reopen the original draft.",
    );
  let outcome = receipt.outcome;
  if (
    outcome === "applied" &&
    !(await db
      .prepare(
        `SELECT id FROM app_setting WHERE orgId=? AND key=? AND ${access.guard}`,
      )
      .bind(orgId, key, ...access.guardArgs)
      .first())
  )
    outcome = "removed";
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${access.guard}`)
      .bind(...access.guardArgs)
      .first())
  )
    throw new TemplateSaveRequestError(
      "Your rundown editing permission changed. Review the original save after signing in again.",
    );
  return { orgId, userId, showId, requestId, outcome };
}
