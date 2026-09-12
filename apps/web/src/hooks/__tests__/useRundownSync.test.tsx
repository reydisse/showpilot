import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const OriginalFetch = globalThis.fetch;

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

async function waitForSocket(index = 0): Promise<MockWebSocket> {
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(index));
  return MockWebSocket.instances[index];
}

describe("useRundownSync command confirmation", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = OriginalWebSocket;
    globalThis.fetch = OriginalFetch;
  });

  it("keeps saving true until every queued command is confirmed", async () => {
    const { result, unmount } = renderHook(() =>
      useRundownSync("org-1", "2026-09-06", "show-1"),
    );
    const socket = await waitForSocket();

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
    const socket = await waitForSocket();

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

  it("drops the previous show's call time before hydrating a newly selected show", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ showId }) => useRundownSync("org-1", "2026-09-06", showId),
      { initialProps: { showId: "show-1" } },
    );
    const firstSocket = await waitForSocket();

    act(() => {
      firstSocket.open();
      firstSocket.receive({
        type: "hydrate",
        state: {
          initialized: true,
          revision: 4,
          serviceDate: "2026-09-06",
          showId: "show-1",
          scheduledCallTime: "2026-09-06T08:00:00.000Z",
          items: [],
          timer: { playback: "stop", currentItemId: null, elapsed: 0, startedAt: null },
        },
      });
    });
    expect(result.current.scheduledCallTime).toBe("2026-09-06T08:00:00.000Z");

    rerender({ showId: "show-2" });

    await waitFor(() => expect(result.current.scheduledCallTime).toBeUndefined());
    expect(result.current.hydrated).toBe(false);
    unmount();
  });

  it("hydrates the active stage message from relay state", async () => {
    const { result, unmount } = renderHook(() =>
      useRundownSync("org-1", "2026-09-06", "show-1"),
    );
    const socket = await waitForSocket();

    act(() => {
      socket.open();
      socket.receive({
        type: "hydrate",
        state: {
          initialized: true,
          revision: 4,
          serviceDate: "2026-09-06",
          showId: "show-1",
          stageMessage: "!!PRIORITY!!Hold the stage",
          items: [],
          timer: { playback: "stop", currentItemId: null, elapsed: 0, startedAt: null },
        },
      });
    });

    expect(result.current.stageMessage).toBe("!!PRIORITY!!Hold the stage");
    unmount();
  });

  it("hands queued commands to keepalive HTTP when the route unmounts", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, revision: 5 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const { result, unmount } = renderHook(() =>
      useRundownSync("org-1", "2026-09-06", "show-1"),
    );
    await waitForSocket();

    act(() => {
      result.current.sendCommand("stage-message", { message: "Stay ready" });
    });
    expect(result.current.hasPendingCommands()).toBe(true);

    unmount();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/rundown/org-1/command?serviceDate=2026-09-06&showId=show-1");
    expect(options.keepalive).toBe(true);
    expect(JSON.parse(String(options.body))).toMatchObject({
      action: "stage-message",
      payload: { message: "Stay ready" },
    });
  });
});
