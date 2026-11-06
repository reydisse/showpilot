/** Transport credentials never confer member or show-control permissions. */
export interface BridgeCredentialAuthority {
  orgId: string;
  installationId: string;
  label: string;
  credentialId: string;
  expiresAt: number | null;
}
export interface BridgeInstallationSummary {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
interface InstallationActor { orgId: string; installationId: string; actorUserId: string }
export const BRIDGE_ROTATION_OVERLAP_MS = 10 * 60_000;

const AUTHORITY_SELECT = `SELECT c.orgId, c.installationId, i.label, c.id AS credentialId, c.expiresAt
  FROM bridge_credential c
  JOIN bridge_installation i ON i.id = c.installationId AND i.orgId = c.orgId
  WHERE c.orgId = ? AND i.revokedAt IS NULL AND (c.expiresAt IS NULL OR c.expiresAt > ?)`;

async function hashCredential(key: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function newCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = `sp_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return { key, id: crypto.randomUUID(), hash: await hashCredential(key) };
}

/** Only the one-time creation/rotation result contains the secret. */
export async function issueBridgeInstallation(
  db: D1Database,
  input: { orgId: string; label: string; actorUserId: string },
  now = Date.now(),
) {
  const credential = await newCredential();
  const installationId = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO bridge_installation (id, orgId, label, createdByUserId, createdAt)
      VALUES (?, ?, ?, ?, ?)`).bind(installationId, input.orgId, input.label, input.actorUserId, now),
    db.prepare(`INSERT INTO bridge_credential (id, orgId, installationId, keyHash, createdAt)
      VALUES (?, ?, ?, ?, ?)`).bind(credential.id, input.orgId, installationId, credential.hash, now),
    db.prepare(`INSERT INTO bridge_credential_audit (id, orgId, credentialId, action, direction, actorUserId, createdAt)
      VALUES (?, ?, ?, 'issued', 'credential', ?, ?)`).bind(crypto.randomUUID(), input.orgId, credential.id, input.actorUserId, now),
  ]);
  return { installationId, credentialId: credential.id, key: credential.key };
}

/** Repeated rotations can shorten older overlap windows, never extend them. */
export async function rotateBridgeInstallation(db: D1Database, input: InstallationActor, now = Date.now()) {
  const credential = await newCredential();
  const expiresAt = now + BRIDGE_ROTATION_OVERLAP_MS;
  const results = await db.batch([
    db.prepare(`UPDATE bridge_credential SET expiresAt = CASE
        WHEN expiresAt IS NULL OR expiresAt > ? THEN ? ELSE expiresAt END
      WHERE orgId = ? AND installationId = ?
        AND EXISTS (SELECT 1 FROM bridge_installation i WHERE i.id = ? AND i.orgId = ? AND i.revokedAt IS NULL)`)
      .bind(expiresAt, expiresAt, input.orgId, input.installationId, input.installationId, input.orgId),
    db.prepare(`INSERT INTO bridge_credential (id, orgId, installationId, keyHash, createdAt)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM bridge_installation WHERE id = ? AND orgId = ? AND revokedAt IS NULL
      )`).bind(credential.id, input.orgId, input.installationId, credential.hash, now, input.installationId, input.orgId),
    db.prepare(`INSERT INTO bridge_credential_audit (id, orgId, credentialId, action, direction, actorUserId, createdAt)
      SELECT ?, ?, id, 'rotated', 'credential', ?, ? FROM bridge_credential WHERE id = ? AND orgId = ?`)
      .bind(crypto.randomUUID(), input.orgId, input.actorUserId, now, credential.id, input.orgId),
  ]);
  if (results[1].meta.changes !== 1) throw new Error("Bridge installation was revoked or is unavailable.");
  return { installationId: input.installationId, credentialId: credential.id, key: credential.key, previousKeysExpireAt: expiresAt };
}

export async function revokeBridgeInstallation(db: D1Database, input: InstallationActor, now = Date.now()): Promise<void> {
  const exists = await db.prepare("SELECT id FROM bridge_installation WHERE orgId = ? AND id = ?")
    .bind(input.orgId, input.installationId).first();
  if (!exists) throw new Error("Bridge installation is unavailable.");
  await db.batch([
    db.prepare("UPDATE bridge_installation SET revokedAt = ? WHERE orgId = ? AND id = ? AND revokedAt IS NULL")
      .bind(now, input.orgId, input.installationId),
    db.prepare(`INSERT OR IGNORE INTO bridge_credential_audit (id, orgId, credentialId, action, direction, actorUserId, createdAt)
      SELECT ?, ?, id, 'revoked', 'credential', ?, ? FROM bridge_credential
      WHERE orgId = ? AND installationId = ? ORDER BY createdAt DESC, id DESC LIMIT 1`)
      .bind(`revoke:${input.installationId}`, input.orgId, input.actorUserId, now, input.orgId, input.installationId),
  ]);
}

export async function listBridgeInstallations(db: D1Database, orgId: string): Promise<BridgeInstallationSummary[]> {
  const result = await db.prepare(`SELECT id, label, createdAt, lastUsedAt, revokedAt
    FROM bridge_installation WHERE orgId = ? ORDER BY createdAt DESC, id`)
    .bind(orgId).all<BridgeInstallationSummary>();
  return result.results;
}

