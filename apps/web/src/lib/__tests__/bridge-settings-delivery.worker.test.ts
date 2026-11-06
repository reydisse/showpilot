import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { openTestBridge, approveTestBridgeTarget, bridgeClientTestRequest } from "@/test/bridge-fixtures";

afterEach(() => abortAllDurableObjects());
const target = "venue.local:4455";
const settings = { password: "private-obs-password", nested: { authToken: "private-nested-token" }, scene: "Opening" };
const actor = { source: "operator" as const, actorUserId: "operator-fixture" };
function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", handler); reject(new Error(`Missing ${type}`)); }, 3000);
    function handler(event: MessageEvent) {
      const message = JSON.parse(String(event.data));
      if (message.type !== type) return;
      clearTimeout(timer); socket.removeEventListener("message", handler); resolve(message);
    }
    socket.addEventListener("message", handler);
  });
}
async function browser(orgId: string) {
  const response = await env.BRIDGE_RELAY.getByName(orgId).fetch(await bridgeClientTestRequest(orgId));
  if (!response.webSocket) throw new Error("No browser socket");
  const ready = next(response.webSocket, "bridge-status"); response.webSocket.accept(); await ready;
  return response.webSocket;
}

it("delivers RPC settings only in a recipient-encrypted envelope, including after hibernation", async () => {
  const orgId = "protected-rpc";
  const bridge = await openTestBridge(orgId);
  await approveTestBridgeTarget(orgId, "obs", target);
  const client = await browser(orgId);
  const publicMessages: unknown[] = [];
  client.addEventListener("message", event => { publicMessages.push(JSON.parse(String(event.data))); });
  for (const hibernate of [false, true]) {
    if (hibernate) await evictDurableObject(bridge.stub);
    const wire = next(bridge.socket, "connect-device");
    const request = bridge.stub.dispatchBridgeMessage({ type: "connect-device", protocol: "obs", target, settings }, actor);
    const message = await wire;
    expect(Object.keys(message).sort()).toEqual(["protectedSettings", "protocol", "target", "type"]);
    expect(JSON.stringify(message)).not.toMatch(/private-obs-password|private-nested-token|Opening|password|authToken/);
    expect(await bridge.recipient.open(message.protectedSettings, { orgId, installationId: bridge.credential.installationId, protocol: "obs", target })).toEqual(settings);
    const status = next(client, "device-status");
    bridge.socket.send(JSON.stringify({ type: "device-status", target, connected: true }));
    expect(await request).toEqual({ success: true });
    await status;
  }
  expect(JSON.stringify(publicMessages)).not.toMatch(/private-|protectedSettings|ciphertext/);
  expect(JSON.stringify(await bridge.stub.getBridgeStatus())).not.toContain("private-");
  await runInDurableObject(bridge.stub, async (_instance, state) => {
    const attachments = JSON.stringify(state.getWebSockets().map(socket => socket.deserializeAttachment()));
    expect(attachments).not.toMatch(/private-|ciphertext|wrappedKey/);
  });
  const audit = await env.DB.prepare("SELECT * FROM bridge_target_audit WHERE orgId = ?").bind(orgId).all();
  expect(JSON.stringify(audit)).not.toContain("private-");
});

it("protects browser connection settings for the selected installation only", async () => {
  const orgId = "protected-browser-takeover";
  const first = await openTestBridge(orgId);
  const second = await openTestBridge(orgId);
  await approveTestBridgeTarget(orgId, "obs", target);
  const client = await browser(orgId);
  await first.stub.selectInstallation({ orgId, installationId: second.credential.installationId, expectedActiveInstallationId: first.credential.installationId, actorUserId: "owner" });
  const firstTraffic: unknown[] = [];
  first.socket.addEventListener("message", event => { firstTraffic.push(JSON.parse(String(event.data))); });
  const wire = next(second.socket, "connect-device");
  client.send(JSON.stringify({ type: "connect-device", protocol: "obs", target, settings, protectedSettings: { forged: true } }));
  const message = await wire;
  expect(JSON.stringify(message)).not.toMatch(/private-|forged/);
  const context = { orgId, installationId: second.credential.installationId, protocol: "obs", target };
  await expect(first.recipient.open(message.protectedSettings, context)).rejects.toThrow();
  expect(await second.recipient.open(message.protectedSettings, context)).toEqual(settings);
  expect(firstTraffic).toEqual([]);
});

it("requires a valid settings public key on upgrade and discards restored sockets without one", async () => {
  const orgId = "protected-key-required";
  const bridge = await openTestBridge(orgId);
  const url = `https://bridge.test/ws?${new URLSearchParams({ orgId, role: "bridge", authCredentialId: bridge.credential.credentialId })}`;
  for (const key of [undefined, "not-a-key"]) {
    const headers = new Headers({ Upgrade: "websocket", "x-showpilot-bridge-policy": "3", "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" });
    if (key) headers.set("x-showpilot-settings-key", key);
    const rejected = await bridge.stub.fetch(new Request(url, { headers }));
    expect(rejected.status).toBe(426);
    expect(await rejected.text()).toContain("valid native device settings key");
  }
  await runInDurableObject(bridge.stub, async (_instance, state) => {
    for (const socket of state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      delete attachment.settingsPublicKey;
      socket.serializeAttachment(attachment);
    }
  });
  const closed = new Promise<number>(resolve => bridge.socket.addEventListener("close", event => resolve(event.code), { once: true }));
  await evictDurableObject(bridge.stub);
  expect((await bridge.stub.getBridgeStatus()).bridgeOnline).toBe(false);
  expect(await closed).toBe(4406);
});
