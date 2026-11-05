import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTestBridge, approveTestBridgeTarget, bridgeClientTestRequest } from "@/test/bridge-fixtures";
import { revokeBridgeInstallation } from "../bridge-credentials.server";

afterEach(async () => { vi.restoreAllMocks(); await abortAllDurableObjects(); });

type ConnectedBridge = Awaited<ReturnType<typeof openTestBridge>>;
function message(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const handler = (event: MessageEvent) => {
      const parsed = JSON.parse(String(event.data));
      if (parsed.type !== type) return;
      socket.removeEventListener("message", handler);
      resolve(parsed);
    };
    socket.addEventListener("message", handler);
  });
}
async function callSelect(stub: ConnectedBridge["stub"], input: Parameters<ConnectedBridge["stub"]["selectInstallation"]>[0]) {
  return await stub.selectInstallation(input);
}
function select(orgId: string, active: ConnectedBridge, next: ConnectedBridge) {
  return callSelect(active.stub, { orgId, installationId: next.credential.installationId, expectedActiveInstallationId: active.credential.installationId, actorUserId: "test-owner" });
}
function ack(socket: WebSocket, selectionId: unknown) {
  socket.send(JSON.stringify({ type: "bridge-role-applied", role: "standby", selectionId }));
}
async function close(bridge: ConnectedBridge) {
  const closed = new Promise(resolve => bridge.socket.addEventListener("close", resolve, { once: true }));
  bridge.socket.close(1000, "test shutdown");
  await closed;
}

