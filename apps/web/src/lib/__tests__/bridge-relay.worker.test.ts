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

async function openBridge(orgId: string) {
  const stub = env.BRIDGE_RELAY.getByName(orgId);
  const response = await stub.fetch(new Request(`https://bridge.test/ws?orgId=${orgId}&role=bridge`, {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Bridge upgrade did not return a WebSocket");
  response.webSocket.accept();
  return { stub, socket: response.webSocket };
}

describe("BridgeRelay device dispatch", () => {
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
});
