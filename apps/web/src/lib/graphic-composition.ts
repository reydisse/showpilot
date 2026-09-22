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
  const existing = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(input.orgId, markerKey).first<{ value: string }>();
  let publishedIds = storedIds(existing?.value);
  if (publishedIds.length === 0) {
    const namespaceBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${input.orgId}:${input.requestId}`),
    );
    const namespace = [...new Uint8Array(namespaceBytes)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    publishedIds = input.items.map((_, index) => `live-${namespace}-${index}`);
    const now = new Date().toISOString();
    const statements = input.items.map((item, index) => db.prepare(
      `INSERT INTO graphic_template (id, orgId, name, title, subtitle, style, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(publishedIds[index], input.orgId, item.name, item.title, item.subtitle, item.style, now, now));
    statements.push(
      db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = ?").bind(input.orgId, LEGACY_KEY),
      db.prepare(
        `INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(crypto.randomUUID(), input.orgId, ACTIVE_KEY, JSON.stringify(publishedIds)),
      db.prepare(
        `INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(orgId, key) DO NOTHING`,
      ).bind(crypto.randomUUID(), input.orgId, markerKey, JSON.stringify(publishedIds)),
    );
    await db.batch(statements);
  }
  const activeRow = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ?")
    .bind(input.orgId, ACTIVE_KEY).first<{ value: string }>();
  const activeIds = storedIds(activeRow?.value);
  return { revision: input.requestId, publishedIds, activeIds, isActive: publishedIds.length > 0 && publishedIds.every((id) => activeIds.includes(id)) };
}
