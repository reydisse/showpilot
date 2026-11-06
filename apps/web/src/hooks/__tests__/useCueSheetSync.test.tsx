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
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote, onColumns: vi.fn() }));
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
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn(), onColumns: vi.fn() }));
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
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote, onColumns: vi.fn() }));
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
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn(), onColumns: vi.fn() }));
  await act(async () => hydrate(Socket.instances[0]));
  expect(result.current.connected).toBe(false);
  expect(result.current.syncError).toBe("D1 unavailable");
  await act(async () => result.current.retrySync());
  expect(result.current.connected).toBe(true);
  expect(result.current.syncError).toBeNull();
});

it("bounds a stalled refresh and reconnects if the relay never returns a hydrate", async () => {
  const onRefresh = vi.fn(() => new Promise<void>(() => {}));
  const { result } = renderHook(() => useCueSheetSync({ orgId: "org", onRefresh, onNote: vi.fn(), onColumns: vi.fn() }));
  act(() => Socket.instances[0].open());
  act(() => vi.advanceTimersByTime(6000));
  expect(Socket.instances).toHaveLength(2);
  await act(async () => hydrate(Socket.instances[1]));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(result.current.connected).toBe(false);
  expect(result.current.syncError).toContain("timed out");
});
