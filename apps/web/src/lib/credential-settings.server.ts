import { CredentialVault } from "./credential-vault.server";
import { CREDENTIAL_MASK, isCredentialField, maskedCredential } from "./credential-fields";
import { markDatabaseWrite } from "./request-database.server";

export function maskSettingValue(key: string, value: string): string {
  return isCredentialField(key) || value.startsWith("spenc:") ? maskedCredential(value) : value;
}

/** Only call inside a permission-checked write. A mask is a no-op, never a password. */
export async function encryptSettingValue(secret: string | undefined, orgId: string, key: string, value: string): Promise<string> {
  if (value === CREDENTIAL_MASK || value.startsWith("spenc:")) throw new Error("Use a new credential value or keep the existing setting.");
  if (!isCredentialField(key) || !value) return value;
  const vault = await CredentialVault.fromSecret(secret);
  return await vault.encrypt({ kind: "setting", orgId, key }, value);
}

/** Internal consumers only. Legacy plaintext remains readable during backfill;
 * encrypted values never fall back to plaintext when their key is unavailable. */
export async function readSettingValuesForUse(
  secret: string | undefined, orgId: string, rows: readonly { key: string; value: string }[],
): Promise<Record<string, string>> {
  const vault = rows.some(row => row.value.startsWith("spenc:")) ? await CredentialVault.fromSecret(secret) : null;
  return Object.fromEntries(await Promise.all(rows.map(async row => [row.key,
    row.value.startsWith("spenc:") && vault ? await vault.decrypt({ kind: "setting", orgId, key: row.key }, row.value) : row.value,
  ])));
}

/** One bounded sweep step. CAS writes preserve simultaneous user edits/deletion.
 * Checkpoints wrap at EOF so legacy rows edited during a sweep are revisited. */
export async function backfillCredentialSettings(db: D1Database, secret: string | undefined, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid credential migration batch size");
  const vault = await CredentialVault.fromSecret(secret);
  await db.prepare("INSERT OR IGNORE INTO credential_backfill_cursor (name, lastRowId) VALUES ('settings', 0)").run();
  const cursor = await db.prepare("SELECT lastRowId FROM credential_backfill_cursor WHERE name = 'settings'").first<number>("lastRowId") ?? 0;
  const rows = (await db.prepare("SELECT rowid AS rowId, id, orgId, key, value FROM app_setting WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .bind(cursor, limit).all<{ rowId: number; id: string; orgId: string; key: string; value: string }>()).results;
  const eligible = rows.filter(row => isCredentialField(row.key) && row.value !== "" && !row.value.startsWith("spenc:") && row.key !== "api-key");
  const updates = await Promise.all(eligible.map(async row => db.prepare("UPDATE app_setting SET value = ? WHERE id = ? AND orgId = ? AND key = ? AND value = ?")
    .bind(await vault.encrypt({ kind: "setting", orgId: row.orgId, key: row.key }, row.value), row.id, row.orgId, row.key, row.value)));
  const nextCursor = rows.length < limit ? 0 : rows[rows.length - 1].rowId;
  const results = await db.batch([
    ...updates,
    db.prepare("UPDATE credential_backfill_cursor SET lastRowId = ? WHERE name = 'settings' AND lastRowId = ?").bind(nextCursor, cursor),
  ]);
  const migrated = results.slice(0, -1).reduce((sum, result) => sum + result.meta.changes, 0);
  if (migrated) markDatabaseWrite();
  return { scanned: rows.length, migrated, sweepComplete: nextCursor === 0 };
}
