import type { ChecklistWriteDatabase } from "./checklist-write.server";

export const SAVED_RUNDOWN_REMOVED_RECEIPT = "removed";

/** Caller must verify organization edit permission. The deletion fence also
 * covers templates saved by older clients before immutable receipts existed. */
export async function removeSavedRundown(
  db: ChecklistWriteDatabase,
  orgId: string,
  id: string,
) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,?,?)
      ON CONFLICT(orgId,key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        orgId,
        `rundown-template-save:${id}`,
        SAVED_RUNDOWN_REMOVED_RECEIPT,
      ),
    db
      .prepare("DELETE FROM app_setting WHERE orgId=? AND key=?")
      .bind(orgId, `rundown-saved:${id}`),
  ]);
}