/** Header only. A key-bearing URL is rejected even if a valid header is also present. */
export async function authenticateBridgeRequest(db: D1Database, request: Request, orgId: string, now = Date.now()): Promise<BridgeCredentialAuthority | null> {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((name) => /^(key|apikey|api-key|api_key|authbridgekey)$/i.test(name))) return null;
  const key = request.headers.get("x-showpilot-api-key");
  if (!key || key.length > 256) return null;
  return db.prepare(`${AUTHORITY_SELECT} AND c.keyHash = ?`)
    .bind(orgId, now, await hashCredential(key)).first<BridgeCredentialAuthority>();
}

/** Internal relay revalidation uses a credential ID, never the secret or its hash. */
export async function getBridgeCredentialAuthority(db: D1Database, orgId: string, credentialId: string, now = Date.now()): Promise<BridgeCredentialAuthority | null> {
  return db.prepare(`${AUTHORITY_SELECT} AND c.id = ?`).bind(orgId, now, credentialId).first<BridgeCredentialAuthority>();
}

export type BridgeAuditAction = "selection-requested" | "connected" | "command" | "connect-device" | "disconnect-device"
  | "bridge-status" | "command-response" | "device-event" | "device-status" | "timecode-feed" | "timecode-transport" | "ping" | "pong";

/** Revalidate and record before forwarding a write. No device payload reaches the audit table. */
export async function recordBridgeWrite(
  db: D1Database,
  authority: Omit<BridgeCredentialAuthority, "label">,
  input: { action: BridgeAuditAction; direction: "from-bridge" | "to-bridge"; actorUserId?: string },
  now = Date.now(),
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`INSERT INTO bridge_credential_audit (id, orgId, credentialId, action, direction, actorUserId, createdAt)
      SELECT ?, c.orgId, c.id, ?, ?, ?, ? FROM bridge_credential c
      JOIN bridge_installation i ON i.id = c.installationId AND i.orgId = c.orgId
      WHERE c.orgId = ? AND c.id = ? AND c.installationId = ? AND i.revokedAt IS NULL
        AND (c.expiresAt IS NULL OR c.expiresAt > ?)`)
      .bind(crypto.randomUUID(), input.action, input.direction, input.actorUserId ?? null, now,
        authority.orgId, authority.credentialId, authority.installationId, now),
    db.prepare(`UPDATE bridge_installation SET lastUsedAt = CASE WHEN lastUsedAt IS NULL OR lastUsedAt < ? THEN ? ELSE lastUsedAt END WHERE orgId = ? AND id = ? AND revokedAt IS NULL
      AND EXISTS (SELECT 1 FROM bridge_credential c WHERE c.id = ? AND c.orgId = ? AND c.installationId = bridge_installation.id
        AND (c.expiresAt IS NULL OR c.expiresAt > ?))`)
      .bind(now, now, authority.orgId, authority.installationId, authority.credentialId, authority.orgId, now),
  ]);
  return results[0].meta.changes === 1;
}

/** Idempotent data conversion; an existing Bridge keeps using its current header key. */
export async function migrateLegacyBridgeInstallation(db: D1Database, orgId: string, now = Date.now()): Promise<void> {
  const legacy = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'api-key'")
    .bind(orgId).first<{ value: string }>();
  if (!legacy?.value) return;
  const hash = await hashCredential(legacy.value);
  const installationId = `legacy_${(await hashCredential(orgId)).slice(0, 32)}`;
  const credentialId = `legacy_${(await hashCredential(`${orgId}:${hash}`)).slice(0, 32)}`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO bridge_installation (id, orgId, label, createdByUserId, createdAt)
      SELECT ?, ?, 'Existing Bridge', 'system:migration', ? WHERE EXISTS (
        SELECT 1 FROM app_setting WHERE orgId = ? AND key = 'api-key' AND value = ?)`)
      .bind(installationId, orgId, now, orgId, legacy.value),
    db.prepare(`INSERT OR IGNORE INTO bridge_credential (id, orgId, installationId, keyHash, createdAt)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM app_setting WHERE orgId = ? AND key = 'api-key' AND value = ?)`)
      .bind(credentialId, orgId, installationId, hash, now, orgId, legacy.value),
    db.prepare(`INSERT OR IGNORE INTO bridge_credential_audit (id, orgId, credentialId, action, direction, actorUserId, createdAt)
      SELECT ?, ?, id, 'migrated', 'credential', 'system:migration', ? FROM bridge_credential WHERE id = ? AND orgId = ?`)
      .bind(`migrate:${credentialId}`, orgId, now, credentialId, orgId),
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = 'api-key' AND value = ?")
      .bind(orgId, legacy.value),
  ]);
}

/** Bounded scheduled backfill also removes keys belonging to offline installations. */
export async function backfillLegacyBridgeInstallations(db: D1Database, limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid credential migration batch size.");
  const pending = await db.prepare("SELECT orgId FROM app_setting WHERE key = 'api-key' ORDER BY orgId LIMIT ?")
    .bind(limit).all<{ orgId: string }>();
  let migrated = 0;
  let failed = 0;
  for (const { orgId } of pending.results) {
    try {
      await migrateLegacyBridgeInstallation(db, orgId);
      await db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = 'api-key' AND value = ''").bind(orgId).run();
      migrated++;
    } catch {
      // Never include the SQL error or credential-bearing row in a log/response.
      failed++;
    }
  }
  const remaining = await db.prepare("SELECT COUNT(*) AS count FROM app_setting WHERE key = 'api-key'").first<{ count: number }>();
  return { migrated, failed, remaining: remaining?.count ?? 0 };
}
