import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { approveTestBridgeTarget, bridgeClientTestRequest, openTestBridge } from "@/test/bridge-fixtures";
import { listBridgeTargets, removeBridgeTarget } from "../bridge-targets.server";

afterEach(() => abortAllDurableObjects());
const actor = { source: "operator" as const, actorUserId: "rpc-operator" };
const command = { type: "command" as const, id: "fixture", protocol: "obs" as const, target: "venue.local:4455", command: "fixture-action" };
function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(String(event.data));
      if (data.type !== type) return;
      socket.removeEventListener("message", handler); resolve(data);
    };
    socket.addEventListener("message", handler);
  });
}
async function client(orgId: string) {
  const response = await env.BRIDGE_RELAY.getByName(orgId).fetch(await bridgeClientTestRequest(orgId));
  if (!response.webSocket) throw new Error("Missing browser socket");
  const ready = next(response.webSocket, "bridge-status");
  response.webSocket.accept(); await ready;
  return response.webSocket;
}

describe("live Bridge target enforcement", () => {
  it("rejects unapproved commands on RPC and browser paths before sending any device command", async () => {
    const orgId = "target-live-deny";
    const { stub, socket } = await openTestBridge(orgId);
    const sent: unknown[] = [];
    socket.addEventListener("message", event => sent.push(JSON.parse(String(event.data))));
    const browser = await client(orgId);
    expect(await stub.dispatchBridgeMessage(command, actor)).toMatchObject({ success: false, error: expect.stringContaining("not approved") });
    const rejected = next(browser, "command-response");
    browser.send(JSON.stringify({ ...command, actorUserId: "forged" }));
    expect(await rejected).toMatchObject({ id: "fixture", success: false, error: expect.stringContaining("not approved") });
    expect(sent).toEqual([]);
    const audit = await env.DB.prepare("SELECT actorUserId, host, port, protocol FROM bridge_target_audit WHERE orgId = ? AND action = 'rejected' ORDER BY rowid").bind(orgId).all();
    expect(audit.results).toEqual([actor.actorUserId, `${orgId}-operator`].map(actorUserId => ({ actorUserId, host: "venue.local", port: 4455, protocol: "obs" })));
  });

  it("routes approved commands and rejects subsequent commands immediately after removal", async () => {
    const orgId = "target-live-revoke";
    const { stub, socket } = await openTestBridge(orgId);
    await approveTestBridgeTarget(orgId, "obs", command.target);
    const forwarded = next(socket, "command");
    const result = stub.dispatchBridgeMessage(command, actor);
    expect(await forwarded).toEqual(command);
    socket.send(JSON.stringify({ type: "command-response", id: command.id, success: true, response: "done" }));
    expect(await result).toEqual({ success: true, response: "done" });
    const [approved] = await listBridgeTargets(env.DB, orgId);
    await removeBridgeTarget(env.DB, { orgId, id: approved.id, actorUserId: "admin" });
    expect(await stub.dispatchBridgeMessage(command, actor)).toMatchObject({ success: false, error: expect.stringContaining("not approved") });
  });

  it("rejects connection-setting overrides and missing secondary PP approval without forwarding credentials", async () => {
    const orgId = "target-live-settings";
    const { stub, socket } = await openTestBridge(orgId);
    const sent: unknown[] = [];
    socket.addEventListener("message", event => sent.push(JSON.parse(String(event.data))));
    await approveTestBridgeTarget(orgId, "obs", command.target);
    const bad = { type: "connect-device" as const, protocol: "obs" as const, target: command.target, settings: { host: "another.local", port: 4455, password: "do-not-forward-secret" } };
    expect(await stub.dispatchBridgeMessage(bad, actor)).toMatchObject({ success: false, error: expect.stringContaining("cannot override") });
    await approveTestBridgeTarget(orgId, "propresenter", "propresenter:venue.local:50001", { apiPort: 50001 });
    expect(await stub.dispatchBridgeMessage({ type: "connect-device", protocol: "propresenter", target: "propresenter:venue.local:50001", settings: { password: "do-not-forward-secret" } }, actor)).toMatchObject({ success: false, error: expect.stringContaining("not approved") });
    expect(sent).toEqual([]);
    const audit = await env.DB.prepare("SELECT * FROM bridge_target_audit WHERE orgId = ?").bind(orgId).all();
    expect(JSON.stringify(audit)).not.toContain("do-not-forward-secret");
  });

  it("records the authenticated browser's connection attempt and strips supplied attribution fields", async () => {
    const orgId = "target-live-actor";
    const { socket } = await openTestBridge(orgId);
    const browser = await client(orgId);
    await approveTestBridgeTarget(orgId, "obs", command.target);
    const forwarded = next(socket, "connect-device");
    const connect = { type: "connect-device", protocol: "obs", target: command.target, settings: {} };
    browser.send(JSON.stringify({ ...connect, actorUserId: "forged", source: "automation", extra: "not-forwarded" }));
    expect(await forwarded).toEqual(connect);
    const audit = await env.DB.prepare("SELECT actorUserId, source, executionId FROM bridge_target_audit WHERE orgId = ? AND action = 'connection-requested'").bind(orgId).all();
    expect(audit.results).toEqual([{ actorUserId: `${orgId}-operator`, source: "operator", executionId: null }]);
  });
});
