import { markDatabaseWrite } from "./request-database.server";

export type ScopedTokenKind = "kiosk" | "companion";
const tables = { kiosk: "kiosk_token", companion: "companion_token" } as const;
const digestPrefix = "sha256:";

export async function scopedTokenDigest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return digestPrefix + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

interface StoredTokenAuthority {
  id: string;
  orgId: string;
  view: string | null;
  expiresAt: string | number | null;
  revokedAt: string | number | null;
}

export function scopedTokenExpiry(value: StoredTokenAuthority["expiresAt"]): number {
  if (value === null) return Infinity;
  return typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value);
}

export function scopedTokenIsActive(row: StoredTokenAuthority | null, now = Date.now()): row is StoredTokenAuthority {
  return row !== null && row.revokedAt === null && scopedTokenExpiry(row.expiresAt) > now;
}

/** Call only after signature, scope and signed organization validation.
 * Existing issued tokens keep working while their stored plaintext is removed. */
export async function findScopedToken(db: D1Database, kind: ScopedTokenKind, orgId: string, token: string): Promise<StoredTokenAuthority | null> {
  const table = tables[kind];
  const digest = await scopedTokenDigest(token);
  const select = () => db.prepare(`SELECT id, orgId, ${kind === "kiosk" ? "view" : "NULL AS view"}, expiresAt, revokedAt
    FROM ${table} WHERE orgId = ? AND token = ? LIMIT 1`).bind(orgId, digest);
  const existing = await select().first<StoredTokenAuthority>();
  if (existing) return existing;
  // Compare-and-set preserves concurrent revocation and never modifies another org.
  const migrated = await db.prepare(`UPDATE ${table} SET token = ? WHERE orgId = ? AND token = ?`)
    .bind(digest, orgId, token).run();
  if (migrated.meta.changes > 0) markDatabaseWrite();
  return select().first<StoredTokenAuthority>();
}

/** Bounded, repeatable migration for inactive and revoked legacy credentials too. */
export async function backfillScopedTokenDigests(db: D1Database, batchSize = 100) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("Invalid token migration batch size");
  let migrated = 0;
  let remaining = 0;
  for (const kind of ["kiosk", "companion"] as const) {
    const table = tables[kind];
    const rows = (await db.prepare(`SELECT id, orgId, token FROM ${table} WHERE token NOT LIKE 'sha256:%' ORDER BY id LIMIT ?`)
      .bind(batchSize).all<{ id: string; orgId: string; token: string }>()).results;
    const updates = await Promise.all(rows.map(async row => db.prepare(`UPDATE ${table} SET token = ? WHERE id = ? AND orgId = ? AND token = ?`)
      .bind(await scopedTokenDigest(row.token), row.id, row.orgId, row.token)));
    if (updates.length) {
      const results = await db.batch(updates);
      migrated += results.reduce((sum, result) => sum + result.meta.changes, 0);
    }
    remaining += await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE token NOT LIKE 'sha256:%'`).first<number>("count") ?? 0;
  }
  if (migrated) markDatabaseWrite();
  return { migrated, remaining };
}
