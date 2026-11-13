import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChat } from "@/hooks/useChat";
import type { ChatMessage } from "@/lib/adapters/chat-adapter";
const oldNotifications = vi.hoisted(() => ({ message: vi.fn(), reaction: vi.fn() }));
vi.mock("@/lib/chat-collaboration", () => ({ notifyChatMessage: oldNotifications.message, notifyChatReaction: oldNotifications.reaction }));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { Socket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "" }); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  hydrate(id: string) {
    this.readyState = Socket.OPEN;
    this.onopen?.();
    this.receive({ type: "hydrate", messages: [message(id, 200)], readReceipts: { user: 120 } });
  }
}
function message(id: string, timestamp = 100): ChatMessage {
  return { id, orgId: "org", senderName: "Ada", text: id, type: "text", timestamp };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function page(id: string) { return Response.json({ messages: [message(id)], nextCursor: null }); }
function mount() {
  const frames: Array<{ room: string; messages: string[]; status: string; hydrated: boolean }> = [];
  const hook = renderHook(({ room, org = "org", user = "user" }) => {
    const chat = useChat({ orgId: org, roomId: room, currentUserId: user, senderName: "Ada" });
    frames.push({ room, messages: chat.messages.map(m => m.id), status: chat.connectionStatus, hydrated: chat.hydrated });
    return chat;
  }, { initialProps: { room: "production", org: "org", user: "user" } });
  act(() => Socket.instances[0].hydrate("production-new"));
  return { ...hook, frames };
}
beforeEach(() => { localStorage.clear(); Socket.instances = []; vi.stubGlobal("WebSocket", Socket); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("never renders the previous room's messages or connection under a new room", () => {
  const { rerender, frames, result } = mount();
  expect(frames[0].status).toBe("connecting");
  rerender({ room: "planning", org: "org", user: "user" });
  expect(frames.filter(f => f.room === "planning")).toEqual(expect.arrayContaining([
    { room: "planning", messages: [], status: "connecting", hydrated: false },
  ]));
  expect(frames.filter(f => f.room === "planning").every(f => f.messages.length === 0 && !f.hydrated)).toBe(true);
  expect(result.current.unreadCount).toBe(0);
  expect(result.current.readReceipts).toEqual({});
});

it.each(["late success", "late failure"])("isolates %s from an abandoned room's history", async (outcome) => {
  const held = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn(() => held.promise));
  const { result, rerender } = mount();
  let loading!: Promise<void>;
  act(() => { loading = result.current.loadOlderMessages(); });
  expect(result.current.loadingOlderMessages).toBe(true);
  rerender({ room: "planning", org: "org", user: "user" });
  act(() => Socket.instances[1].hydrate("planning-new"));
  await act(async () => {
    if (outcome === "late success") held.resolve(page("production-old"));
    else held.reject(new Error("Production history failed"));
    await loading;
  });
  expect(result.current.messages.map(m => m.id)).toEqual(["planning-new"]);
  expect(result.current.olderMessagesError).toBeNull();
  expect(result.current.hasOlderMessages).toBe(true);
});

it("allows the new room to load history while the previous request is pending", async () => {
  const old = deferred<Response>();
  const next = deferred<Response>();
  const fetcher = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = mount();
  let first!: Promise<void>;
  act(() => { first = result.current.loadOlderMessages(); });
  rerender({ room: "planning", org: "org", user: "user" });
  act(() => Socket.instances[1].hydrate("planning-new"));
  expect(result.current.loadingOlderMessages).toBe(false);
  let second!: Promise<void>;
  act(() => { second = result.current.loadOlderMessages(); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { old.resolve(page("production-old")); await first; });
  expect(result.current.loadingOlderMessages).toBe(true);
  await act(async () => { next.resolve(page("planning-old")); await second; });
  expect(result.current.messages.map(m => m.id)).toEqual(["planning-old", "planning-new"]);
});

it("does not reuse an abandoned request when returning to the same room", async () => {
  const old = deferred<Response>(); vi.stubGlobal("fetch", vi.fn(() => old.promise));
  const { result, rerender } = mount();
  let loading!: Promise<void>;
  act(() => { loading = result.current.loadOlderMessages(); });
  rerender({ room: "planning", org: "org", user: "user" });
  rerender({ room: "production", org: "org", user: "user" });
  act(() => Socket.instances[2].hydrate("production-returned"));
  await act(async () => { old.resolve(page("production-old")); await loading; });
  expect(result.current.messages.map(m => m.id)).toEqual(["production-returned"]);
});

it.each([{ org: "another", user: "user" }, { org: "org", user: "another" }])("isolates history across identity changes: %j", async (identity) => {
  const old = deferred<Response>(); vi.stubGlobal("fetch", vi.fn(() => old.promise));
  const { result, rerender } = mount();
  let loading!: Promise<void>;
  act(() => { loading = result.current.loadOlderMessages(); });
  rerender({ room: "production", ...identity });
  act(() => Socket.instances[1].hydrate("new-session"));
  await act(async () => { old.resolve(page("old-session")); await loading; });
  expect(result.current.messages.map(m => m.id)).toEqual(["new-session"]);
});

it("does not send a previous room's typing or read callbacks to the new room", () => {
  const { result, rerender } = mount();
  const previous = result.current;
  rerender({ room: "planning", org: "org", user: "user" });
  act(() => Socket.instances[1].hydrate("planning-new"));
  act(() => { previous.setTyping(true); previous.markRead(500); });
  expect(Socket.instances[1].sent).toEqual([]);
  rerender({ room: "production", org: "org", user: "user" });
  act(() => Socket.instances[2].hydrate("returned"));
  act(() => { previous.setTyping(true); previous.markRead(500); });
  expect(Socket.instances[2].sent).toEqual([]);
});

it("surfaces a stalled active-room history request and lets the operator retry", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(page("older"));
  vi.stubGlobal("fetch", fetcher);
  const { result } = mount();
  let first!: Promise<void>;
  act(() => { first = result.current.loadOlderMessages(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(8001); await first; });
  expect(result.current.olderMessagesError).toContain("timed out");
  expect(result.current.loadingOlderMessages).toBe(false);
  await act(async () => { await result.current.loadOlderMessages(); });
  expect(result.current.messages.map(m => m.id)).toEqual(["older", "production-new"]);
  expect(result.current.olderMessagesError).toBeNull();
});

it("aborts history when unmounted and clears typing timers", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const { result, unmount } = mount();
  act(() => Socket.instances[0].receive({ type: "typing", userId: "other", name: "Other", typing: true }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadOlderMessages(); });
  unmount(); await pending;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces cleared history and discards an in-flight old history page", async () => {
  const older = deferred<Response>();vi.stubGlobal("fetch",vi.fn(()=>older.promise));
  const {result}=mount();let loading!:Promise<void>;
  act(()=>{loading=result.current.loadOlderMessages();});
  await act(async()=>{Socket.instances[0].receive({type:"hydrate",historyCleared:true,messages:[message("after-clear",300)],readReceipts:{user:250}});await loading;});
  expect(result.current.messages.map(m=>m.id)).toEqual(["after-clear"]);
  expect(result.current.loadingOlderMessages).toBe(false);expect(result.current.olderMessagesError).toBeNull();
  await act(async()=>{older.resolve(page("before-clear"));await Promise.resolve();});
  expect(result.current.messages.map(m=>m.id)).toEqual(["after-clear"]);
});

it("discards history on reconnect when a clear happened while the socket was offline", () => {
  const {result}=mount();
  act(()=>Socket.instances[0].receive({type:"hydrate",historyClearVersion:1,messages:[message("after-offline-clear",300)],readReceipts:{}}));
  expect(result.current.messages.map(m=>m.id)).toEqual(["after-offline-clear"]);
});

it("does not notify the crew before the relay has accepted the queued message", async () => {
  oldNotifications.message.mockClear();
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const { result } = mount();
  await act(async () => { result.current.sendMessage("Wait for the room"); });
  expect(result.current.messages.some(value => value.text === "Wait for the room" && value.delivery === "sending")).toBe(true);
  expect(oldNotifications.message).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
