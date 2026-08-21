import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeProxy } from "@/lib/device-modules/bridge-proxy";

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

  it("does not reconnect after an intentional disconnect", () => {
    const proxy = new BridgeProxy("org-1");
    proxy.connect();
    FakeWebSocket.instances[0].open();

    proxy.disconnect();
    vi.advanceTimersByTime(10_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
