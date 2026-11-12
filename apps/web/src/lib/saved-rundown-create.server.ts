import { SAVED_RUNDOWN_REMOVED_RECEIPT } from "./saved-rundown-delete.server";
import { z } from "zod";
import type { ChecklistWriteDatabase } from "./checklist-write.server";
import type { SavedRundown } from "./rundown";

type TemplateContent = Pick<
  SavedRundown,
  "id" | "name" | "serviceName" | "scheduledStartTime" | "items"
>;

/** Caller must verify current organization edit permission before every attempt. */
export async function createSavedRundown(
  db: ChecklistWriteDatabase,
  orgId: string,
  content: TemplateContent,
): Promise<
  { ok: true; id: string } | { ok: false; reason: "conflict" | "removed" }
> {
  const { canonical, digest } = await savedRundownIdentity(content);
  const key = `rundown-saved:${content.id}`;
  const receiptKey = `rundown-template-save:${content.id}`;
  const now = new Date().toISOString();
  const value = JSON.stringify({
    ...canonical,
    createdAt: now,
    updatedAt: now,
  });
  const result = z
    .tuple([
      z.unknown(),
      z.unknown(),
      z.object({ results: z.array(z.object({ value: z.string() })) }),
      z.object({ results: z.array(z.object({ id: z.string() })) }),
    ])
    .parse(
      await db.batch([
        db
          .prepare(
            `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId=? AND key=?)
      ON CONFLICT(orgId,key) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), orgId, key, value, orgId, receiptKey),
        // Only the transaction that created this exact template may issue its receipt.
        db
          .prepare(
            `INSERT INTO app_setting(id,orgId,key,value)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND value=?)
      ON CONFLICT(orgId,key) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            orgId,
            receiptKey,
            digest,
            orgId,
            key,
            value,
          ),
        db
          .prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?")
          .bind(orgId, receiptKey),
        db
          .prepare("SELECT id FROM app_setting WHERE orgId=? AND key=?")
          .bind(orgId, key),
      ]),
    );
  if (result[2].results[0]?.value === SAVED_RUNDOWN_REMOVED_RECEIPT)
    return { ok: false, reason: "removed" };
  if (result[2].results[0]?.value !== digest)
    return { ok: false, reason: "conflict" };
  if (result[3].results.length === 0) return { ok: false, reason: "removed" };
  // The receipt outlives template deletion so a delayed retry cannot resurrect it.
  return { ok: true, id: content.id };
}

export async function savedRundownIdentity(content: TemplateContent) {
  // Explicit field order makes the receipt independent of argument property order.
  const canonical = {
    id: content.id,
    name: content.name,
    serviceName: content.serviceName,
    scheduledStartTime: content.scheduledStartTime,
    items: content.items,
  };
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  const digest = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { canonical, digest };
}
