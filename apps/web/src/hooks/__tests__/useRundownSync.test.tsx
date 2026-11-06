import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRundownSync } from "../useRundownSync";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static constructionFails = false;
  static constructions = 0;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL) {
    MockWebSocket.constructions++;
    if (MockWebSocket.constructionFails) throw new Error("Socket constructor blocked");
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
    MockWebSocket.constructionFails = false;
    MockWebSocket.constructions = 0;
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, revision: 5 }));
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
    globalThis.fetch = OriginalFetch;
  });

  it("exposes the confirmed revision and resets it when changing shows", async () => {
    const { result, rerender, unmount } = renderHook(({ show }) => useRundownSync("org-1", "2026-09-06", show), { initialProps: { show: "show-1" } });
    const socket = await waitForSocket();
    expect(result.current.revision).toBe(0);
    act(() => { socket.open(); hydrate(socket); });
    expect(result.current.revision).toBe(4);
    act(() => result.current.sendCommand("timer-next"));
    const command = JSON.parse(socket.sent[0]);
    act(() => socket.receive({ type: "command-result", id: command.id, accepted: true, revision: 5 }));
    expect(result.current.revision).toBe(5);
    rerender({ show: "show-2" });
    expect(result.current.revision).toBe(0);
    act(() => hydrate(socket));
    expect(result.current.revision).toBe(0);
    unmount();
  });

  it("waits for matching state before reporting connected", async () => {
    const { result, unmount } = renderHook(() => useRundownSync("org-1", "2026-09-06", "show-1"));
    const socket = await waitForSocket();
    act(() => socket.open());
    expect(result.current.connected).toBe(false);
    act(() => hydrate(socket));
    expect(result.current.connected).toBe(true);
    act(() => socket.close());
    expect(result.current.connected).toBe(false);
    unmount();
  });

  it("discards stale transport on reconnect but keeps queued edits", async () => {
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    globalThis.fetch = vi.fn(async () => Response.json({ revision: 5 }));
    const { result, unmount } = renderHook(() => useRundownSync("org-1", "2026-09-06", "show-1"));
    const socket = await waitForSocket();
    act(() => {
      socket.open();
      hydrate(socket);
      result.current.sendCommand("timer-next");
      socket.close();
      result.current.sendCommand("update-meta", { serviceName: "Evening" });
    });
    expect(result.current.unconfirmedCount).toBe(2);
    now += 6_000;
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 2_000 });
    const replacement = MockWebSocket.instances[1];
    act(() => { replacement.open(); hydrate(replacement); });
    expect(replacement.sent.map((entry) => JSON.parse(entry).action)).toEqual(["update-meta"]);
    expect(result.current.unconfirmedCount).toBe(1);
    expect(result.current.lastError).toContain("expired");
    const edit = JSON.parse(replacement.sent[0]);
    act(() => replacement.receive({ type: "command-result", id: edit.id, accepted: true, revision: 5 }));
    expect(result.current.unconfirmedCount).toBe(0);
    expect(result.current.lastError).toContain("expired");
    unmount();
  });

  it("does not hand stale transport to HTTP on navigation", async () => {
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn(async () => Response.json({ revision: 5 }));
    globalThis.fetch = fetchMock;
    const { result, unmount } = renderHook(() => useRundownSync("org-1", "2026-09-06", "show-1"));
    await waitForSocket();
    act(() => result.current.sendCommand("timer-start", { itemId: "item-1" }));
    now += 6_000;
    unmount();
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the relay clock for deadlines and preserves the id when handing off fresh transport", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => Response.json({ revision: 5 }));
    globalThis.fetch = fetchMock;
    const { result, unmount } = renderHook(() => useRundownSync("org-1", "2026-09-06", "show-1"));
    const socket = await waitForSocket();
    act(() => {
      socket.open();
      socket.receive({ type: "hydrate", state: {
        showId: "show-1", serviceDate: "2026-09-06", revision: 4,
        timer: { playback: "stop", serverTime: 200_000 },
      } });
      result.current.sendCommand("timer-next");
    });
    const sent = JSON.parse(socket.sent[0]);
    expect(sent).toMatchObject({ action: "timer-next", expiresAt: 205_000, expectedRevision: 4 });
    unmount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      id: sent.id, expiresAt: 205_000, expectedRevision: 4,
    });
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

  it("hands pending work off on pagehide only once, even if the route then unmounts", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, revision: 5 }));
    globalThis.fetch = fetchMock;
    const { result, unmount } = renderHook(() => useRundownSync("org-pagehide", "2026-09-06", "show-1"));
    const socket = await waitForSocket();
    act(() => { socket.open(); hydrate(socket); result.current.sendCommand("stage-message", { message: "Review me" }); });
    const original = JSON.parse(socket.sent[0]);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(result.current.hasPendingCommands()).toBe(false);
    unmount(); await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ id: original.id, expectedRevision: original.expectedRevision });
  });


  it("reports socket construction failure and retries with backoff", () => {
    vi.useFakeTimers(); MockWebSocket.constructionFails = true;
    const { result, unmount } = renderHook(() => useRundownSync("org-constructor", "2026-09-06", "show-1"));
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.connected).toBe(false);
    expect(result.current.lastError).toContain("could not open");
    expect(result.current.lastErrorAt).toEqual(Date.now());
    expect(MockWebSocket.constructions).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(MockWebSocket.constructions).toBe(2);
    act(() => vi.advanceTimersByTime(1999));
    expect(MockWebSocket.constructions).toBe(2);
    MockWebSocket.constructionFails = false;
    act(() => vi.advanceTimersByTime(1));
    const socket = MockWebSocket.instances[0];
    act(() => { socket.open(); hydrate(socket); });
    expect(result.current.connected).toBe(true);
    expect(result.current.lastError).toBeNull();
    expect(result.current.lastErrorAt).toBeNull();
    unmount();
  });

  it.each([false, true])("bounds state hydration with socket opened=%s and does not reset backoff on open", (opened) => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRundownSync("org-timeout", "2026-09-06", "show-1"));
    act(() => vi.advanceTimersByTime(0));
    const first = MockWebSocket.instances[0];
    if (opened) act(() => first.open());
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.lastError).toContain("five seconds");
    expect(result.current.lastErrorAt).toEqual(Date.now());
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    act(() => vi.advanceTimersByTime(1000));
    const second = MockWebSocket.instances[1];
    act(() => { second.open(); vi.advanceTimersByTime(5000); });
    act(() => vi.advanceTimersByTime(1999));
    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(3);
    unmount(); act(() => vi.advanceTimersByTime(60_000));
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("retains last known state on malformed updates and ignores old frames after manual reconnect", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRundownSync("org-invalid", "2026-09-06", "show-1"));
    act(() => vi.advanceTimersByTime(0));
    const first = MockWebSocket.instances[0];
    act(() => { first.open(); hydrate(first); first.receive({ type: "state", state: { revision: 4, showId: "show-1", items: [{ id: "retained", title: "Last known item" }] } }); });
    const before = result.current.items;
    act(() => first.onmessage?.(new MessageEvent("message", { data: "{broken" })));
    expect(result.current.items).toEqual(before);
    expect(result.current.hydrated).toBe(true);
    expect(result.current.connected).toBe(false);
    expect(result.current.lastError).toContain("could not be read");
    act(() => result.current.retryConnection());
    expect(MockWebSocket.instances).toHaveLength(2);
    const replacement = MockWebSocket.instances[1];
    act(() => { replacement.open(); hydrate(replacement); });
    act(() => { first.receive({ type: "state", state: { revision: 99, showId: "show-1", items: [{ id: "stale" }] } }); first.onclose?.(); first.onerror?.(); });
    expect(result.current.connected).toBe(true);
    expect(result.current.revision).toBe(4);
    expect(result.current.items).toEqual([]);
    expect(result.current.lastError).toBeNull();
    unmount();
  });

  it("retains a command after send throws and retries with the same ID and revision", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRundownSync("org-send", "2026-09-06", "show-1"));
    act(() => vi.advanceTimersByTime(0));
    const first = MockWebSocket.instances[0];
    act(() => { first.open(); hydrate(first); });
    const failedSend = vi.spyOn(first, "send").mockImplementation(() => { throw new Error("send failed"); });
    act(() => result.current.sendCommand("update-meta", { serviceName: "Queued edit" }));
    expect(result.current.unconfirmedCount).toBe(1);
    expect(result.current.lastError).toContain("could not be sent");
    expect(result.current.lastErrorAt).toEqual(Date.now());
    const command = JSON.parse(failedSend.mock.calls[0][0]);
    act(() => result.current.retryConnection());
    const second = MockWebSocket.instances[1];
    act(() => { second.open(); hydrate(second); });
    expect(JSON.parse(second.sent[0])).toEqual(command);
    act(() => second.receive({ type: "command-result", id: command.id, accepted: true, revision: 5 }));
    expect(result.current.unconfirmedCount).toBe(0);
    expect(result.current.lastError).toBeNull();
    unmount();
  });

  it("does not invent success from an acknowledgement without accepted=true/false", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRundownSync("org-ack", "2026-09-06", "show-1"));
    act(() => vi.advanceTimersByTime(0));
    const first = MockWebSocket.instances[0];
    act(() => { first.open(); hydrate(first); result.current.sendCommand("update-meta", { serviceName: "Pending" }); });
    const command = JSON.parse(first.sent[0]);
    act(() => first.receive({ type: "command-result", id: command.id, revision: 5 }));
    expect(result.current.unconfirmedCount).toBe(1);
    expect(result.current.connected).toBe(false);
    expect(result.current.revision).toBe(4);
    act(() => result.current.retryConnection());
    const second = MockWebSocket.instances[1];
    act(() => { second.open(); hydrate(second); });
    expect(JSON.parse(second.sent[0]).id).toBe(command.id);
    act(() => second.receive({ type: "command-result", id: command.id, revision: 5, accepted: true, duplicate: true }));
    expect(result.current.unconfirmedCount).toBe(0);
    unmount();
  });

  it("expires a late transport action during manual reconnect while retaining edits", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRundownSync("org-expiry", "2026-09-06", "show-1"));
    act(() => vi.advanceTimersByTime(0));
    const first = MockWebSocket.instances[0];
    act(() => { first.open(); hydrate(first); result.current.sendCommand("timer-next"); first.close(); result.current.sendCommand("update-meta", { serviceName: "Keep edit" }); });
    vi.setSystemTime(Date.now() + 6000);
    act(() => result.current.retryConnection());
    const second = MockWebSocket.instances[1];
    act(() => { second.open(); hydrate(second); });
    expect(second.sent.map(raw => JSON.parse(raw).action)).toEqual(["update-meta"]);
    expect(result.current.lastError).toContain("expired");
    expect(result.current.lastErrorAt).toEqual(Date.now());
    const edit = JSON.parse(second.sent[0]);
    act(() => second.receive({ type: "command-result", id: edit.id, revision: 5, accepted: true }));
    expect(result.current.lastError).toContain("expired");
    unmount();
  });

  it("clears failure and preview state when switching show, and rejects mismatched state", () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(({ show }) => useRundownSync("org-scope", "2026-09-06", show), { initialProps: { show: "show-1" } });
    act(() => vi.advanceTimersByTime(0));
    const first = MockWebSocket.instances[0];
    act(() => { first.open(); hydrate(first); first.receive({ type: "state", state: { revision: 4, showId: "show-1", ppPreviewSlide: { text: "Old slide" } } }); first.close(); });
    expect(result.current.lastErrorAt).not.toBeNull();
    rerender({ show: "show-2" });
    expect(result.current.lastError).toBeNull();
    expect(result.current.lastErrorAt).toBeNull();
    expect(result.current.ppPreviewSlide).toBeNull();
    act(() => vi.advanceTimersByTime(0));
    const second = MockWebSocket.instances[1];
    act(() => { second.open(); hydrate(second); });
    expect(result.current.connected).toBe(false);
    expect(result.current.lastError).toContain("did not match");
    expect(result.current.stateShowId).toBeNull();
    unmount();
  });

});
