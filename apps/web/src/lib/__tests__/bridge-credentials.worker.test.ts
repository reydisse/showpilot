import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  authenticateBridgeRequest, BRIDGE_ROTATION_OVERLAP_MS, getBridgeCredentialAuthority,
  issueBridgeInstallation, listBridgeInstallations, recordBridgeWrite,
  revokeBridgeInstallation, rotateBridgeInstallation, migrateLegacyBridgeInstallation, backfillLegacyBridgeInstallations,
} from "../bridge-credentials.server";

const now = 1_800_000_000_000;
async function organization() {
  const orgId = `bridge-credentials-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Bridge credentials test', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
  return orgId;
}
function request(key?: string, query = "") {
  return new Request(`https://app.example/api/bridge/org/ws?role=bridge${query}`, {
    headers: key ? { "x-showpilot-api-key": key } : {},
  });
}
function issue(orgId: string, label = "Main venue") {
  return issueBridgeInstallation(env.DB, { orgId, label, actorUserId: "test-owner" }, now);
}
function actor(orgId: string, installationId: string) { return { orgId, installationId, actorUserId: "test-owner" }; }

async function storedRows(orgId: string) {
  const rows = await Promise.all([
    env.DB.prepare("SELECT * FROM bridge_installation WHERE orgId = ?").bind(orgId).all(),
    env.DB.prepare("SELECT * FROM bridge_credential WHERE orgId = ?").bind(orgId).all(),
    env.DB.prepare("SELECT * FROM bridge_credential_audit WHERE orgId = ?").bind(orgId).all(),
  ]);
  return rows.map((result) => result.results);
}

