export interface GraphicCompositionItem {
  key: string;
  name: string;
  title: string;
  subtitle: string;
  style: string;
}

const ACTIVE_KEY = "active-graphics";
const LEGACY_KEY = "active-graphic";
const PUBLISH_KEY_PREFIX = "graphic-publish:";

function storedIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0 && candidate.length <= 64)
      : [];
  } catch {
    return [];
  }
}

type GraphicCompositionDatabase = Pick<D1Database, "prepare" | "batch">;

/** Creates immutable rows and changes the Program pointer in one D1 transaction. */
export async function publishGraphicCompositionForOrg(
  db: GraphicCompositionDatabase,
  input: { orgId: string; requestId: string; items: GraphicCompositionItem[] },
) {
  const markerKey = `${PUBLISH_KEY_PREFIX}${input.requestId}`;
  const receiptKey = `graphic-publish-receipt:${input.requestId}`;
  const namespaceBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${input.orgId}:${input.requestId}`));
  const namespace = [...new Uint8Array(namespaceBytes)].slice(0, 12).map(byte => byte.toString(16).padStart(2, "0")).join("");
  const publishedIds = input.items.map((_, index) => `live-${namespace}-${index}`);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input.items))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  // A unique receipt owner gates every write inside the same transaction. A
  // duplicate arriving after a newer publication can acknowledge, never republish.
  const receipt = JSON.stringify({ digest, owner: crypto.randomUUID() });
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ?)
      ON CONFLICT(orgId, key) DO NOTHING`)
      .bind(crypto.randomUUID(), input.orgId, receiptKey, receipt, input.orgId, markerKey),
    // Preserve the existing array marker so a rollback still recognizes this
    // publication as already applied. Its immutable receipt carries new metadata.
    db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)
      ON CONFLICT(orgId, key) DO NOTHING`)
      .bind(crypto.randomUUID(), input.orgId, markerKey, JSON.stringify(publishedIds), input.orgId, receiptKey, receipt),
  ];
  for (const [index, item] of input.items.entries()) {
    statements.push(db.prepare(`INSERT INTO graphic_template (id, orgId, name, title, subtitle, style, createdAt, updatedAt)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)`)
      .bind(publishedIds[index], input.orgId, item.name, item.title, item.subtitle, item.style, now, now, input.orgId, receiptKey, receipt));
  }
  statements.push(
    db.prepare(`DELETE FROM app_setting WHERE orgId = ? AND key = ?
      AND EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)`)
      .bind(input.orgId, LEGACY_KEY, input.orgId, receiptKey, receipt),
    db.prepare(`INSERT INTO app_setting (id, orgId, key, value)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)
      ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`)
      .bind(crypto.randomUUID(), input.orgId, ACTIVE_KEY, JSON.stringify(publishedIds), input.orgId, receiptKey, receipt),
  );
  await db.batch(statements);
  const saved = await db.prepare("SELECT json_extract(value, '$.digest') AS digest FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(input.orgId, receiptKey).first<{ digest: string | null }>();
  // Old array-only receipts remain immutable too, but cannot confirm a payload.
  if (saved?.digest !== digest) throw new Error("This publication request is already recorded with different content. Review Program before publishing again.");
  const activeRow = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(input.orgId, ACTIVE_KEY).first<{ value: string }>();
  const activeIds = storedIds(activeRow?.value);
  return { revision: input.requestId, publishedIds, activeIds, isActive: publishedIds.length > 0 && publishedIds.every((id) => activeIds.includes(id)) };
}
