import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRundownSync } from "../useRundownSync";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

const OriginalWebSocket = globalThis.WebSocket;

function hydrate(socket: MockWebSocket) {
  socket.receive({
    type: "hydrate",
    state: {
      initialized: true,
      revision: 4,
      serviceDate: "2026-09-06",
      showId: "show-1",
      items: [],
      timer: { playback: "stop", currentItemId: null, elapsed: 0, startedAt: null },
    },
  });
}

describe("useRundownSync command confirmation", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
  });

  it("keeps saving true until every queued command is confirmed", async () => {
    const { result, unmount } = renderHook(() =>
      useRundownSync("org-1", "2026-09-06", "show-1"),
    );
    const socket = MockWebSocket.instances[0];

    act(() => {
      socket.open();
      hydrate(socket);
    });

    act(() => {
      result.current.sendCommand("update-meta", { serviceName: "Morning" });
      result.current.sendCommand("timer-start", { itemId: "item-1" });
    });

    expect(result.current.saving).toBe(true);
    expect(socket.sent).toHaveLength(1);
    const first = JSON.parse(socket.sent[0]) as { id: string };

    act(() => {
      socket.receive({ type: "command-result", id: first.id, accepted: true, revision: 5 });
    });

    expect(result.current.saving).toBe(true);
    expect(socket.sent).toHaveLength(2);
    const second = JSON.parse(socket.sent[1]) as { id: string };

    act(() => {
      socket.receive({ type: "command-result", id: second.id, accepted: true, revision: 6 });
    });

    await waitFor(() => expect(result.current.saving).toBe(false));
    unmount();
  });

  it("also finishes confirmation state for a rejected command", async () => {
    const { result, unmount } = renderHook(() =>
      useRundownSync("org-1", "2026-09-06", "show-1"),
    );
    const socket = MockWebSocket.instances[0];

    act(() => {
      socket.open();
      hydrate(socket);
      result.current.sendCommand("timer-next");
    });

    const command = JSON.parse(socket.sent[0]) as { id: string };
    act(() => {
      socket.receive({
        type: "command-result",
        id: command.id,
        accepted: false,
        reason: "revision-conflict",
        revision: 5,
      });
    });

    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.lastError).toContain("Another operator changed");
    unmount();
  });
});
