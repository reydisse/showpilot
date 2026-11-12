import { z } from "zod";
import { getD1 } from "./d1";
import { getAuth } from "./auth";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import {
  deleteShowInputSchema,
  ShowDeletionBlockedError,
  ShowDeletionRejectedError,
  type DeleteShowInput,
} from "./show-deletion-contract";
import {
  showDeletionRelays,
  type ShowDeletionRelays,
  type ShowDeletionTarget,
} from "./show-deletion-relays.server";

type Database = Pick<D1Database, "prepare" | "batch">;
const operationSchema = z.object({
  orgId: z.string(),
  showId: z.string(),
  serviceDate: z.string(),
  nonce: z.string(),
  stage: z.enum(["preparing", "purging", "deleted"]),
});
type Operation = z.infer<typeof operationSchema>;
const stopped = `r.status NOT IN ('live','running','paused') AND NOT EXISTS(
  SELECT 1 FROM app_setting timer WHERE timer.orgId=r.orgId AND timer.key IN ('rundown-timer:'||r.id,'rundown-timer:'||r.serviceDate)
  AND CASE WHEN json_valid(timer.value) THEN COALESCE(json_extract(timer.value,'$.playback'),'unknown')<>'stop' ELSE 1 END)`;
const readOperation = async (db: Database, orgId: string, showId: string) => {
  const row = await db
    .prepare(
      "SELECT orgId,showId,serviceDate,nonce,stage FROM show_deletion WHERE orgId=? AND showId=?",
    )
    .bind(orgId, showId)
    .first();
  return row ? operationSchema.parse(row) : null;
};

async function abortPreparation(db: Database, operation: Operation) {
  const match =
    "EXISTS(SELECT 1 FROM show_deletion WHERE orgId=? AND showId=? AND nonce=? AND stage='preparing')";
  await db.batch([
    db
      .prepare(
        `DELETE FROM app_setting WHERE orgId=? AND key=? AND value=? AND ${match}`,
      )
      .bind(
        operation.orgId,
        `show-deleting:${operation.showId}`,
        operation.nonce,
        operation.orgId,
        operation.showId,
        operation.nonce,
      ),
    db
      .prepare(
        "DELETE FROM show_deletion WHERE orgId=? AND showId=? AND nonce=? AND stage='preparing'",
      )
      .bind(operation.orgId, operation.showId, operation.nonce),
  ]);
}

/** Deletion is keyed by the stable show identity. Preparation is reversible;
 * purging is an accepted deletion that retries must finish, and deleted is its
 * durable receipt. Every caller, including a retry, needs current permission. */
