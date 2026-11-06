import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCueSheetSync } from "../useCueSheetSync";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const note = { type: "note", showId: "show", serviceDate: "2026-11-05", itemId: "item", columnId: "column", text: "Recovered note", by: "Operator", at: 1 };
function hydrate(socket: Socket, sequence = 0) { socket.open(); socket.receive({ type: "hydrate", sequence, previousSequence: null }); }
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { Socket.instances = []; vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("refreshes D1 before marking connected and applies notifications received during the load afterwards", async () => {
  const load = deferred();
  const onRefresh = vi.fn(() => load.promise); const onNote = vi.fn();
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote }));
  const socket = Socket.instances[0];
  act(() => hydrate(socket));
  act(() => socket.receive({ type: "hydrate", sequence: 0, previousSequence: 0 }));
  expect(result.current.connected).toBe(false);
  act(() => socket.receive({ ...note, sequence: 1, previousSequence: 0 }));
  expect(onNote).not.toHaveBeenCalled();
  await act(async () => { load.resolve(); });
  expect(result.current.connected).toBe(true);
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(onNote).toHaveBeenCalledExactlyOnceWith(note);
  act(() => vi.advanceTimersByTime(25000));
  expect(socket.sent).toEqual([]); // Idle rooms can hibernate; no keepalive edit.
});

it("compares reconnect revisions and reloads missed changes instead of trusting the stale screen", async () => {
  const onRefresh = vi.fn(async () => {});
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  await act(async () => hydrate(Socket.instances[0], 2));
  act(() => Socket.instances[0].close());
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => hydrate(Socket.instances[1], 7));
  expect(onRefresh).toHaveBeenCalledTimes(2);
  expect(result.current.connected).toBe(true);
});

it("requests a snapshot on a missing predecessor, ignores stale deltas and refreshes again if the gap happened during a load", async () => {
  const first = deferred(); const second = deferred();
  const onRefresh = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const onNote = vi.fn();
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote }));
  const socket = Socket.instances[0];
  act(() => hydrate(socket, 2));
  act(() => socket.receive({ ...note, sequence: 4, previousSequence: 3 }));
  expect(socket.sent).toEqual([{ type: "sync", lastSeenSequence: 2 }]);
  act(() => socket.receive({ type: "hydrate", sequence: 4, previousSequence: 4 }));
  await act(async () => { first.resolve(); });
  expect(onRefresh).toHaveBeenCalledTimes(2);
  expect(result.current.connected).toBe(false);
  act(() => socket.receive({ ...note, sequence: 3, previousSequence: 2 }));
  await act(async () => { second.resolve(); });
  expect(result.current.connected).toBe(true);
  expect(onNote).not.toHaveBeenCalled();
});

it("reports reload failure and supports retry without pretending the view is synchronized", async () => {
  const onRefresh = vi.fn().mockRejectedValueOnce(new Error("D1 unavailable")).mockResolvedValueOnce(undefined);
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  await act(async () => hydrate(Socket.instances[0]));
  expect(result.current.connected).toBe(false);
  expect(result.current.syncError).toBe("D1 unavailable");
  await act(async () => result.current.retrySync());
  expect(result.current.connected).toBe(true);
  expect(result.current.syncError).toBeNull();
});

it("bounds a stalled refresh and reconnects if the relay never returns a hydrate", async () => {
  const onRefresh = vi.fn(() => new Promise<void>(() => {}));
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  act(() => Socket.instances[0].open());
  act(() => vi.advanceTimersByTime(6000));
  expect(Socket.instances).toHaveLength(2);
  await act(async () => hydrate(Socket.instances[1]));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(result.current.connected).toBe(false);
  expect(result.current.syncError).toContain("timed out");
});

it("bounds socket opening and gives Retry an immediate new connection", async () => {
  const onRefresh = vi.fn(async () => {});
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.syncError).toContain("timed out");
  expect(Socket.instances[0].readyState).toBe(3);
  act(() => result.current.retrySync());
  expect(Socket.instances).toHaveLength(2);
  await act(async () => hydrate(Socket.instances[1]));
  expect(result.current.connected).toBe(true);
});

it("reconnects immediately on manual retry after close instead of refreshing a dead socket", async () => {
  const onRefresh = vi.fn(async () => {});
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  await act(async () => hydrate(Socket.instances[0]));
  act(() => Socket.instances[0].close());
  act(() => result.current.retrySync());
  expect(Socket.instances).toHaveLength(2);
  expect(result.current.syncError).toBeTruthy();
  await act(async () => hydrate(Socket.instances[1]));
  expect(result.current.connected).toBe(true);
  expect(onRefresh).toHaveBeenCalledTimes(2);
});

it("does not report synchronized while a missing snapshot is still outstanding", async () => {
  const load = deferred();
  const onRefresh = vi.fn(() => load.promise);
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  act(() => hydrate(Socket.instances[0], 2));
  act(() => Socket.instances[0].receive({ ...note, sequence: 4, previousSequence: 3 }));
  await act(async () => load.resolve());
  expect(result.current.connected).toBe(false);
});