describe("Bridge installation ownership", () => {
  it("preserves named selection through hibernation and never promotes standby on disconnect", async () => {
    const orgId = "bridge-selection-hibernation";
    const first = await openTestBridge(orgId);
    const second = await openTestBridge(orgId);
    await select(orgId, first, second);
    await evictDurableObject(first.stub);
    expect(await first.stub.getBridgeStatus()).toMatchObject({
      activeInstallation: { installationId: second.credential.installationId },
      connections: expect.arrayContaining([
        expect.objectContaining({ installationId: first.credential.installationId, role: "standby" }),
        expect.objectContaining({ installationId: second.credential.installationId, role: "active" }),
      ]),
    });
    await close(second);
    await expect.poll(async () => (await first.stub.getBridgeStatus()).bridgeOnline).toBe(false);
    await close(first);
    await evictDurableObject(first.stub);
    const standby = await openTestBridge(orgId, first.credential);
    expect(await standby.stub.getBridgeStatus()).toMatchObject({ bridgeOnline: false, activeInstallation: { installationId: second.credential.installationId }, connections: [{ role: "standby" }] });
    const reconnected = await openTestBridge(orgId, second.credential);
    expect(await reconnected.stub.getBridgeStatus()).toMatchObject({ bridgeOnline: true, activeInstallation: { installationId: second.credential.installationId } });
  });

  it("rejects duplicate connections without displacing the original installation", async () => {
    const orgId = "bridge-selection-duplicate";
    const active = await openTestBridge(orgId);
    const response = await active.stub.fetch(new Request(`https://bridge.test/ws?${new URLSearchParams({ orgId, role: "bridge", authCredentialId: active.credential.credentialId })}`, {
      headers: { Upgrade: "websocket", "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" },
    }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.accept();
    expect(await closed).toMatchObject({ code: 4410 });
    expect(active.socket.readyState).toBe(WebSocket.OPEN);
    expect((await active.stub.getBridgeStatus()).connections).toHaveLength(1);
  });

  it("waits for the old socket's exact acknowledgment and rejects a revoked target after the wait", async () => {
    const orgId = "bridge-selection-ack";
    const first = await openTestBridge(orgId);
    const second = await openTestBridge(orgId);
    first.setRoleAcknowledgment(false);
    const demotion = message(first.socket, "bridge-role");
    let finished = false;
    const selected = select(orgId, first, second).then(result => { finished = true; return result; });
    const rejection = expect(selected).rejects.toThrow("credential is unavailable");
    const request = await demotion;
    ack(second.socket, request.selectionId); // Right nonce, wrong socket.
    ack(first.socket, "not-the-issued-nonce");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(finished).toBe(false);
    await revokeBridgeInstallation(env.DB, { orgId, installationId: second.credential.installationId, actorUserId: "owner" });
    const restored = message(first.socket, "bridge-role");
    ack(first.socket, request.selectionId);
    await rejection;
    expect(await restored).toMatchObject({ role: "active" });
    expect(await first.stub.getBridgeStatus()).toMatchObject({ activeInstallation: { installationId: first.credential.installationId }, bridgeOnline: true });
  });

  it("requires old agents to acknowledge standby before takeover", async () => {
    const orgId = "bridge-selection-legacy";
    const first = await openTestBridge(orgId);
    const second = await openTestBridge(orgId);
    first.setRoleAcknowledgment(false);
    await expect(select(orgId, first, second)).rejects.toThrow("did not confirm standby");
    expect(await first.stub.getBridgeStatus()).toMatchObject({ activeInstallation: { installationId: first.credential.installationId }, bridgeOnline: true });
  }, 10_000);

  it("restores the old role if publishing the new selection fails", async () => {
    const orgId = "bridge-selection-storage-failure";
    const first = await openTestBridge(orgId);
    const second = await openTestBridge(orgId);
    await runInDurableObject(first.stub, async (instance, state) => {
      const put = vi.spyOn(state.storage, "put").mockRejectedValueOnce(new Error("fixture storage unavailable"));
      try {
        await expect(instance.selectInstallation({ orgId, installationId: second.credential.installationId, expectedActiveInstallationId: first.credential.installationId, actorUserId: "owner" })).rejects.toThrow("fixture storage unavailable");
      } finally { put.mockRestore(); }
      expect(await state.storage.get("active-installation")).toMatchObject({ installationId: first.credential.installationId });
    });
    expect(await first.stub.getBridgeStatus()).toMatchObject({ activeInstallation: { installationId: first.credential.installationId }, bridgeOnline: true });
    await expect(select(orgId, first, second)).resolves.toMatchObject({ activeInstallation: { installationId: second.credential.installationId } });
  });

  it("rejects stale, cross-org, offline, and revoked selections", async () => {
    const orgId = "bridge-selection-invalid";
    const first = await openTestBridge(orgId);
    const second = await openTestBridge(orgId);
    const input = { orgId, installationId: second.credential.installationId, expectedActiveInstallationId: first.credential.installationId, actorUserId: "owner" };
    await expect(callSelect(first.stub, { ...input, orgId: "another-org" })).rejects.toThrow("organization mismatch");
    await expect(callSelect(first.stub, { ...input, expectedActiveInstallationId: null })).rejects.toThrow("Active Bridge changed");
    await expect(callSelect(first.stub, { ...input, installationId: "missing" })).rejects.toThrow("offline");
    await revokeBridgeInstallation(env.DB, { orgId, installationId: second.credential.installationId, actorUserId: "owner" });
    await expect(callSelect(first.stub, input)).rejects.toThrow("credential is unavailable");
  });

  it("ignores standby device state and acknowledgments, fails in-flight commands at takeover, and routes subsequent commands only to the new owner", async () => {
    const orgId = "bridge-selection-dispatch";
    const first = await openTestBridge(orgId);
    const second = await openTestBridge(orgId);
    const clientResponse = await first.stub.fetch(await bridgeClientTestRequest(orgId));
    const client = clientResponse.webSocket!;
    const initialStatus = message(client, "bridge-status");
    client.accept();
    await initialStatus;
    await approveTestBridgeTarget(orgId, "obs", "venue:4455");
    const command = { type: "command" as const, id: "pending", protocol: "obs" as const, target: "venue:4455", command: "fixture" };
    const dispatched = message(first.socket, "command");
    const pending = first.stub.dispatchBridgeMessage(command, { source: "operator", actorUserId: "test-operator" });
    await dispatched;
    second.socket.send(JSON.stringify({ type: "command-response", id: "pending", success: true, response: "forged" }));
    second.socket.send(JSON.stringify({ type: "device-status", target: "forged-target", connected: true }));
    second.socket.send(JSON.stringify({ type: "device-event", target: "venue:4455", eventName: "forged", data: "forged" }));
    const standbyProcessed = message(client, "bridge-status");
    second.socket.send(JSON.stringify({ type: "bridge-status", version: "standby-fixture" }));
    await standbyProcessed; // Same-socket ordering proves the preceding messages were handled.
    expect(await first.stub.getBridgeStatus()).toMatchObject({ connectedTargets: [], deviceEvents: {} });
    await select(orgId, first, second);
    await expect(pending).resolves.toMatchObject({ success: false, error: "Active Bridge changed. Check the device before retrying." });
    const status = await first.stub.getBridgeStatus();
    expect(status.connectedTargets).toEqual([]);
    expect(status.deviceEvents).toEqual({});
    const nextMessage = message(second.socket, "command");
    const next = first.stub.dispatchBridgeMessage({ ...command, id: "new-owner-command" }, { source: "operator", actorUserId: "test-operator" });
    await nextMessage;
    first.socket.send(JSON.stringify({ type: "command-response", id: "new-owner-command", success: true, response: "old-owner" }));
    second.socket.send(JSON.stringify({ type: "command-response", id: "new-owner-command", success: true, response: "new-owner" }));
    await expect(next).resolves.toEqual({ success: true, response: "new-owner" });
  });
});