export async function deleteServiceForOrg(
  input: DeleteShowInput,
  headers: Headers,
  relays: ShowDeletionRelays = showDeletionRelays,
  db: Database = getD1(),
) {
  const data = deleteShowInputSchema.parse(input);
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || (data.userId && data.userId !== session.user.id))
    // This can be a retry of an already accepted purge. Without current
    // authority, its outcome is unknown, not a definitive rejection.
    throw new Error(
      "Your account changed. Sign in to the original account and retry this deletion.",
    );
  const access = await memberPermissionGuard(
    db,
    data.orgId,
    { userId: session.user.id, sessionId: session.session.id },
    ["schedule:manage"],
  );
  let operation = await readOperation(db, data.orgId, data.showId);
  if (operation?.stage === "deleted") return { ok: true as const };
  if (!operation) {
    const show = await db
      .prepare(
        "SELECT serviceDate,updatedAt FROM rundown WHERE orgId=? AND id=?",
      )
      .bind(data.orgId, data.showId)
      .first<{ serviceDate: string; updatedAt: string | number }>();
    if (!show) {
      // Another copy of this deletion may finish between the receipt read and
      // the show read. Its accepted result wins over a missing-row rejection.
      const concurrent = await readOperation(db, data.orgId, data.showId);
      if (concurrent?.stage === "deleted") return { ok: true as const };
      if (concurrent)
        throw new Error(
          "Deletion cleanup is not confirmed. Retry deletion to finish.",
        );
      throw new ShowDeletionRejectedError("Show not found");
    }
    if (
      data.expectedUpdatedAt &&
      new Date(show.updatedAt).getTime() !== Date.parse(data.expectedUpdatedAt)
    )
      throw new ShowDeletionRejectedError(
        "This show changed. Refresh and confirm deletion again.",
      );
    markDatabaseWrite();
    const nonce = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          `INSERT INTO show_deletion(orgId,showId,serviceDate,nonce,stage,actorId,createdAt)
        SELECT r.orgId,r.id,r.serviceDate,?,'preparing',?,? FROM rundown r
        WHERE r.orgId=? AND r.id=? AND r.serviceDate=? AND r.updatedAt=? AND ${stopped} AND ${access.guard}
        ON CONFLICT(orgId,showId) DO NOTHING`,
        )
        .bind(
          nonce,
          session.user.id,
          Date.now(),
          data.orgId,
          data.showId,
          show.serviceDate,
          show.updatedAt,
          ...access.guardArgs,
        ),
      db
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value)
        SELECT ?,orgId,'show-deleting:'||showId,nonce FROM show_deletion WHERE orgId=? AND showId=? AND stage IN ('preparing','purging') AND ${access.guard}
        ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value`,
        )
        .bind(
          crypto.randomUUID(),
          data.orgId,
          data.showId,
          ...access.guardArgs,
        ),
    ]);
    operation = await readOperation(db, data.orgId, data.showId);
    if (!operation) {
      await memberPermissionGuard(
        db,
        data.orgId,
        { userId: session.user.id, sessionId: session.session.id },
        ["schedule:manage"],
      );
      const available = await db
        .prepare(
          `SELECT 1 FROM rundown r WHERE r.orgId=? AND r.id=? AND ${stopped}`,
        )
        .bind(data.orgId, data.showId)
        .first();
      if (!available) throw new ShowDeletionBlockedError();
      throw new ShowDeletionRejectedError(
        "This show changed. Refresh and confirm deletion again.",
      );
    }
  }
  if (operation.stage === "preparing") {
    try {
      await relays.prepare(operation);
      const changed = await db
        .prepare(
          `UPDATE show_deletion SET stage='purging' WHERE orgId=? AND showId=? AND nonce=? AND stage='preparing' AND ${access.guard}`,
        )
        .bind(
          operation.orgId,
          operation.showId,
          operation.nonce,
          ...access.guardArgs,
        )
        .run();
      const current = await readOperation(db, data.orgId, data.showId);
      if (
        !changed.meta.changes &&
        current?.stage !== "purging" &&
        current?.stage !== "deleted"
      ) {
        // No irreversible work was accepted. Release this preparation if its
        // actor lost permission while the relays were being checked.
        await abortPreparation(db, operation);
        throw new Error(
          "Deletion was not accepted. Check your access and confirm again.",
        );
      }
      if (!current || current.nonce !== operation.nonce)
        throw new Error("This deletion changed. Refresh before retrying.");
      operation = current;
    } catch (error) {
      if (error instanceof ShowDeletionBlockedError) {
        await abortPreparation(db, operation);
        // A concurrent retry may already have accepted deletion, in which case
        // preparation cannot be rolled back and the client must retain recovery.
        if (await readOperation(db, data.orgId, data.showId))
          throw new Error(
            "Deletion cleanup is not confirmed. Retry deletion to finish.",
            { cause: error },
          );
      }
      throw error;
    }
  }
  if (operation.stage === "deleted") return { ok: true as const };
  markDatabaseWrite();
  try {
    await relays.purge(operation);
  } catch (error) {
    if (error instanceof ShowDeletionRejectedError)
      throw new Error(
        "Deletion was accepted, but cleanup is not confirmed. Retry deletion to finish.",
        { cause: error },
      );
    throw error;
  }
  await db.batch([
    ...cleanupStatements(db, operation),
    db
      .prepare(
        "UPDATE show_deletion SET stage='deleted',completedAt=? WHERE orgId=? AND showId=? AND nonce=? AND stage='purging'",
      )
      .bind(Date.now(), operation.orgId, operation.showId, operation.nonce),
  ]);
  const result = await readOperation(db, data.orgId, data.showId);
  if (result?.stage !== "deleted")
    throw new Error("Deletion is not confirmed. Retry to finish cleanup.");
  return { ok: true as const };
}

function cleanupStatements(db: Database, operation: ShowDeletionTarget) {
  const deletingKey = `show-deleting:${operation.showId}`;
  // Apply the same operation guard to every deletion in the atomic graph cleanup.
  const guarded = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) =>
        db
          .prepare(
            `${sql} AND EXISTS(SELECT 1 FROM show_deletion WHERE orgId=? AND showId=? AND nonce=? AND stage='purging')`,
          )
          .bind(...args, operation.orgId, operation.showId, operation.nonce),
    }),
  };
  const showArgs = [operation.orgId, operation.showId] as const;
  return [
    guarded
      .prepare(
        "DELETE FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment' AND targetId IN (SELECT id FROM incident_comment WHERE orgId = ? AND incidentId IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?))",
      )
      .bind(operation.orgId, operation.orgId, ...showArgs),
    guarded
      .prepare(
        "DELETE FROM incident_comment WHERE orgId = ? AND incidentId IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?)",
      )
      .bind(operation.orgId, ...showArgs),
    guarded
      .prepare(
        "DELETE FROM notification WHERE orgId = ? AND source IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?)",
      )
      .bind(operation.orgId, ...showArgs),
    guarded
      .prepare(
        "DELETE FROM notification WHERE orgId = ? AND source IN (SELECT id FROM service_assignment WHERE orgId = ? AND showId = ?)",
      )
      .bind(operation.orgId, ...showArgs),
    guarded
      .prepare("DELETE FROM cue_note WHERE orgId = ? AND showId = ?")
      .bind(...showArgs),
    guarded
      .prepare("DELETE FROM cue_sheet WHERE orgId = ? AND showId = ?")
      .bind(...showArgs),
    guarded
      .prepare("DELETE FROM checklist_entry WHERE orgId = ? AND showId = ?")
      .bind(...showArgs),
    guarded
      .prepare("DELETE FROM service_assignment WHERE orgId = ? AND showId = ?")
      .bind(...showArgs),
    guarded
      .prepare("DELETE FROM rundown_item WHERE orgId = ? AND showId = ?")
      .bind(...showArgs),
    guarded
      .prepare("DELETE FROM incident WHERE orgId = ? AND showId = ?")
      .bind(...showArgs),
    guarded
      .prepare("DELETE FROM mic_assignment WHERE orgId = ? AND showId = ?")
      .bind(...showArgs),
    guarded
      .prepare(
        "DELETE FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?, ?)",
      )
      .bind(
        operation.orgId,
        `rundown-items:${operation.showId}`,
        `rundown-timer:${operation.showId}`,
        `rundown-message:${operation.showId}`,
        `rundown-ppslide:${operation.showId}`,
        `rundown-items-storage:${operation.showId}`,
      ),
    guarded
      .prepare(
        "DELETE FROM app_setting WHERE orgId = ? AND key = 'active-show-id' AND value = ?",
      )
      .bind(operation.orgId, operation.showId),
    guarded
      .prepare("DELETE FROM rundown WHERE orgId = ? AND id = ?")
      .bind(...showArgs),
    guarded
      .prepare("DELETE FROM app_setting WHERE orgId = ? AND key = ?")
      .bind(operation.orgId, deletingKey),
    guarded
      .prepare(
        "DELETE FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?, ?) AND NOT EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND serviceDate = ?)",
      )
      .bind(
        operation.orgId,
        `rundown-items:${operation.serviceDate}`,
        `rundown-timer:${operation.serviceDate}`,
        `rundown-message:${operation.serviceDate}`,
        `rundown-ppslide:${operation.serviceDate}`,
        `rundown-items-storage:${operation.serviceDate}`,
        operation.orgId,
        operation.serviceDate,
      ),
    guarded
      .prepare(
        "DELETE FROM app_setting WHERE orgId = ? AND key = 'active-service-date' AND value = ? AND NOT EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND serviceDate = ?)",
      )
      .bind(
        operation.orgId,
        operation.serviceDate,
        operation.orgId,
        operation.serviceDate,
      ),
  ];
}
