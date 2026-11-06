import { describe, expect, it } from "vitest";
import { CredentialVault, CredentialVaultError, type CredentialScope } from "../credential-vault.server";
import { CREDENTIAL_MASK, isCredentialField, maskedCredential } from "../credential-fields";

const oldKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(41)));
const newKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(73)));
const oldSecret = JSON.stringify({ active: "old", keys: { old: oldKey } });
const rotationSecret = JSON.stringify({ active: "new", keys: { old: oldKey, new: newKey } });
const newSecret = JSON.stringify({ active: "new", keys: { new: newKey } });
const setting: CredentialScope = { kind: "setting", orgId: "org-a", key: "propresenter-password" };
const device: CredentialScope = { kind: "device", orgId: "org-a", deviceId: "projector-1", path: ["password"] };
const password = "a-real-test-credential-🔒";

function modifyEnvelope(stored: string, mutate: (value: Record<string, string>) => void): string {
  const prefix = "spenc:v1:";
  const envelope: Record<string, string> = JSON.parse(atob(stored.slice(prefix.length)));
  mutate(envelope);
  return prefix + btoa(JSON.stringify(envelope));
}
function flipBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  bytes[0] ^= 1;
  return btoa(String.fromCharCode(...bytes));
}

describe("credential envelopes in the Worker runtime", () => {
  it("uses fresh envelopes for equal values while preserving exact Unicode credentials", async () => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    const [first, second] = await Promise.all([vault.encrypt(setting, password), vault.encrypt(setting, password)]);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(first).not.toContain(oldKey);
    expect(await vault.decrypt(setting, first)).toBe(password);
    expect(await vault.decrypt(setting, second)).toBe(password);
  });

  it.each([
    { ...device, orgId: "org-b" },
    { ...device, deviceId: "projector-2" },
    { ...device, path: ["authToken"] },
    { ...device, path: ["headers", "Authorization"] },
    { kind: "setting", orgId: "org-a", key: "password" },
  ] satisfies CredentialScope[])("rejects ciphertext copied into another identity: %j", async scope => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    const stored = await vault.encrypt(device, password);
    await expect(vault.decrypt(scope, stored)).rejects.toThrow(CredentialVaultError);
    expect(await vault.decrypt(device, stored)).toBe(password);
  });

  it("does not conflate a dotted field with a nested field, or a different setting key", async () => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    const stored = await vault.encrypt({ ...device, path: ["headers.Authorization"] }, password);
    await expect(vault.decrypt({ ...device, path: ["headers", "Authorization"] }, stored)).rejects.toThrow(CredentialVaultError);
    const settingValue = await vault.encrypt(setting, password);
    await expect(vault.decrypt({ ...setting, key: "slack-token" }, settingValue)).rejects.toThrow(CredentialVaultError);
  });

  it.each(["wrapIv", "wrappedKey", "valueIv", "ciphertext"])("authenticates every envelope part: %s", async field => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    const stored = await vault.encrypt(setting, password);
    await expect(vault.decrypt(setting, modifyEnvelope(stored, value => { value[field] = flipBase64(value[field]); }))).rejects.toThrow(CredentialVaultError);
  });

  it("supports key rotation before old-key removal, and fails closed when an old key is missing", async () => {
    const before = await CredentialVault.fromSecret(oldSecret);
    const during = await CredentialVault.fromSecret(rotationSecret);
    const after = await CredentialVault.fromSecret(newSecret);
    const original = await before.encrypt(setting, password);
    expect(await during.decrypt(setting, original)).toBe(password);
    const rotated = await during.reencrypt(setting, original);
    expect(await after.decrypt(setting, rotated)).toBe(password);
    await expect(after.decrypt(setting, original)).rejects.toThrow(CredentialVaultError);
    await expect(before.decrypt(setting, rotated)).rejects.toThrow(CredentialVaultError);
  });

  it("rejects key substitution even when two key IDs contain identical key bytes", async () => {
    const vault = await CredentialVault.fromSecret(JSON.stringify({ active: "old", keys: { old: oldKey, alias: oldKey } }));
    const stored = await vault.encrypt(setting, password);
    await expect(vault.decrypt(setting, modifyEnvelope(stored, value => { value.keyId = "alias"; }))).rejects.toThrow(CredentialVaultError);
  });

  it("rejects missing, malformed, weak and unavailable active keys without including their values in errors", async () => {
    for (const configuration of [undefined, "", password, "{}", JSON.stringify({ active: "old", keys: { old: "weak-key" } }), JSON.stringify({ active: "missing", keys: { old: oldKey } }), JSON.stringify({ active: "old", keys: { old: oldKey }, extra: password })]) {
      try {
        await CredentialVault.fromSecret(configuration);
        expect.fail("Invalid keyring accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialVaultError);
        expect(String(error)).not.toContain(oldKey);
        expect(String(error)).not.toContain(password);
        expect(String(error)).toContain("CREDENTIAL_ENCRYPTION_KEYS");
      }
    }
  });

  it("rejects malformed, unknown-version and plaintext envelopes without leaking their content", async () => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    for (const stored of [password, "spenc:v2:" + password, "spenc:v1:" + password, "spenc:v1:" + btoa("{}"), "spenc:v1:" + btoa(JSON.stringify({ keyId: "old", ciphertext: "not-a-valid-value" }))]) {
      await expect(vault.decrypt(setting, stored)).rejects.toThrow("Stored credential could not be decrypted");
    }
    await expect(vault.encrypt({ ...setting, orgId: "" }, password)).rejects.toThrow("identity");
    await expect(vault.encrypt({ ...device, path: [] }, password)).rejects.toThrow("identity");
  });

  it("keeps, replaces and clears intentionally; keep migrates legacy values but never preserves corrupted ciphertext", async () => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    const stored = await vault.applyChange(setting, password, { action: "keep" });
    expect(stored).not.toBe(password);
    expect(await vault.decrypt(setting, stored)).toBe(password);
    expect(await vault.applyChange(setting, stored, { action: "keep" })).toBe(stored);
    expect(await vault.applyChange(setting, null, { action: "keep" })).toBe("");
    const replacement = await vault.applyChange(setting, stored, { action: "replace", value: "new-value" });
    expect(await vault.decrypt(setting, replacement)).toBe("new-value");
    expect(await vault.applyChange(setting, replacement, { action: "clear" })).toBe("");
    const corrupt = modifyEnvelope(stored, value => { value.ciphertext = flipBase64(value.ciphertext); });
    await expect(vault.applyChange(setting, corrupt, { action: "keep" })).rejects.toThrow(CredentialVaultError);
  });

  it("cannot save a mask, empty replacement or envelope as if it were a new password", async () => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    const stored = await vault.encrypt(setting, password);
    for (const value of [CREDENTIAL_MASK, "", stored, "spenc:v2:example"]) {
      await expect(vault.applyChange(setting, null, { action: "replace", value })).rejects.toThrow(CredentialVaultError);
    }
  });

  it("bounds UTF-8 bytes and can recover a maximum-sized value", async () => {
    const vault = await CredentialVault.fromSecret(oldSecret);
    const value = "x".repeat(200_000);
    expect(await vault.decrypt(setting, await vault.encrypt(setting, value))).toBe(value);
    await expect(vault.encrypt(setting, "🔒".repeat(50_001))).rejects.toThrow("too large");
  });
});

describe("credential field policy", () => {
  it("recognizes current integration credentials, device passwords and nested auth headers", () => {
    for (const name of ["slack-token", "slack-signing-secret", "mattermost-token", "discord-bot-token", "propresenter-password", "teams-webhook-url", "webhook-url", "password", "authToken", "accessToken", "api_key", "Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie"]) {
      expect(isCredentialField(name), name).toBe(true);
    }
    for (const name of ["propresenter-host", "propresenter-api-port", "ontime-url", "slack-channel", "tokenCount", "port", "headers", "active-show-id"]) {
      expect(isCredentialField(name), name).toBe(false);
    }
    expect(maskedCredential(password)).toBe(CREDENTIAL_MASK);
    expect(maskedCredential("")).toBe("");
  });
});
