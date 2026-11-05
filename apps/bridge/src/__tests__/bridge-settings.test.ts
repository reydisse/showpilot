import { expect, it } from "vitest";
import { createBridgeSettingsRecipient, sealBridgeSettings } from "@showpilot/shared/bridge-settings";

it("uses Node WebCrypto for scoped native settings and rejects replay or a replacement connection's key", async () => {
  const native = await createBridgeSettingsRecipient();
  const replacement = await createBridgeSettingsRecipient();
  const context = { orgId: "org", installationId: "native", protocol: "pjlink", target: "127.0.0.1:4352" };
  const secret = { password: "private-fixture-password" };
  const message = await sealBridgeSettings(native.publicKey, context, secret);
  expect(JSON.stringify(message)).not.toContain(secret.password);
  await expect(replacement.open(message, context)).rejects.toThrow();
  await expect(native.open(message, { ...context, target: "127.0.0.2:4352" })).rejects.toThrow();
  expect(await native.open(message, context)).toEqual(secret);
  await expect(native.open(message, context)).rejects.toThrow();
});
