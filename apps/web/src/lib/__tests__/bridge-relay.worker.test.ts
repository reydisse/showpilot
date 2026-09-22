import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

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

async function openBridge(orgId: string, bridgeKey?: string) {
  const stub = env.BRIDGE_RELAY.getByName(orgId);
  const query = new URLSearchParams({ orgId, role: "bridge" });
  if (bridgeKey) query.set("authBridgeKey", bridgeKey);
  const response = await stub.fetch(new Request(`https://bridge.test/ws?${query.toString()}`, {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Bridge upgrade did not return a WebSocket");
  response.webSocket.accept();
  return { stub, socket: response.webSocket };
}

async function openClient(orgId: string) {
  const stub = env.BRIDGE_RELAY.getByName(orgId);
  const response = await stub.fetch(new Request(`https://bridge.test/ws?orgId=${orgId}&role=client`, {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Client upgrade did not return a WebSocket");
  response.webSocket.accept();
  await nextMessage(response.webSocket); // initial bridge status
  return response.webSocket;
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event), { once: true }));
}

describe("BridgeRelay device dispatch", () => {
  it("closes a displaced bridge with the terminal takeover code", async () => {
    const first = await openBridge("bridge-takeover-org");
    const closed = nextClose(first.socket);
    await openBridge("bridge-takeover-org");

    await expect(closed).resolves.toMatchObject({
      code: 4410,
      reason: "Venue Bridge replaced by another installation",
    });
  });

  it("disconnects an existing venue bridge after its API key is rotated", async () => {
    const orgId = "rotated-bridge-key-org";
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(orgId, "Rotated Key", orgId, now).run();
    await env.DB.prepare(
      "INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, 'api-key', ?)",
    ).bind("rotated-key-setting", orgId, "old-key").run();

    const { stub, socket } = await openBridge(orgId, "old-key");
    const closed = nextClose(socket);
    await env.DB.prepare(
      "UPDATE app_setting SET value = ? WHERE orgId = ? AND key = 'api-key'",
    ).bind("new-key", orgId).run();

    socket.send(JSON.stringify({ type: "bridge-status", targets: ["propresenter:venue"] }));
    await expect(closed).resolves.toMatchObject({ code: 4403 });
    await expect(stub.getBridgeStatus()).resolves.toMatchObject({ bridgeOnline: false });
  });

  it("correlates connect and command RPCs while retaining live device state", async () => {
    const { stub, socket } = await openBridge("relay-device-org");

    const connectMessage = nextMessage(socket);
    const connectResult = stub.dispatchBridgeMessage({
      type: "connect-device",
      protocol: "obs",
      target: "10.0.0.40:4455",
      settings: { host: "10.0.0.40", port: 4455 },
    });
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
    });
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
    const clientA = await openClient(orgId);
    const clientB = await openClient(orgId);

    const commandA = nextMessage(bridge);
    clientA.send(JSON.stringify({ type: "command", id: "cmd_1", protocol: "pjlink", target: "projector-a", command: "%1POWR 1\r" }));
    const forwardedA = await commandA;
    const commandB = nextMessage(bridge);
    clientB.send(JSON.stringify({ type: "command", id: "cmd_1", protocol: "pjlink", target: "projector-b", command: "%1POWR 1\r" }));
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
