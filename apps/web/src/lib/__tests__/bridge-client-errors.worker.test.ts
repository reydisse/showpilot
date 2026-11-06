import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { approveTestBridgeTarget, bridgeClientTestRequest, ensureBridgeTestOrg, openTestBridge } from "@/test/bridge-fixtures";
import { revokeBridgeInstallation } from "@/lib/bridge-credentials.server";

afterEach(() => abortAllDurableObjects());
function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", handler); reject(new Error(`Missing ${type}`)); }, 3000);
    function handler(event: MessageEvent) {
      const msg = JSON.parse(String(event.data)); if (msg.type !== type) return;
      clearTimeout(timer); socket.removeEventListener("message", handler); resolve(msg);
    }
    socket.addEventListener("message", handler);
  });
}
async function client(orgId: string) {
  await ensureBridgeTestOrg(orgId);
  const stub = env.BRIDGE_RELAY.getByName(orgId);
  const response = await stub.fetch(await bridgeClientTestRequest(orgId));
  if (!response.webSocket) throw new Error("Missing fixture browser");
  const ready = next(response.webSocket, "bridge-status"); response.webSocket.accept(); await ready;
  return response.webSocket;
}
const operations = [
  { type: "connect-device", protocol: "obs", target: "venue.local:4455", settings: {}, reply: "device-status" },
  { type: "ping", id: "ping-fixture", reply: "ping-response" },
] as const;

it.each(operations)("replies to an offline $type immediately", async operation => {
  const socket = await client(`offline-${operation.type}`);
  const response = next(socket, operation.reply);
  socket.send(JSON.stringify(operation));
  expect(await response).toMatchObject({ type: operation.reply, success: false, error: "Bridge is offline" });
});

it.each(operations)("reports revoked authority for $type", async operation => {
  const orgId = `revoked-${operation.type}`; const bridge = await openTestBridge(orgId); const socket = await client(orgId);
  await revokeBridgeInstallation(env.DB, { orgId, installationId: bridge.credential.installationId, actorUserId: "owner" });
  const response = next(socket, operation.reply); socket.send(JSON.stringify(operation));
  expect(await response).toMatchObject({ success: false, error: "Venue Bridge credential expired or was revoked" });
});

it.each(operations)("returns a $type send failure only to the requester", async operation => {
  const orgId = `failed-send-${operation.type}`; const bridge = await openTestBridge(orgId);
  await approveTestBridgeTarget(orgId, "obs", "venue.local:4455");
  const requester = await client(orgId);
  await runInDurableObject(bridge.stub, async (_instance, state) => {
    const browser = state.getWebSockets().find(socket => socket.deserializeAttachment()?.role === "client");
    if (!browser) throw new Error("Missing requester");
    browser.serializeAttachment({ ...browser.deserializeAttachment(), fixtureRequester: true });
  });
  const observer = await client(orgId);
  const others: unknown[] = []; observer.addEventListener("message", event => { others.push(JSON.parse(String(event.data))); });
  const response = next(requester, operation.reply);
  await runInDurableObject(bridge.stub, async (instance, state) => {
    const native = state.getWebSockets().find(socket => socket.deserializeAttachment()?.role === "bridge");
    const browser = state.getWebSockets().find(socket => socket.deserializeAttachment()?.fixtureRequester === true);
    if (!native || !browser) throw new Error("Missing accepted fixture sockets");
    const send = vi.spyOn(native, "send").mockImplementation(() => { throw new Error("fixture private send failure"); });
    try { await instance.webSocketMessage(browser, JSON.stringify(operation)); expect(send).toHaveBeenCalled(); }
    finally { send.mockRestore(); }
  });
  const result = await response;
  expect(result).toMatchObject({ type: operation.reply, success: false });
  expect(result.error).toMatch(/could not be delivered|Bridge disconnected/);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(others).toEqual([]);
});
