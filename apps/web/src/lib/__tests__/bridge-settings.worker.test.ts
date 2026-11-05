import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeSettingsRecipient, sealBridgeSettings, importBridgeSettingsKey } from "@showpilot/shared/bridge-settings";

const context = { orgId: "fixture-org", installationId: "main-room", protocol: "obs", target: "venue.local:4455" };
const settings = { password: "never-on-the-wire", headers: { Authorization: "Bearer hidden" }, scene: "Opening" };
afterEach(() => vi.restoreAllMocks());

describe("Worker protected Bridge settings", () => {
  it("encrypts full nested settings with fresh keys and nonces and decrypts them only once", async () => {
    const recipient = await createBridgeSettingsRecipient();
    const first = await sealBridgeSettings(recipient.publicKey, context, settings);
    const second = await sealBridgeSettings(recipient.publicKey, context, settings);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toMatch(/never-on-the-wire|hidden|Opening|password|Authorization/);
    expect(await recipient.open(first, context)).toEqual(settings);
    await expect(recipient.open(first, context)).rejects.toThrow("invalid, expired or unavailable");
    expect(await recipient.open(second, context)).toEqual(settings);
    expect(Object.keys(recipient).sort()).toEqual(["open", "publicKey"]);
  });

  it.each(["orgId", "installationId", "protocol", "target"] as const)("rejects transfer to another %s", async key => {
    const recipient = await createBridgeSettingsRecipient();
    const sealed = await sealBridgeSettings(recipient.publicKey, context, settings);
    await expect(recipient.open(sealed, { ...context, [key]: "other" })).rejects.toThrow();
    expect(await recipient.open(sealed, context)).toEqual(settings);
  });

  it("rejects other recipients, tampering, invalid versions and plaintext fallback", async () => {
    const recipient = await createBridgeSettingsRecipient();
    const other = await createBridgeSettingsRecipient();
    const sealed = await sealBridgeSettings(recipient.publicKey, context, settings);
    await expect(other.open(sealed, context)).rejects.toThrow();
    await expect(recipient.open(settings, context)).rejects.toThrow();
    for (const modified of [
      { ...sealed, version: 2 }, { ...sealed, nonce: crypto.randomUUID() },
      { ...sealed, expiresAt: sealed.expiresAt + 1 }, { ...sealed, iv: "invalid" },
      { ...sealed, ciphertext: btoa("x".repeat(32)) },
      { ...sealed, wrappedKey: btoa("x".repeat(256)) },
    ]) await expect(recipient.open(modified, context)).rejects.toThrow();
    expect(await recipient.open(sealed, context)).toEqual(settings);
  });

  it("rejects expired payloads and concurrent replay", async () => {
    const recipient = await createBridgeSettingsRecipient();
    const sealed = await sealBridgeSettings(recipient.publicKey, context, settings);
    const time = vi.spyOn(Date, "now").mockReturnValue(sealed.expiresAt);
    await expect(recipient.open(sealed, context)).rejects.toThrow();
    time.mockRestore();
    const attempts = await Promise.allSettled([recipient.open(sealed, context), recipient.open(sealed, context)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("limits input size and refuses unsupported public keys without including secrets in errors", async () => {
    for (const invalid of [undefined, "private-key", "a".repeat(10000), btoa("not-spki")]) {
      await expect(importBridgeSettingsKey(invalid)).rejects.toThrow("Protected Bridge settings are invalid");
    }
    const recipient = await createBridgeSettingsRecipient();
    await expect(sealBridgeSettings(recipient.publicKey, context, { password: "secret".repeat(40000) })).rejects.toThrow("Protected Bridge settings are invalid");
    const weak = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
    const spki = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", weak.publicKey))));
    await expect(importBridgeSettingsKey(spki)).rejects.toThrow();
  });
});