it("aborts expired reads, retains the error during retry, and ignores a late completion", async () => {
  const old = deferred(); const next = deferred();
  const onRefresh = vi.fn<(signal: AbortSignal) => Promise<void>>().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  act(() => hydrate(Socket.instances[0]));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(onRefresh.mock.calls[0][0].aborted).toBe(true);
  expect(result.current.syncErrorAt).toBe(Date.now());
  const failedAt = result.current.syncErrorAt;
  act(() => result.current.retrySync());
  expect(result.current.status).toBe("refreshing");
  expect(result.current.syncErrorAt).toBe(failedAt);
  await act(async () => old.resolve());
  expect(result.current.connected).toBe(false);
  await act(async () => next.resolve());
  expect(result.current.connected).toBe(true);
  expect(result.current.syncErrorAt).toBeNull();
});

it("cancels an old show refresh and rejects its buffered events when the selected show changes", async () => {
  const old = deferred(); const onNote = vi.fn();
  const onRefresh = vi.fn<(signal: AbortSignal) => Promise<void>>().mockReturnValueOnce(old.promise).mockResolvedValue(undefined);
  const { result, rerender, unmount } = renderHook(({ scope }) => useCueSheetSync({ orgId: "org", scope, onRefresh, onNote }), { initialProps: { scope: "old" } });
  act(() => hydrate(Socket.instances[0]));
  act(() => Socket.instances[0].receive({ ...note, sequence: 1, previousSequence: 0 }));
  rerender({ scope: "new" });
  expect(onRefresh.mock.calls[0][0].aborted).toBe(true);
  expect(Socket.instances[0].readyState).toBe(3);
  await act(async () => old.resolve());
  expect(result.current.connected).toBe(false);
  expect(onNote).not.toHaveBeenCalled();
  await act(async () => hydrate(Socket.instances[1]));
  expect(result.current.connected).toBe(true);
  unmount(); await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(Socket.instances).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("backs off failed opening attempts and preserves the failure until a confirmed refresh", async () => {
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh: vi.fn(async () => {}), onNote: vi.fn() }));
  act(() => Socket.instances[0].onerror?.());
  act(() => vi.advanceTimersByTime(1000));
  expect(Socket.instances).toHaveLength(2);
  act(() => Socket.instances[1].onerror?.());
  act(() => vi.advanceTimersByTime(1999));
  expect(Socket.instances).toHaveLength(2);
  act(() => vi.advanceTimersByTime(1));
  expect(Socket.instances).toHaveLength(3);
  expect(result.current.syncError).toBeTruthy();
  await act(async () => hydrate(Socket.instances[2]));
  expect(result.current.syncError).toBeNull();
});

it("surfaces constructor failures and allows a fresh connection on Retry", async () => {
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unavailable"); } });
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh: vi.fn(async () => {}), onNote: vi.fn() }));
  expect(result.current.syncError).toContain("could not open");
  vi.stubGlobal("WebSocket", Socket);
  act(() => result.current.retrySync());
  await act(async () => hydrate(Socket.instances[0]));
  expect(result.current.connected).toBe(true);
});

it("keeps a committed edit successful when its notification send fails, then refreshes without replay", async () => {
  const onRefresh = vi.fn(async () => {});
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  await act(async () => hydrate(Socket.instances[0]));
  vi.spyOn(Socket.instances[0], "send").mockImplementation(() => { throw new Error("Socket closed while sending"); });
  act(() => expect(() => result.current.publish({ type: "columns", at: 1 })).not.toThrow());
  expect(result.current.connected).toBe(false);
  act(() => result.current.retrySync());
  await act(async () => hydrate(Socket.instances[1]));
  expect(Socket.instances[1].sent).toEqual([]);
  expect(onRefresh).toHaveBeenCalledTimes(2);
});

it("drops deltas while a failed snapshot awaits retry and does not overlap manual refreshes", async () => {
  const next = deferred(); const onNote = vi.fn();
  const onRefresh = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(next.promise);
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote }));
  await act(async () => hydrate(Socket.instances[0]));
  act(() => Socket.instances[0].receive({ ...note, sequence: 1, previousSequence: 0 }));
  expect(onNote).not.toHaveBeenCalled();
  act(() => { result.current.retrySync(); result.current.retrySync(); });
  expect(onRefresh).toHaveBeenCalledTimes(2);
  await act(async () => next.resolve());
  expect(result.current.connected).toBe(true);
});

it("confirms columns through the bounded refresh and waits for changes received during a read", async () => {
  const first = deferred(); const second = deferred();
  const onRefresh = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(undefined);
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn() }));
  act(() => hydrate(Socket.instances[0]));
  act(() => Socket.instances[0].receive({ type: "columns", at: 1, sequence: 1, previousSequence: 0 }));
  await act(async () => first.resolve());
  expect(result.current.connected).toBe(false);
  expect(onRefresh).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve());
  expect(result.current.connected).toBe(true);
  await act(async () => Socket.instances[0].receive({ type: "columns", at: 2, sequence: 2, previousSequence: 1 }));
  expect(onRefresh).toHaveBeenCalledTimes(3);
});
