import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
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
    const { socket, recipient, credential } = await openTestBridge(orgId);
    const browser = await client(orgId);
    await approveTestBridgeTarget(orgId, "obs", command.target);
    const forwarded = next(socket, "connect-device");
    const connect = { type: "connect-device", protocol: "obs", target: command.target, settings: {} };
    browser.send(JSON.stringify({ ...connect, actorUserId: "forged", source: "automation", extra: "not-forwarded" }));
    const protectedMessage = await forwarded;
    expect(Object.keys(protectedMessage).sort()).toEqual(["protectedSettings", "protocol", "target", "type"]);
    expect(await recipient.open(protectedMessage.protectedSettings, { orgId, installationId: credential.installationId, protocol: connect.protocol, target: connect.target })).toEqual(connect.settings);
    const audit = await env.DB.prepare("SELECT actorUserId, source, executionId FROM bridge_target_audit WHERE orgId = ? AND action = 'connection-requested'").bind(orgId).all();
    expect(audit.results).toEqual([{ actorUserId: `${orgId}-operator`, source: "operator", executionId: null }]);
  });
});

it("publishes approval removal to the active Bridge and waits for its exact acknowledgement", async () => {
  const orgId = "target-policy-confirmation";
  const { stub, socket } = await openTestBridge(orgId);
  await approveTestBridgeTarget(orgId, "obs", command.target);
  const [approved] = await listBridgeTargets(env.DB, orgId);
  const browser = await client(orgId);
  const policy = next(socket, "bridge-policy");
  let finished = false;
  const removal = stub.changeTargetApproval({ orgId, action: "remove", id: approved.id, actorUserId: "fixture-admin" }).then(result => { finished = true; return result; });
  const published = await policy;
  expect(published.approvedTargets).toEqual([]);
  expect(await listBridgeTargets(env.DB, orgId)).toEqual([]);
  browser.send(JSON.stringify({ type: "bridge-policy-applied", policyId: published.policyId }));
  socket.send(JSON.stringify({ type: "bridge-policy-applied", policyId: "stale" }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  socket.send(JSON.stringify({ type: "bridge-policy-applied", policyId: published.policyId }));
  expect(await removal).toMatchObject({ targets: [], warning: null });
  expect(await stub.dispatchBridgeMessage(command, actor)).toMatchObject({ success: false });
});

it("keeps the saved approval and reports uncertainty when an older Bridge cannot acknowledge policy changes", async () => {
  const orgId = "target-policy-legacy";
  const { stub, socket } = await openTestBridge(orgId);
  const closed = new Promise<number>(resolve => socket.addEventListener("close", event => resolve(event.code)));
  const result = await stub.changeTargetApproval({ orgId, action: "approve", label: "OBS", endpoint: { host: "venue.local", port: 4455, protocol: "obs" }, actorUserId: "fixture-admin" });
  expect(result.targets).toHaveLength(1);
  expect(result.warning).toContain("did not confirm");
  expect(await closed).toBe(4403);
  expect((await stub.getBridgeStatus()).bridgeOnline).toBe(false);
  expect(await listBridgeTargets(env.DB, orgId)).toHaveLength(1);
}, 10_000);

it("serializes policy edits so an older acknowledgement cannot overwrite a newer approval", async () => {
  const orgId = "target-policy-ordered";
  const { stub, socket } = await openTestBridge(orgId);
  const input = { orgId, action: "approve" as const, label: "First", endpoint: { host: "venue.local", port: 4455, protocol: "obs" as const }, actorUserId: "fixture-admin" };
  const firstPolicy = next(socket, "bridge-policy");
  const first = stub.changeTargetApproval(input);
  const firstMessage = await firstPolicy;
  const second = stub.changeTargetApproval({ ...input, label: "Second", endpoint: { ...input.endpoint, port: 4456 } });
  expect(await listBridgeTargets(env.DB, orgId)).toHaveLength(1);
  const secondPolicy = next(socket, "bridge-policy");
  socket.send(JSON.stringify({ type: "bridge-policy-applied", policyId: firstMessage.policyId }));
  expect((await first).targets).toHaveLength(1);
  const secondMessage = await secondPolicy;
  expect(secondMessage.approvedTargets).toHaveLength(2);
  socket.send(JSON.stringify({ type: "bridge-policy-applied", policyId: secondMessage.policyId }));
  expect((await second).targets).toHaveLength(2);
});

it("refuses a legacy Bridge upgrade and cannot obtain policy support from URL parameters", async () => {
  const orgId = "target-policy-legacy-upgrade";
  const { stub, credential } = await openTestBridge(orgId);
  const url = `https://bridge.test/ws?${new URLSearchParams({ orgId, role: "bridge", authCredentialId: credential.credentialId, targetPolicyVersion: "1" })}`;
  const response = await stub.fetch(new Request(url, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" } }));
  expect(response.status).toBe(426);
  expect(await response.text()).toContain("Update ShowPilot");
});

it("closes a pre-policy connection restored after a server upgrade", async () => {
  const { stub, socket } = await openTestBridge("target-policy-legacy-restore");
  await runInDurableObject(stub, async (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      delete attachment.targetPolicyVersion;
      ws.serializeAttachment(attachment);
    }
  });
  const closed = new Promise<number>(resolve => socket.addEventListener("close", event => resolve(event.code)));
  await evictDurableObject(stub);
  expect((await stub.getBridgeStatus()).bridgeOnline).toBe(false);
  expect(await closed).toBe(4406);
});

it("attributes automatic ProPresenter connections to the authenticated installation without accepting actor or credential fields", async () => {
  const orgId = "target-policy-local-propresenter";
  const { socket, credential } = await openTestBridge(orgId);
  const target = "propresenter:venue.local:50001";
  await approveTestBridgeTarget(orgId, "propresenter", target);
  socket.send(JSON.stringify({ type: "automatic-connection-requested", requestId: "local-pp", target, apiPort: 1025, actorUserId: "forged", password: "do-not-store-local-secret" }));
  // A normal status message and its client broadcast establish that the
  // preceding automatic-connection message has finished in the ownership queue.
  const browser = await client(orgId);
  const status = next(browser, "bridge-status");
  socket.send(JSON.stringify({ type: "bridge-status", targets: [target] }));
  await status;
  const audit = await env.DB.prepare("SELECT actorUserId, source, executionId, port FROM bridge_target_audit WHERE orgId = ? AND action = 'connection-requested' ORDER BY port").bind(orgId).all();
  expect(audit.results).toEqual([1025, 50001].map(port => ({ actorUserId: null, source: "automation", executionId: expect.stringContaining(`installation:${credential.installationId}:`), port })));
  expect(JSON.stringify(await env.DB.prepare("SELECT * FROM bridge_target_audit WHERE orgId = ?").bind(orgId).all())).not.toContain("do-not-store-local-secret");
  const denied = next(socket, "automatic-connection-approved");
  socket.send(JSON.stringify({ type: "automatic-connection-requested", requestId: "denied-pp", target, apiPort: 9999 }));
  expect(await denied).toEqual({ type: "automatic-connection-approved", requestId: "denied-pp", approved: false });
});

async function connectionReceipt(socket: WebSocket, id: unknown, extra: Record<string, unknown> = {}) {
  const reply = next(socket, "command-connection-approved");
  socket.send(JSON.stringify({ type: "command-connection-requested", id, requestId: crypto.randomUUID(), ...extra }));
  return reply;
}

it.each(["tcp-command", "osc", "udp", "http-command", "wol"] as const)("records implicit %s connection attribution before returning approval and rejects replay", async protocol => {
  const orgId = `target-implicit-${protocol}`;
  const { stub, socket } = await openTestBridge(orgId);
  const input = { ...command, protocol, target: protocol === "wol" ? "wol" : command.target, command: protocol === "http-command" ? "GET /private-command-body" : "private-command-body" };
  const automation = { source: "automation" as const, actorUserId: "cue-author", executionId: "execution-fixture" };
  await approveTestBridgeTarget(orgId, protocol, input.target);
  const forwarded = next(socket, "command");
  const result = stub.dispatchBridgeMessage(input, automation);
  await forwarded;
  expect(await connectionReceipt(socket, input.id, { target: "forged.local:1", actorUserId: "forged", settings: { password: "do-not-store" } })).toMatchObject({ approved: true });
  const audit = await env.DB.prepare("SELECT actorUserId, source, executionId, host, port, protocol FROM bridge_target_audit WHERE orgId = ? AND action = 'connection-requested'").bind(orgId).all();
  expect(audit.results).toEqual([{ ...automation, host: protocol === "wol" ? "255.255.255.255" : "venue.local", port: protocol === "wol" ? 9 : 4455, protocol }]);
  expect(await connectionReceipt(socket, input.id)).toMatchObject({ approved: false });
  socket.send(JSON.stringify({ type: "command-response", id: input.id, success: false, error: "Device refused connection" }));
  expect(await result).toMatchObject({ success: false });
  expect(await connectionReceipt(socket, input.id)).toMatchObject({ approved: false });
  const all = await env.DB.prepare("SELECT * FROM bridge_target_audit WHERE orgId = ?").bind(orgId).all();
  expect(all.results.filter(row => row.action === "connection-requested")).toHaveLength(1);
  expect(JSON.stringify(all)).not.toMatch(/forged|private-command-body|do-not-store/);
});

it("uses the authenticated browser actor for implicit connections and rechecks permission before granting one", async () => {
  const orgId = "target-implicit-browser";
  const { socket } = await openTestBridge(orgId);
  const browser = await client(orgId);
  await approveTestBridgeTarget(orgId, "udp", command.target);
  const forwarded = next(socket, "command");
  browser.send(JSON.stringify({ ...command, protocol: "udp", actorUserId: "forged" }));
  const operation = await forwarded;
  expect(await connectionReceipt(socket, operation.id)).toMatchObject({ approved: true });
  const result = next(browser, "command-response");
  socket.send(JSON.stringify({ type: "command-response", id: operation.id, success: true }));
  expect(await result).toMatchObject({ id: command.id, success: true });
  const audit = await env.DB.prepare("SELECT actorUserId, source FROM bridge_target_audit WHERE orgId = ? AND action = 'connection-requested'").bind(orgId).all();
  expect(audit.results).toEqual([{ actorUserId: `${orgId}-operator`, source: "operator" }]);
  const second = next(socket, "command");
  browser.send(JSON.stringify({ ...command, protocol: "udp" }));
  const revoked = await second;
  await env.DB.prepare("DELETE FROM member WHERE organizationId = ?").bind(orgId).run();
  expect(await connectionReceipt(socket, revoked.id)).toMatchObject({ approved: false });
});

it("does not approve an unknown operation, a removed destination, or an unauditable connection", async () => {
  const orgId = "target-implicit-fail-closed";
  const { stub, socket } = await openTestBridge(orgId);
  expect(await connectionReceipt(socket, "unknown")).toMatchObject({ approved: false });
  await approveTestBridgeTarget(orgId, "udp", command.target);
  const [approved] = await listBridgeTargets(env.DB, orgId);
  const forwarded = next(socket, "command");
  const result = stub.dispatchBridgeMessage({ ...command, protocol: "udp" }, actor);
  await forwarded;
  await removeBridgeTarget(env.DB, { orgId, id: approved.id, actorUserId: "admin" });
  expect(await connectionReceipt(socket, command.id)).toMatchObject({ approved: false });
  socket.send(JSON.stringify({ type: "command-response", id: command.id, success: false }));
  await result;
  await approveTestBridgeTarget(orgId, "udp", command.target);
  await approveTestBridgeTarget(orgId, "propresenter", "propresenter:venue.local:50001");
  await env.DB.exec("CREATE TRIGGER fail_implicit_audit BEFORE INSERT ON bridge_target_audit WHEN NEW.orgId = 'target-implicit-fail-closed' AND NEW.action = 'connection-requested' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
  try {
    const forwardedAgain = next(socket, "command");
    const failed = stub.dispatchBridgeMessage({ ...command, id: "audit-failure", protocol: "udp" }, actor);
    await forwardedAgain;
    expect(await connectionReceipt(socket, "audit-failure")).toMatchObject({ approved: false });
    socket.send(JSON.stringify({ type: "command-response", id: "audit-failure", success: false }));
    expect(await failed).toMatchObject({ success: false });
    const automatic = next(socket, "automatic-connection-approved");
    socket.send(JSON.stringify({ type: "automatic-connection-requested", requestId: "audit-failure-pp", target: "propresenter:venue.local:50001", apiPort: 1025 }));
    expect(await automatic).toMatchObject({ requestId: "audit-failure-pp", approved: false });
  } finally { await env.DB.exec("DROP TRIGGER fail_implicit_audit"); }
});

it.each(["1", "2"])("rejects policy-v%s native Bridges without protected settings", async version => {
  const orgId = "target-policy-v1-upgrade";
  const { stub, credential } = await openTestBridge(orgId);
  const url = `https://bridge.test/ws?${new URLSearchParams({ orgId, role: "bridge", authCredentialId: credential.credentialId })}`;
  const response = await stub.fetch(new Request(url, { headers: { Upgrade: "websocket", "x-showpilot-bridge-policy": version, "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" } }));
  expect(response.status).toBe(426);
});
