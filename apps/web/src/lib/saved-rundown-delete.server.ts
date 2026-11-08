import {
  rundownDetailsAuthority,
  RundownDetailsAccessError,
} from "./rundown-details-authority.server";

export const SAVED_RUNDOWN_REMOVED_RECEIPT = "removed";

/** Immutable template IDs make deletion retryable. Guard both the legacy-save
 * fence and delete in the same transaction against current editing authority. */
export async function removeSavedRundown(
  db: Pick<D1Database, "prepare" | "batch">,
  orgId: string,
  id: string,
  actor: { userId: string; sessionId: string; pin: string | null },
) {
  const access = await rundownDetailsAuthority(db, orgId, actor, actor.pin);
  const result = await db.batch<{ allowed: number }>([
    db
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value) SELECT ?,?,?,? WHERE ${access.guard}
      ON CONFLICT(orgId,key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        `rundown-template-save:${id}`,
        SAVED_RUNDOWN_REMOVED_RECEIPT,
        ...access.guardArgs,
      ),
    db
      .prepare(
        `DELETE FROM app_setting WHERE orgId=? AND key=? AND ${access.guard}`,
      )
      .bind(orgId, `rundown-saved:${id}`, ...access.guardArgs),
    db
      .prepare(`SELECT 1 AS allowed WHERE ${access.guard}`)
      .bind(...access.guardArgs),
  ]);
  if (result[2].results[0]?.allowed !== 1)
    throw new RundownDetailsAccessError(
      "Your rundown editing access changed. Restore access before retrying this template deletion.",
    );
}
