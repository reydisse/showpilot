import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { approveTestBridgeTarget, bridgeClientTestRequest, openTestBridge } from "@/test/bridge-fixtures";
import { CREDENTIAL_MASK } from "../credential-fields";

afterEach(() => abortAllDurableObjects());
const target = "venue.local:4455";
const secret = "never-publish-device-credential";
const settings = { password: secret, nested: { authToken: secret }, headers: { Authorization: `Bearer ${secret}` } };
const actor = { source: "operator" as const, actorUserId: "redaction-operator" };

function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", handler); reject(new Error(`No ${type} message`)); }, 2000);
    function handler(event: MessageEvent) {
      const data = JSON.parse(String(event.data));
      if (data.type !== type) return;
      clearTimeout(timer); socket.removeEventListener("message", handler); resolve(data);
    }
    socket.addEventListener("message", handler);
  });
}
async function client(orgId: string) {
  const response = await env.BRIDGE_RELAY.getByName(orgId).fetch(await bridgeClientTestRequest(orgId));
  if (!response.webSocket) throw new Error("Missing client socket");
  const ready = next(response.webSocket, "bridge-status");
  response.webSocket.accept(); await ready;
  return response.webSocket;
}

it("omits native settings from status and redacts event JSON before broadcasting, storing or hydrating it", async () => {
  const orgId = "redact-events";
  const { stub, socket } = await openTestBridge(orgId);
  const browser = await client(orgId);
  const status = next(browser, "device-status");
  socket.send(JSON.stringify({ type: "device-status", target, connected: true, settings, password: secret }));
  expect(await status).toEqual({ type: "device-status", target, connected: true });
  const event = next(browser, "device-event");
  socket.send(JSON.stringify({ type: "device-event", target, eventName: "state", data: JSON.stringify({ volume: 10, settings }), settings }));
  const published = await event;
  expect(Object.keys(published).sort()).toEqual(["data", "eventName", "target", "type"]);
  expect(JSON.stringify(published)).not.toContain(secret);
  expect(JSON.parse(String(published.data))).toEqual({ volume: 10, settings: { password: CREDENTIAL_MASK, nested: { authToken: CREDENTIAL_MASK }, headers: { Authorization: CREDENTIAL_MASK } } });
  expect(JSON.stringify(await stub.getBridgeStatus())).not.toContain(secret);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(JSON.stringify(state.getWebSockets().map(ws => ws.deserializeAttachment()))).not.toContain(secret);
  });
  await evictDurableObject(stub);
  expect(JSON.stringify(await stub.getBridgeStatus())).not.toContain(secret);
  const response = await stub.fetch(await bridgeClientTestRequest(orgId));
  if (!response.webSocket) throw new Error("Missing hydrate socket");
  const hydrate = next(response.webSocket, "bridge-status"); response.webSocket.accept();
  expect(JSON.stringify(await hydrate)).not.toContain(secret);
});

it("removes credentials from legacy event attachments when a hibernated relay restarts", async () => {
  const orgId = "redact-old-attachment";
  const { stub } = await openTestBridge(orgId);
  await runInDurableObject(stub, async (_instance, state) => {
    for (const socket of state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment.role !== "bridge") continue;
      socket.serializeAttachment({ ...attachment, arbitrarySettings: settings, bridgeInfo: { connectedTargets: [target], deviceEvents: { [target]: { eventName: "state", data: JSON.stringify(settings), receivedAt: Date.now() } } } });
    }
  });
  await evictDurableObject(stub);
  expect(JSON.stringify(await stub.getBridgeStatus())).not.toContain(secret);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(JSON.stringify(state.getWebSockets().map(ws => ws.deserializeAttachment()))).not.toContain(secret);
  });
});

it("redacts internal RPC command results and sends only public reply fields to the requesting browser", async () => {
  const orgId = "redact-command-result";
  const { stub, socket } = await openTestBridge(orgId);
  await approveTestBridgeTarget(orgId, "obs", target);
  const command = { type: "command" as const, id: "rpc-redaction", protocol: "obs" as const, target, command: "fixture" };
  const forwarded = next(socket, "command");
  const rpc = stub.dispatchBridgeMessage(command, actor);
  await forwarded;
  socket.send(JSON.stringify({ type: "command-response", id: command.id, success: true, response: JSON.stringify({ enabled: true, settings }), settings }));
  const result = await rpc;
  expect(result.success).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.parse(result.response ?? "{}")).toHaveProperty("enabled", true);

  const browser = await client(orgId);
  const browserForwarded = next(socket, "command");
  browser.send(JSON.stringify({ ...command, id: "browser-redaction" }));
  const operation = await browserForwarded;
  const reply = next(browser, "command-response");
  socket.send(JSON.stringify({ type: "command-response", id: operation.id, success: false, error: JSON.stringify({ message: "Connection refused", settings }), password: secret, settings }));
  const message = await reply;
  expect(Object.keys(message).sort()).toEqual(["error", "id", "success", "type"]);
  expect(message.id).toBe("browser-redaction");
  expect(message.success).toBe(false);
  expect(JSON.stringify(message)).not.toContain(secret);
  expect(JSON.parse(String(message.error))).toHaveProperty("message", "Connection refused");
});
