import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atemModuleDefinition } from "@/lib/device-modules/atem/atem-module";
import { BridgeProxy, getSharedBridgeProxy } from "@/lib/device-modules/bridge-proxy";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("BridgeProxy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves commands and emits slide data carried by a command response", async () => {
    const proxy = new BridgeProxy("org-1");
    const slides: string[] = [];
    proxy.onDeviceEvent((_target, eventName, data) => {
      if (eventName === "slide") slides.push(data);
    });
    proxy.connect();

    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.receive({ type: "bridge-status", online: true });
    const result = proxy.sendCommand("propresenter", "propresenter:10.0.0.2", "current-slide");
    const command = JSON.parse(socket.sent[0]) as { id: string };
    socket.receive({
      type: "command-response",
      id: command.id,
      success: true,
      response: "ok",
      target: "propresenter:10.0.0.2",
      eventName: "slide",
      data: '{"text":"Welcome"}',
    });

    await expect(result).resolves.toBe("ok");
    expect(slides).toEqual(['{"text":"Welcome"}']);
    proxy.disconnect();
  });


  it("preserves device connection failure details for the originating target", () => {
    const proxy = new BridgeProxy("org-1"); const status = vi.fn();
    proxy.onDeviceStatus(status); proxy.connect();
    const socket = FakeWebSocket.instances[0]; socket.open();
    socket.receive({ type: "device-status", target: "venue:23", connected: false, success: false, error: "Destination approval required" });
    expect(status).toHaveBeenCalledWith("venue:23", false, "Destination approval required");
    proxy.disconnect();
  });

  it("reports a failed ping through Bridge availability with its reason", () => {
    const proxy = new BridgeProxy("org-1"); const status = vi.fn();
    proxy.onBridgeStatus(status); proxy.connect();
    const socket = FakeWebSocket.instances[0]; socket.open(); socket.receive({ type: "bridge-status", online: true });
    socket.receive({ type: "ping-response", success: false, error: "Venue Bridge disconnected" });
    expect(proxy.isBridgeOnline()).toBe(false);
    expect(status).toHaveBeenLastCalledWith(false, "Venue Bridge disconnected");
    proxy.disconnect();
  });

  it("reports an unavailable browser socket without leaving a device connect waiting", () => {
    const proxy = new BridgeProxy("org-1"); const status = vi.fn(); proxy.onDeviceStatus(status);
    proxy.connectDevice("tcp-command", "venue:23");
    expect(status).toHaveBeenCalledWith("venue:23", false, "Bridge connection is unavailable. Reconnect and try again.");
  });

  it("carries a relay rejection into the real ATEM module and allows retry", async () => {
    const proxy = getSharedBridgeProxy("atem-error-fixture");
    const socket = FakeWebSocket.instances[0]; socket.open(); socket.receive({ type: "bridge-status", online: true });
    const module = atemModuleDefinition.createInstance({ orgId: "atem-error-fixture", host: "venue", port: 9910 });
    const status = vi.fn(); module.onStatusChange(status);
    const first = module.connect();
    socket.receive({ type: "device-status", target: "venue:9910", connected: false, error: "Destination approval required" });
    await first;
    expect(module.connectionStatus()).toBe("error");
    expect(status).toHaveBeenLastCalledWith("error", "Destination approval required");
    const retry = module.connect(); await Promise.resolve();
    socket.receive({ type: "device-status", target: "venue:9910", connected: true });
    await retry;
    expect(module.connectionStatus()).toBe("connected");
    module.disconnect(); proxy.disconnect();
  });

  it("does not reconnect after an intentional disconnect", () => {
    const proxy = new BridgeProxy("org-1");
    proxy.connect();
    FakeWebSocket.instances[0].open();

    proxy.disconnect();
    vi.advanceTimersByTime(10_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