describe("Bridge installation credentials", () => {
  it("backfills offline installations in bounded batches until no plaintext settings remain", async () => {
    for (let index = 0; index < 3; index++) {
      const orgId = await organization();
      await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'api-key', ?)")
        .bind(crypto.randomUUID(), orgId, index === 2 ? "" : `sp_offline_fixture_${index}`).run();
    }
    expect(await backfillLegacyBridgeInstallations(env.DB, 2)).toEqual({ migrated: 2, failed: 0, remaining: 1 });
    expect(await backfillLegacyBridgeInstallations(env.DB, 2)).toEqual({ migrated: 1, failed: 0, remaining: 0 });
    expect(await backfillLegacyBridgeInstallations(env.DB, 2)).toEqual({ migrated: 0, failed: 0, remaining: 0 });
    await expect(backfillLegacyBridgeInstallations(env.DB, 0)).rejects.toThrow("batch size");
  });
  it("converts legacy keys atomically and idempotently without changing the active header credential", async () => {
    const orgId = await organization();
    const legacy = "sp_legacy_fixture_only";
    await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'api-key', ?)")
      .bind(crypto.randomUUID(), orgId, legacy).run();
    await Promise.all([
      migrateLegacyBridgeInstallation(env.DB, orgId, now),
      migrateLegacyBridgeInstallation(env.DB, orgId, now),
    ]);
    await migrateLegacyBridgeInstallation(env.DB, orgId, now + 10);
    expect(await env.DB.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'api-key'").bind(orgId).first()).toBeNull();
    const authority = await authenticateBridgeRequest(env.DB, request(legacy), orgId, now);
    expect(authority).not.toBeNull();
    expect(await listBridgeInstallations(env.DB, orgId)).toHaveLength(1);
    const rows = await storedRows(orgId);
    expect(rows.map((table) => table.length)).toEqual([1, 1, 1]);
    expect(JSON.stringify(rows)).not.toContain(legacy);
  });

  it("keeps identical legacy values independently revocable across organizations", async () => {
    const first = await organization(); const second = await organization();
    const legacy = "sp_shared_legacy_fixture";
    for (const orgId of [first, second]) {
      await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'api-key', ?)")
        .bind(crypto.randomUUID(), orgId, legacy).run();
      await migrateLegacyBridgeInstallation(env.DB, orgId, now);
    }
    const authority = await authenticateBridgeRequest(env.DB, request(legacy), first, now);
    if (!authority) throw new Error("Migration did not create the installation");
    await revokeBridgeInstallation(env.DB, actor(first, authority.installationId), now + 1);
    await migrateLegacyBridgeInstallation(env.DB, first, now + 2);
    expect(await authenticateBridgeRequest(env.DB, request(legacy), first, now + 2)).toBeNull();
    expect(await authenticateBridgeRequest(env.DB, request(legacy), second, now + 2)).not.toBeNull();
  });

  it("stores only a digest, exposes safe installation metadata, and accepts only the correct org/header", async () => {
    const orgId = await organization();
    const otherOrg = await organization();
    const created = await issue(orgId);
    expect(created.key).toMatch(/^sp_[0-9a-f]{64}$/);
    expect(await authenticateBridgeRequest(env.DB, request(created.key), orgId, now)).toEqual({
      orgId, installationId: created.installationId, credentialId: created.credentialId, expiresAt: null,
    });
    expect(await authenticateBridgeRequest(env.DB, request(created.key), otherOrg, now)).toBeNull();
    expect(await authenticateBridgeRequest(env.DB, request("wrong-key"), orgId, now)).toBeNull();
    for (const parameter of ["key", "apiKey", "api-key", "authBridgeKey"]) {
      expect(await authenticateBridgeRequest(env.DB, request(undefined, `&${parameter}=${created.key}`), orgId, now)).toBeNull();
      expect(await authenticateBridgeRequest(env.DB, request(created.key, `&${parameter}=anything`), orgId, now)).toBeNull();
    }
    expect(await listBridgeInstallations(env.DB, orgId)).toEqual([{
      id: created.installationId, label: "Main venue", createdAt: now, lastUsedAt: null, revokedAt: null,
    }]);
    expect(await listBridgeInstallations(env.DB, otherOrg)).toEqual([]);
    const rows = await storedRows(orgId);
    expect(JSON.stringify(rows)).not.toContain(created.key);
    expect(rows[1]).toMatchObject([{ keyHash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it("keeps old and new versions valid during a bounded overlap, without extending older versions", async () => {
    const orgId = await organization();
    const original = await issue(orgId);
    const first = await rotateBridgeInstallation(env.DB, actor(orgId, original.installationId), now + 100);
    const second = await rotateBridgeInstallation(env.DB, actor(orgId, original.installationId), now + 200);
    expect(first.key).not.toBe(original.key);
    const oldDeadline = now + 100 + BRIDGE_ROTATION_OVERLAP_MS;
    expect(await authenticateBridgeRequest(env.DB, request(original.key), orgId, oldDeadline - 1)).not.toBeNull();
    expect(await getBridgeCredentialAuthority(env.DB, orgId, original.credentialId, oldDeadline)).toBeNull();
    expect(await authenticateBridgeRequest(env.DB, request(first.key), orgId, oldDeadline)).not.toBeNull();
    expect(await authenticateBridgeRequest(env.DB, request(first.key), orgId, oldDeadline + 100)).toBeNull();
    expect(await authenticateBridgeRequest(env.DB, request(second.key), orgId, oldDeadline + 100)).not.toBeNull();
    expect(JSON.stringify(await storedRows(orgId))).not.toContain(first.key);
    expect(JSON.stringify(await storedRows(orgId))).not.toContain(second.key);
  });

  it("revokes every version of one installation while leaving other installations active", async () => {
    const orgId = await organization();
    const a = await issue(orgId, "Venue A");
    const b = await issue(orgId, "Venue B");
    const replacement = await rotateBridgeInstallation(env.DB, actor(orgId, a.installationId), now + 1);
    await revokeBridgeInstallation(env.DB, actor(orgId, a.installationId), now + 2);
    await revokeBridgeInstallation(env.DB, actor(orgId, a.installationId), now + 3);
    for (const key of [a.key, replacement.key]) expect(await authenticateBridgeRequest(env.DB, request(key), orgId, now + 4)).toBeNull();
    expect(await authenticateBridgeRequest(env.DB, request(b.key), orgId, now + 4)).not.toBeNull();
    await expect(rotateBridgeInstallation(env.DB, actor(orgId, a.installationId), now + 5)).rejects.toThrow("revoked");
    const audit = await env.DB.prepare("SELECT action FROM bridge_credential_audit WHERE orgId = ? AND action = 'revoked'").bind(orgId).all();
    expect(audit.results).toHaveLength(1);
  });

  it("cannot rotate, revoke, or record a write for another organization", async () => {
    const orgId = await organization();
    const otherOrg = await organization();
    const created = await issue(orgId);
    await expect(rotateBridgeInstallation(env.DB, actor(otherOrg, created.installationId), now)).rejects.toThrow("unavailable");
    await expect(revokeBridgeInstallation(env.DB, actor(otherOrg, created.installationId), now)).rejects.toThrow("unavailable");
    expect(await getBridgeCredentialAuthority(env.DB, otherOrg, created.credentialId, now)).toBeNull();
    expect(await recordBridgeWrite(env.DB, { orgId: otherOrg, installationId: created.installationId, credentialId: created.credentialId, expiresAt: null }, { action: "command", direction: "to-bridge" }, now)).toBe(false);
    expect(await authenticateBridgeRequest(env.DB, request(created.key), orgId, now)).not.toBeNull();
  });

  it("records each accepted write by key ID, tracks latest use, and rejects stale cached authority", async () => {
    const orgId = await organization();
    const created = await issue(orgId);
    const authority = await authenticateBridgeRequest(env.DB, request(created.key), orgId, now);
    if (!authority) throw new Error("Missing authority");
    expect(await recordBridgeWrite(env.DB, authority, { action: "device-event", direction: "from-bridge" }, now + 20)).toBe(true);
    expect(await recordBridgeWrite(env.DB, authority, { action: "command", direction: "to-bridge", actorUserId: "test-operator" }, now + 10)).toBe(true);
    expect((await listBridgeInstallations(env.DB, orgId))[0].lastUsedAt).toBe(now + 20);
    await revokeBridgeInstallation(env.DB, actor(orgId, created.installationId), now + 30);
    expect(await recordBridgeWrite(env.DB, authority, { action: "command", direction: "to-bridge" }, now + 40)).toBe(false);
    const writes = await env.DB.prepare("SELECT credentialId, action, actorUserId FROM bridge_credential_audit WHERE orgId = ? AND direction != 'credential' ORDER BY createdAt").bind(orgId).all();
    expect(writes.results).toEqual([
      { credentialId: created.credentialId, action: "command", actorUserId: "test-operator" },
      { credentialId: created.credentialId, action: "device-event", actorUserId: null },
    ]);
    expect(JSON.stringify(await storedRows(orgId))).not.toContain(created.key);
  });

  it("does not revive credentials when rotation races with revocation", async () => {
    const orgId = await organization();
    const created = await issue(orgId);
    const [rotation] = await Promise.allSettled([
      rotateBridgeInstallation(env.DB, actor(orgId, created.installationId), now + 10),
      revokeBridgeInstallation(env.DB, actor(orgId, created.installationId), now + 10),
    ]);
    expect(await authenticateBridgeRequest(env.DB, request(created.key), orgId, now + 20)).toBeNull();
    if (rotation.status === "fulfilled") expect(await authenticateBridgeRequest(env.DB, request(rotation.value.key), orgId, now + 20)).toBeNull();
    expect((await listBridgeInstallations(env.DB, orgId))[0].revokedAt).toBe(now + 10);
  });
});
