import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { openTestBridge, approveTestBridgeTarget, bridgeClientTestRequest } from "@/test/bridge-fixtures";
import { rotateBridgeInstallation, revokeBridgeInstallation } from "../bridge-credentials.server";
import { getActiveRundownRelayTarget } from "../active-rundown-relay";

afterEach(async () => {
  await abortAllDurableObjects();
});

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      try {
        const parsed: unknown = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("Bridge sent a non-object message"));
          return;
        }
        resolve({ ...parsed });
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
}

const openBridge = openTestBridge;

async function openClient(orgId: string) {
  const stub = env.BRIDGE_RELAY.getByName(orgId);
  const response = await stub.fetch(await bridgeClientTestRequest(orgId));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Client upgrade did not return a WebSocket");
  response.webSocket.accept();
  await nextMessage(response.webSocket); // initial bridge status
  return response.webSocket;
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event), { once: true }));
}

function commandResponse(socket: WebSocket, id: string): Promise<unknown> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const message: unknown = JSON.parse(String(event.data));
      if (message && typeof message === "object" && "type" in message && message.type === "command-response" && "id" in message && message.id === id) {
        socket.removeEventListener("message", handler); resolve(message);
      }
    };
    socket.addEventListener("message", handler);
  });
}

describe("BridgeRelay device dispatch", () => {
  it("completes a Bridge-initiated close and clears its live targets", async () => {
    const { stub, socket } = await openBridge("bridge-peer-close");
    socket.send(JSON.stringify({ type: "bridge-status", targets: ["venue-device"] }));
    await expect.poll(async () => (await stub.getBridgeStatus()).connectedTargets).toEqual(["venue-device"]);
    const closed = nextClose(socket);
    socket.close(1000, "Operator stopped Bridge");
    await expect(closed).resolves.toMatchObject({ code: 1000, reason: "Operator stopped Bridge", wasClean: true });
    await expect.poll(async () => (await stub.getBridgeStatus()).bridgeOnline).toBe(false);
    await expect(stub.getBridgeStatus()).resolves.toMatchObject({ connectedTargets: [] });
  });

  it("restores credential identity across hibernation and still honors revocation", async () => {
    const orgId = "bridge-hibernated-identity";
    const { stub, socket, credential } = await openBridge(orgId);
    await evictDurableObject(stub);
    socket.send(JSON.stringify({ type: "bridge-status", targets: ["venue-device"] }));
    await expect.poll(async () => (await stub.getBridgeStatus()).connectedTargets).toEqual(["venue-device"]);
    await evictDurableObject(stub);
    await revokeBridgeInstallation(env.DB, { orgId, installationId: credential.installationId, actorUserId: "owner" });
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "bridge-status", targets: ["revoked-device"] }));
    await expect(closed).resolves.toMatchObject({ code: 4403 });
    await expect(stub.getBridgeStatus()).resolves.toMatchObject({ bridgeOnline: false, connectedTargets: [] });
  });

  it("removes legacy plaintext attachments and requires a new header-authenticated connection", async () => {
    const orgId = "bridge-legacy-attachment";
    const { stub, socket, credential } = await openBridge(orgId);
    await runInDurableObject(stub, async (_instance, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ role: "bridge", orgId, bridgeKey: credential.key });
    });
    await evictDurableObject(stub);
    const closed = nextClose(socket);
    await expect(stub.getBridgeStatus()).resolves.toMatchObject({ bridgeOnline: false });
    await expect(closed).resolves.toMatchObject({ code: 4403 });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(JSON.stringify(state.getWebSockets().map((ws) => ws.deserializeAttachment()))).not.toContain(credential.key);
    });
  });

  it("rejects untrusted upgrades, claimless clients, and another organization's credential", async () => {
    const { credential } = await openBridge("bridge-boundary-source");
    const orgId = "bridge-boundary-target";
    const stub = env.BRIDGE_RELAY.getByName(orgId);
    const url = `https://bridge.test/ws?orgId=${orgId}&role=bridge&authCredentialId=${credential.credentialId}`;
    expect((await stub.fetch(new Request(url, { headers: { Upgrade: "websocket" } }))).status).toBe(401);
    const headers = { Upgrade: "websocket", "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" };
    expect((await stub.fetch(new Request(url, { headers }))).status).toBe(401);
    expect((await stub.fetch(new Request(`https://bridge.test/ws?orgId=${orgId}&role=client`, { headers }))).status).toBe(401);
  });

  it("persists only the credential ID in socket attachments and audits the operator's write", async () => {
    const orgId = "bridge-audit-attachment";
    const { stub, socket, credential } = await openBridge(orgId);
    await approveTestBridgeTarget(orgId, "obs", "venue:4455");
    const client = await openClient(orgId);
    await runInDurableObject(stub, async (_instance, state) => {
      const attachments = state.getWebSockets().map((ws) => ws.deserializeAttachment());
      expect(attachments).toContainEqual(expect.objectContaining({ role: "bridge", credentialId: credential.credentialId }));
      expect(JSON.stringify(attachments)).not.toContain(credential.key);
      expect(JSON.stringify(attachments)).not.toContain("bridgeKey");
    });
    const forwarded = nextMessage(socket);
    client.send(JSON.stringify({ type: "command", id: "operator-write", protocol: "obs", target: "venue:4455", command: "fixture" }));
    const operation = await forwarded;
    expect(operation).toMatchObject({ type: "command", id: expect.stringMatching(/^client_/) });
    const acknowledged = commandResponse(client, "operator-write");
    socket.send(JSON.stringify({ type: "command-response", id: operation.id, success: true }));
    await expect(acknowledged).resolves.toMatchObject({ success: true });
    const audit = await env.DB.prepare("SELECT credentialId, action, actorUserId FROM bridge_credential_audit WHERE orgId = ? AND direction = 'to-bridge'").bind(orgId).all();
    expect(audit.results).toEqual([{ credentialId: credential.credentialId, action: "command", actorUserId: `${orgId}-operator` }]);
    const closed = nextClose(socket);
    await revokeBridgeInstallation(env.DB, { orgId, installationId: credential.installationId, actorUserId: "owner" });
    const rejected = commandResponse(client, "revoked-write");
    client.send(JSON.stringify({ type: "command", id: "revoked-write", protocol: "obs", target: "venue:4455", command: "fixture" }));
    await expect(closed).resolves.toMatchObject({ code: 4403 });
    await expect(rejected).resolves.toMatchObject({ success: false });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM bridge_credential_audit WHERE orgId = ? AND direction = 'to-bridge'").bind(orgId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("keeps the displayed lyric through device and bridge outages, replaces it directly, and honors an explicit clear", async () => {
    const orgId = "bridge-lyric-continuity";
    await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)")
      .bind(orgId, orgId, orgId, new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'propresenter-stage-display', 'true')")
      .bind(`${orgId}-output`, orgId).run();
    const target = await getActiveRundownRelayTarget(env.DB, orgId);
    const relay = env.RUNDOWN_RELAY.getByName(target.key);
    const readSlide = async () => {
      const response = await relay.fetch(new Request(`https://rundown.test/state?orgId=${orgId}&serviceDate=${target.serviceDate}&access=observe`));
      const state = await response.json<{ ppSlide: { text: string } | null }>();
      return state.ppSlide?.text ?? null;
    };
    const sendSlide = (socket: WebSocket, data: unknown) => socket.send(JSON.stringify({
      type: "device-event", target: "propresenter:venue", eventName: "slide", data: JSON.stringify(data),
    }));
    const { socket, stub, credential } = await openBridge(orgId);
    const client = await openClient(orgId);
    sendSlide(socket, { text: "Lyric A" });
    await expect.poll(readSlide).toBe("Lyric A");
    const disconnected = nextMessage(client);
    socket.send(JSON.stringify({ type: "device-status", target: "propresenter:venue", connected: false }));
    await expect(disconnected).resolves.toMatchObject({ type: "device-status", connected: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readSlide()).toBe("Lyric A");
    socket.close();
    await expect.poll(async () => (await stub.getBridgeStatus()).bridgeOnline).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readSlide()).toBe("Lyric A");

    const { socket: reconnected } = await openBridge(orgId, credential);
    sendSlide(reconnected, { text: "Lyric B" });
    await expect.poll(readSlide).toBe("Lyric B");
    sendSlide(reconnected, []); // Malformed data is not a Clear command.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readSlide()).toBe("Lyric B");
    sendSlide(reconnected, null);
    await expect.poll(readSlide).toBeNull();
  });

  it("requires the internal secret and can purge an unused organization without a prior connection", async () => {
    const stub = env.BRIDGE_RELAY.getByName("unused-organization-purge");
    const url = "https://bridge.test/internal/purge-org";
    expect((await stub.fetch(new Request(url, { method: "POST" }))).status).toBe(401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await stub.fetch(new Request(url, {
        method: "POST",
        headers: { "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" },
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    }
  });

  it("keeps a second Bridge on standby until an operator explicitly selects it", async () => {
    const first = await openBridge("bridge-takeover-org");
    const second = await openBridge("bridge-takeover-org");
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    expect(await first.stub.getBridgeStatus()).toMatchObject({ activeInstallation: { installationId: first.credential.installationId }, connections: [
      { installationId: first.credential.installationId, role: "active" }, { installationId: second.credential.installationId, role: "standby" },
    ] });
    await first.stub.selectInstallation({ orgId: "bridge-takeover-org", installationId: second.credential.installationId, expectedActiveInstallationId: first.credential.installationId, actorUserId: "operator" });
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    expect(await first.stub.getBridgeStatus()).toMatchObject({ activeInstallation: { installationId: second.credential.installationId } });
  });

  it("keeps a connected Bridge during rotation overlap and cuts it off on installation revocation", async () => {
    const orgId = "rotated-bridge-key-org";
    const { stub, socket, credential } = await openBridge(orgId);
    const actor = { orgId, installationId: credential.installationId, actorUserId: "test-owner" };
    await rotateBridgeInstallation(env.DB, actor);
    await stub.refreshCredentialAuthority();
    socket.send(JSON.stringify({ type: "bridge-status", targets: ["propresenter:venue"] }));
    await expect.poll(async () => (await stub.getBridgeStatus()).connectedTargets).toContain("propresenter:venue");
    const closed = nextClose(socket);
    await revokeBridgeInstallation(env.DB, actor);
    await stub.refreshCredentialAuthority();
    await expect(closed).resolves.toMatchObject({ code: 4403 });
    await expect(stub.getBridgeStatus()).resolves.toMatchObject({ bridgeOnline: false });
  });

  it("expires an idle socket when its rotation overlap ends", async () => {
    const orgId = "expired-bridge-key-org";
    const { stub, socket, credential } = await openBridge(orgId);
    const closed = nextClose(socket);
    await env.DB.prepare("UPDATE bridge_credential SET expiresAt = ? WHERE orgId = ? AND id = ?")
      .bind(Date.now() - 1, orgId, credential.credentialId).run();
    await runInDurableObject(stub, async (_instance, state) => { await state.storage.setAlarm(Date.now() + 60_000); });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(closed).resolves.toMatchObject({ code: 4403 });
    await expect(stub.getBridgeStatus()).resolves.toMatchObject({ bridgeOnline: false });
  });

  it("correlates connect and command RPCs while retaining live device state", async () => {
    const { stub, socket } = await openBridge("relay-device-org");
    await approveTestBridgeTarget("relay-device-org", "obs", "10.0.0.40:4455");

    const connectMessage = nextMessage(socket);
    const connectResult = stub.dispatchBridgeMessage({
      type: "connect-device",
      protocol: "obs",
      target: "10.0.0.40:4455",
      settings: { host: "10.0.0.40", port: 4455 },
    }, { source: "operator", actorUserId: "test-operator" });
    expect(await connectMessage).toEqual({
      type: "connect-device",
      protocol: "obs",
      target: "10.0.0.40:4455",
      settings: { host: "10.0.0.40", port: 4455 },
    });
    socket.send(JSON.stringify({ type: "device-status", target: "10.0.0.40:4455", connected: true }));
    await expect(connectResult).resolves.toEqual({ success: true });

    const commandMessage = nextMessage(socket);
    const commandResult = stub.dispatchBridgeMessage({
      type: "command",
      id: "worker-command-1",
      protocol: "obs",
      target: "10.0.0.40:4455",
      command: JSON.stringify({ actionId: "start_streaming", params: {} }),
    }, { source: "operator", actorUserId: "test-operator" });
    expect(await commandMessage).toEqual(expect.objectContaining({
      type: "command",
      id: "worker-command-1",
      protocol: "obs",
      target: "10.0.0.40:4455",
    }));
    socket.send(JSON.stringify({ type: "command-response", id: "worker-command-1", success: true, response: "ok" }));
    await expect(commandResult).resolves.toEqual({ success: true, response: "ok" });

    socket.send(JSON.stringify({
      type: "device-event",
      target: "10.0.0.40:4455",
      eventName: "obs-state",
      data: JSON.stringify({ streamingActive: true }),
    }));
    await expect.poll(async () => (await stub.getBridgeStatus()).deviceEvents?.["10.0.0.40:4455"]?.eventName)
      .toBe("obs-state");
    expect(await stub.getBridgeStatus()).toEqual(expect.objectContaining({
      bridgeOnline: true,
      connectedTargets: ["10.0.0.40:4455"],
      devices: 1,
    }));

  });

  it("rejects an organization mismatch on an existing relay instance", async () => {
    const { stub } = await openBridge("relay-org-a");
    const response = await stub.fetch(new Request("https://bridge.test/status?orgId=relay-org-b"));
    expect(response.status).toBe(403);
  });

  it("routes colliding browser command IDs only to their originating operator", async () => {
    const orgId = "relay-command-owner";
    const { socket: bridge } = await openBridge(orgId);
    await approveTestBridgeTarget(orgId, "pjlink", "projector-a:4352");
    await approveTestBridgeTarget(orgId, "pjlink", "projector-b:4352");
    const clientA = await openClient(orgId);
    const clientB = await openClient(orgId);

    const commandA = nextMessage(bridge);
    clientA.send(JSON.stringify({ type: "command", id: "cmd_1", protocol: "pjlink", target: "projector-a:4352", command: "%1POWR 1\r" }));
    const forwardedA = await commandA;
    const commandB = nextMessage(bridge);
    clientB.send(JSON.stringify({ type: "command", id: "cmd_1", protocol: "pjlink", target: "projector-b:4352", command: "%1POWR 1\r" }));
    const forwardedB = await commandB;

    expect(forwardedA.id).not.toBe("cmd_1");
    expect(forwardedB.id).not.toBe("cmd_1");
    expect(forwardedA.id).not.toBe(forwardedB.id);

    const responseA = nextMessage(clientA);
    let bReceivedEarly = false;
    clientB.addEventListener("message", () => { bReceivedEarly = true; }, { once: true });
    bridge.send(JSON.stringify({ type: "command-response", id: forwardedA.id, success: true, response: "A" }));
    await expect(responseA).resolves.toMatchObject({ type: "command-response", id: "cmd_1", response: "A" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(bReceivedEarly).toBe(false);

    const responseB = nextMessage(clientB);
    bridge.send(JSON.stringify({ type: "command-response", id: forwardedB.id, success: true, response: "B" }));
    await expect(responseB).resolves.toMatchObject({ type: "command-response", id: "cmd_1", response: "B" });
  });

  it("does not forward panel cleanup as a venue-wide device disconnect", async () => {
    const orgId = "relay-panel-detach";
    const { socket: bridge } = await openBridge(orgId);
    const client = await openClient(orgId);
    let bridgeReceived = false;
    bridge.addEventListener("message", () => { bridgeReceived = true; }, { once: true });

    client.send(JSON.stringify({ type: "disconnect-device", target: "shared-projector" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(bridgeReceived).toBe(false);
  });
});
