import type { SettingWrite, SettingWriteResult } from "./setting-writes";

/** Receipt and conditional setting write share one D1 transaction. */
export async function applySettingWrite(db: Pick<D1Database, "prepare" | "batch">, input: SettingWrite, userId: string): Promise<SettingWriteResult> {
  const { orgId, key, value, expectedValue, requestId } = input;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ userId, key, value, expectedValue }))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const receiptKey = `setting-write:${requestId}`;
  const read = async (): Promise<SettingWriteResult | null> => {
    const row = await db.prepare(`SELECT json_extract(r.value, '$.digest') AS digest,
      json_extract(r.value, '$.outcome') AS outcome,
      (SELECT value FROM app_setting WHERE orgId = ? AND key = ?) AS currentValue
      FROM app_setting r WHERE r.orgId = ? AND r.key = ?`)
      .bind(orgId, key, orgId, receiptKey).first<{ digest: string; outcome: string; currentValue: string | null }>();
    if (!row) return null;
    if (row.digest !== digest) throw new Error("This request was already used for a different setting change.");
    if (row.outcome !== "applied" && row.outcome !== "conflict") throw new Error("Invalid setting acknowledgement.");
    return { requestId, key, outcome: row.outcome, currentValue: row.currentValue };
  };
  const previous = await read();
  if (previous) return previous;
  const token = crypto.randomUUID();
  const applied = JSON.stringify({ digest, token, outcome: "applied" });
  const conflict = JSON.stringify({ digest, token, outcome: "conflict" });
  await db.batch([
    db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
      VALUES (?, ?, ?, CASE WHEN (SELECT value FROM app_setting WHERE orgId = ? AND key = ?) IS ? THEN ? ELSE ? END)
      ON CONFLICT(orgId, key) DO NOTHING`).bind(crypto.randomUUID(), orgId, receiptKey, orgId, key, expectedValue, applied, conflict),
    db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)
      ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`)
      .bind(crypto.randomUUID(), orgId, key, value, orgId, receiptKey, applied),
  ]);
  const saved = await read();
  if (!saved) throw new Error("Missing setting acknowledgement.");
  return saved;
}
