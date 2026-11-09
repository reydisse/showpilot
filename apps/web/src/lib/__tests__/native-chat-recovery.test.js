import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadChatHook } from "../../test/native-chat-hook.js";
class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  readyState = 0; sent = []; sendError = false;
  send(value) { if (this.sendError) throw new Error("Socket write failed"); this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const message = (id = "message", more = {}) => ({ id, senderId: "operator", senderName: "Operator", text: "Hello", type: "text", timestamp: 1, ...more });
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup(notify = vi.fn(async input => ({ ...input, notified: 1 }))) {
  const sockets = [], listeners = new Set();
  const app = { currentState: "active", addEventListener: (_, listener) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; } };
  const transport = { createAuthenticatedWebSocket: vi.fn(async () => { const socket = new Socket(); sockets.push(socket); return socket; }),
    getNativeCookieHeader: vi.fn(async () => ({})), getAuthenticatedFetchCredentials: () => "include" };
  const fetch = vi.fn(); const hook = loadChatHook(transport, app, fetch, notify);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { org: "org", room: "production", user: "operator" };
  const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (initialProps = props) => renderHook(p => hook(p.org, p.room, p.user), { wrapper, initialProps });
  const result = mount();
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const hydrate = async (messages = []) => { await flush(); await act(async () => { sockets.at(-1).open(); sockets.at(-1).receive({ type: "hydrate", messages }); await vi.advanceTimersByTimeAsync(0); }); };
  return { ...result, mount, sockets, transport, fetch, notify, client, props, flush, hydrate,
    background: async state => act(async () => { app.currentState = state; for(const listener of listeners) listener(state); }) };
}
it("does not claim connected or flush a queued message before hydration", async () => {
  const f = setup(); await f.flush(); let id;
  await act(async () => { id = f.result.current.send("Queued"); f.sockets[0].open(); });
  await f.flush(); expect(f.result.current.status).not.toBe("connected"); expect(f.sockets[0].sent).toEqual([]);
  expect(f.result.current.outbox[0]).toMatchObject({ id, kind: "queued" });
  await f.hydrate(); expect(f.result.current.status).toBe("connected");
  expect(f.sockets[0].sent[0]).toMatchObject({ clientMessageId: id, text: "Queued" });
});
it.each(["opening", "hydration"])("bounds stalled %s and supports explicit retry", async stage => {
  const f = setup(); await f.flush(); if(stage === "hydration") await act(async () => f.sockets[0].open());
  await act(async () => vi.advanceTimersByTimeAsync(10001));
  expect(f.result.current.lastError).toMatch(/timed out/i); expect(f.result.current.status).not.toBe("connected");
  expect(f.sockets[0].readyState).toBe(Socket.CLOSED);
  await act(async () => f.result.current.retryConnection()); await f.hydrate();
  expect(f.result.current.lastError).toBeNull(); expect(f.result.current.hydrated).toBe(true);
});
it("retains a lost acknowledgement across navigation and retries the original identity", async () => {
  const f = setup(); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("Keep me"); }); await f.flush();
  expect(f.result.current.outbox[0]).toMatchObject({ id, kind: "sending" });
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.outbox[0]).toMatchObject({ id, kind: "uncertain" });
  f.unmount(); const next = f.mount(); await f.hydrate();
  expect(next.result.current.outbox[0].id).toBe(id); expect(f.sockets.at(-1).sent).toEqual([]);
  await act(async () => next.result.current.retryMessage(id));
  expect(f.sockets.at(-1).sent[0]).toMatchObject({ clientMessageId: id, text: "Keep me" });
  await act(async () => f.sockets.at(-1).receive({ type: "message", message: message(id, { text: "Keep me" }) })); await f.flush();
  expect(next.result.current.outbox).toEqual([]); expect(next.result.current.messages).toHaveLength(1);
});
it("reconciles an accepted send from hydration without sending again", async () => {
  const f = setup(); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("Hello"); f.sockets[0].close(); });
  await act(async () => f.result.current.retryConnection()); await f.hydrate([message(id)]);
  expect(f.result.current.outbox).toEqual([]); expect(f.sockets.at(-1).sent).toEqual([]);
});
it("keeps a failed socket write and a relay rejection visible", async () => {
  const f = setup(); await f.hydrate(); let id; f.sockets[0].sendError = true;
  await act(async () => { id = f.result.current.send("Keep me"); }); await f.flush();
  expect(f.result.current.outbox[0]).toMatchObject({ id, kind: "uncertain" });
  f.sockets[0].sendError = false;
  await act(async () => { f.result.current.retryMessage(id); f.sockets[0].receive({ type: "error", messageId: id, error: "Message was cleared." }); }); await f.flush();
  expect(f.result.current.outbox[0]).toMatchObject({ id, kind: "rejected", error: "Message was cleared." });
});
it.each(["org", "room", "user"])("isolates history, pending sends and stale callbacks across %s changes", async field => {
  const f = setup(); await f.hydrate([message()]); let id;
  await act(async () => { id = f.result.current.send("Original only"); });
  const old = f.sockets[0], stale = old.onmessage;
  f.rerender({ ...f.props, [field]: "other" }); await f.flush();
  await act(async () => stale({ data: JSON.stringify({ type: "message", message: message(id) }) }));
  expect(f.result.current.messages).toEqual([]); expect(f.result.current.outbox).toEqual([]);
  await f.hydrate(); expect(f.sockets.at(-1).sent).toEqual([]);
  f.rerender(f.props); await f.hydrate();
  expect(f.result.current.outbox[0]).toMatchObject({ id, kind: "uncertain" });
});
it("bounds older-history loading and ignores its late response after retry", async () => {
  const f = setup(); const history = Array.from({ length: 2000 }, (_, i) => message(String(i), { timestamp: i + 100 })); await f.hydrate(history);
  let late; f.fetch.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
  let pending; await act(async () => { pending = f.result.current.loadOlder(); });
  await act(async () => vi.advanceTimersByTimeAsync(10001)); await pending;
  expect(f.result.current.loadingOlder).toBe(false); expect(f.result.current.historyError).toMatch(/timed out/i);
  expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [message("older", { timestamp: 1 })], nextCursor: null })));
  await act(async () => f.result.current.loadOlder());
  await act(async () => late(new Response(JSON.stringify({ messages: [message("stale")], nextCursor: null }))));
  expect(f.result.current.messages.some(item => item.id === "older")).toBe(true);
  expect(f.result.current.messages.some(item => item.id === "stale")).toBe(false);
});
it("cancels background handshakes and resumes with one fresh connection", async () => {
  const f = setup(); await f.flush(); const old = f.sockets[0];
  await f.background("background"); expect(f.result.current.status).toBe("offline");
  await act(async () => vi.advanceTimersByTimeAsync(31000)); expect(f.sockets).toHaveLength(1);
  await f.background("active"); await f.hydrate(); expect(old.readyState).toBe(Socket.CLOSED);
  expect(f.result.current.status).toBe("connected"); expect(f.sockets).toHaveLength(2);
});
it("ignores late authentication after retry and closes its abandoned socket", async () => {
  const f = setup(); await f.flush(); let resolve;
  f.transport.createAuthenticatedWebSocket.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => f.result.current.retryConnection());
  const signal = f.transport.createAuthenticatedWebSocket.mock.calls.at(-1)[2];
  await act(async () => f.result.current.retryConnection()); await f.hydrate();
  const abandoned = new Socket(); await act(async () => resolve(abandoned));
  expect(signal.aborted).toBe(true); expect(abandoned.readyState).toBe(Socket.CLOSED); expect(f.result.current.status).toBe("connected");
});
it("keeps auth errors until a complete hydration and does not reconnect in the background", async () => {
  const f = setup(); await f.flush(); f.transport.createAuthenticatedWebSocket.mockRejectedValueOnce(new Error("Live authentication timed out."));
  await act(async () => f.result.current.retryConnection());
  expect(f.result.current.lastError).toBe("Live authentication timed out.");
  await f.background("background"); const calls = f.transport.createAuthenticatedWebSocket.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(f.transport.createAuthenticatedWebSocket).toHaveBeenCalledTimes(calls);
  await f.background("active"); await f.hydrate(); expect(f.result.current.lastError).toBeNull();
});
it("rejects malformed history rather than declaring an empty room ready", async () => {
  const f = setup(); await f.flush();
  await act(async () => f.sockets[0].receive({ type: "hydrate", messages: [{ id: "bad" }] }));
  expect(f.result.current.hydrated).toBe(false); expect(f.result.current.lastError).toMatch(/invalid history/);
  expect(f.sockets[0].readyState).toBe(Socket.CLOSED);
});
it("does not acknowledge another sender's message and does not automatically retry an uncertain send", async () => {
  const f = setup(); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("Mine"); f.sockets[0].receive({ type: "message", message: message(id, { senderId: "other" }) }); }); await f.flush();
  expect(f.result.current.outbox).toHaveLength(1);
  await act(async () => f.sockets[0].close());
  await act(async () => vi.advanceTimersByTimeAsync(1001)); await f.hydrate();
  expect(f.sockets.at(-1).sent).toEqual([]); expect(f.result.current.outbox[0].kind).toBe("uncertain");
});
it("holds an offline message in its original room and sends it once when that room returns", async () => {
  const f = setup(); await f.flush(); let id;
  await act(async () => { id = f.result.current.send("Planning later"); });
  f.rerender({ ...f.props, room: "planning" }); await f.hydrate();
  expect(f.sockets.at(-1).sent).toEqual([]); expect(f.result.current.outbox).toEqual([]);
  f.rerender(f.props); await f.hydrate();
  expect(f.sockets.at(-1).sent).toEqual([expect.objectContaining({ clientMessageId: id })]);
  await act(async () => f.result.current.retryMessage(id)); expect(f.sockets.at(-1).sent).toHaveLength(1);
});
it("preserves attachment, reply and poll content in the original retry frame", async () => {
  const f = setup(); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("", "cue", { attachments: [{ id: "file", name: "notes.pdf", url: "/notes", mimeType: "application/pdf", size: 5 }], replyTo: { messageId: "parent", senderName: "Crew", text: "Question" }, poll: { question: "Ready?", options: ["Yes", "No"] } }); });
  const original = f.sockets[0].sent[0]; await act(async () => vi.advanceTimersByTimeAsync(12001));
  await act(async () => f.result.current.retryMessage(id)); expect(f.sockets[0].sent[1]).toEqual(original);
  expect(original.poll.options).toEqual([{ id: "", text: "Yes", voterIds: [] }, { id: "", text: "No", voterIds: [] }]);
});
it("removes only the selected local delivery entry without sending delete", async () => {
  const f = setup(); await f.flush(); let one, two;
  await act(async () => { one = f.result.current.send("One"); two = f.result.current.send("Two"); });
  await act(async () => f.result.current.discardMessage(one)); await f.flush();
  expect(f.result.current.outbox.map(item => item.id)).toEqual([two]); await f.hydrate();
  expect(f.sockets[0].sent).toEqual([expect.objectContaining({ clientMessageId: two })]);
});
it.each(["cookies", "body"])("bounds older-history %s even when cancellation is ignored", async stage => {
  const f = setup(); await f.hydrate(Array.from({ length: 2000 }, (_, i) => message(String(i))));
  if(stage === "cookies") f.transport.getNativeCookieHeader.mockImplementation(() => new Promise(() => {}));
  else f.fetch.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
  let pending; await act(async () => { pending = f.result.current.loadOlder(); });
  await act(async () => vi.advanceTimersByTimeAsync(10001)); await pending;
  expect(f.result.current.loadingOlder).toBe(false); expect(f.result.current.historyError).toMatch(/timed out/);
  if(stage === "cookies") expect(f.fetch).not.toHaveBeenCalled();
});
it.each(["hydrate", "room"])("cancels an older page on %s and cannot restore cleared or unrelated messages", async operation => {
  const f = setup(); await f.hydrate(Array.from({ length: 2000 }, (_, i) => message(String(i)))); let finish;
  f.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let pending; await act(async () => { pending = f.result.current.loadOlder(); });
  if(operation === "hydrate") await act(async () => f.sockets[0].receive({ type: "hydrate", messages: [], historyCleared: true }));
  else { f.rerender({ ...f.props, room: "planning" }); await f.hydrate(); }
  await act(async () => finish(new Response(JSON.stringify({ messages: [message("stale")], nextCursor: null })))); await pending;
  expect(f.result.current.messages).toEqual([]); expect(f.result.current.loadingOlder).toBe(false);
});
it("requires hydration for edits and cleans pending mutation timers on errors and disconnect", async () => {
  const f = setup(); await f.flush(); await act(async () => f.sockets[0].open());
  await expect(f.result.current.editMessage("msg", "Edited")).rejects.toThrow("not ready");
  await f.hydrate(); f.sockets[0].sendError = true;
  await expect(f.result.current.editMessage("msg", "Edited")).rejects.toThrow("could not send");
  f.sockets[0].sendError = false; const result = f.result.current.deleteMessage("msg");
  const failed = expect(result).rejects.toThrow("disconnected"); await act(async () => f.sockets[0].close()); await failed;
  await act(async () => vi.advanceTimersByTimeAsync(8001)); expect(f.result.current.status).not.toBe("connected");
});
it("keeps live edits, reactions, typing and read receipts after hydration", async () => {
  const f = setup(); await f.hydrate([message()]);
  await act(async () => {
    f.sockets[0].receive({ type: "message-edited", message: message("message", { text: "Edited", editedAt: 5 }) });
    f.sockets[0].receive({ type: "typing", userId: "crew", name: "Crew", typing: true });
    f.sockets[0].receive({ type: "read-receipt", userId: "crew", readAt: 50 });
    f.result.current.setTyping(true); f.result.current.markRead(50);
  });
  expect(f.result.current.messages[0].text).toBe("Edited"); expect(f.result.current.typingUsers).toHaveLength(1); expect(f.result.current.readReceipts.crew).toBe(50);
  let mutation; await act(async () => { mutation = f.result.current.toggleReaction("message", "👍"); });
  const sent = f.sockets[0].sent.at(-1); expect(sent).toMatchObject({ type: "reaction", emoji: "👍" });
  await act(async () => f.sockets[0].receive({ type: "mutation-result", requestId: sent.requestId, ok: true })); await mutation;
  await act(async () => vi.advanceTimersByTimeAsync(3501)); expect(f.result.current.typingUsers).toEqual([]);
});
it("clears a socket-write error when that same message is acknowledged", async () => {
  const f = setup(); await f.hydrate(); let id; f.sockets[0].sendError = true;
  await act(async () => { id = f.result.current.send("Retry me"); });
  expect(f.result.current.lastError).toMatch(/could not send/); f.sockets[0].sendError = false;
  await act(async () => { f.result.current.retryMessage(id); f.sockets[0].receive({ type: "message", message: message(id) }); }); await f.flush();
  expect(f.result.current.outbox).toEqual([]); expect(f.result.current.lastError).toBeNull();
});
it("plans mention notifications before a fast acknowledgement and retries only notification delivery", async () => {
  const notify = vi.fn().mockRejectedValueOnce(new Error("Inbox unavailable"))
    .mockImplementation(async input => ({ ...input, notified: 1 }));
  const f = setup(notify); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("@Crew ready?", "alert", { mentionedUserIds: ["crew"] }); });
  expect(notify).not.toHaveBeenCalled();
  await act(async () => f.sockets[0].receive({ type: "message", message: message(id) })); await f.flush();
  expect(f.result.current.outbox[0]).toMatchObject({ kind: "notification-failed", error: "Inbox unavailable" });
  expect(notify.mock.calls[0][0]).toEqual({ kind: "message", orgId: "org", userId: "operator", roomId: "production", messageId: id, requestId: id, text: "@Crew ready?", mentionedUserIds: ["crew"] });
  await act(async () => f.result.current.retryMessage(id)); expect(f.sockets[0].sent).toHaveLength(1);
  await act(async () => { f.result.current.retryNotifications(id); f.result.current.retryNotifications(id); }); await f.flush();
  expect(notify).toHaveBeenCalledTimes(2); expect(notify.mock.calls[1][0]).toEqual(notify.mock.calls[0][0]);
  expect(f.result.current.outbox).toEqual([]); expect(f.sockets[0].sent).toHaveLength(1);
});
it("bounds notification acknowledgement and ignores a late result during a newer retry", async () => {
  let original, retry;
  const notify = vi.fn().mockImplementationOnce(() => new Promise(resolve => { original = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { retry = resolve; }));
  const f = setup(notify); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("Saved message"); f.sockets[0].receive({ type: "message", message: message(id) }); }); await f.flush();
  expect(f.result.current.outbox[0].kind).toBe("notifying");
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(f.result.current.outbox[0].kind).toBe("notification-failed"); expect(notify.mock.calls[0][1].aborted).toBe(true);
  await act(async () => f.result.current.retryNotifications(id));
  await act(async () => original({ ...notify.mock.calls[0][0], notified: 1 })); await f.flush();
  expect(f.result.current.outbox[0].kind).toBe("notifying");
  await act(async () => retry({ ...notify.mock.calls[1][0], notified: 0 })); await f.flush();
  expect(f.result.current.outbox).toEqual([]); expect(f.sockets[0].sent).toHaveLength(1);
});
it.each(["org", "room", "user"])("retains notification failure in its original %s through navigation", async field => {
  let finish; const notify = vi.fn(() => new Promise((_resolve, reject) => { finish = reject; }));
  const f = setup(notify); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("Original"); f.sockets[0].receive({ type: "message", message: message(id) }); });
  f.rerender({ ...f.props, [field]: "other" }); await f.hydrate();
  await act(async () => finish(new Error("Original inbox failed"))); await f.flush();
  expect(f.result.current.outbox).toEqual([]);
  f.rerender(f.props); await f.hydrate([message(id)]);
  expect(f.result.current.outbox[0]).toMatchObject({ id, kind: "notification-failed", error: "Original inbox failed" });
  expect(notify).toHaveBeenCalledTimes(1); expect(f.sockets.at(-1).sent).toEqual([]);
});
it("settles a notification after unmount without losing its failure", async () => {
  const notify = vi.fn(() => new Promise(() => {})); const f = setup(notify); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("Pending"); f.sockets[0].receive({ type: "message", message: message(id) }); });
  f.unmount(); await act(async () => vi.advanceTimersByTimeAsync(15001));
  const next = f.mount(); await f.hydrate([message(id)]);
  expect(next.result.current.outbox[0].kind).toBe("notification-failed"); expect(notify).toHaveBeenCalledTimes(1);
});
it.each(["orgId", "userId", "roomId", "messageId", "requestId"])("rejects a notification receipt for another %s", async field => {
  const notify = vi.fn(async input => ({ ...input, [field]: field === "requestId" ? "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" : "other", notified: 1 }));
  const f = setup(notify); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("Mine"); f.sockets[0].receive({ type: "message", message: message(id) }); }); await f.flush();
  expect(f.result.current.outbox[0]).toMatchObject({ kind: "notification-failed", error: expect.stringMatching(/another message or account/) });
});
it("does not notify a rejected or locally discarded send", async () => {
  const f = setup(); await f.hydrate(); let rejected, discarded;
  await act(async () => {
    rejected = f.result.current.send("Rejected");
    f.sockets[0].receive({ type: "error", messageId: rejected, error: "Not allowed" });
    discarded = f.result.current.send("Removed tracking"); f.result.current.discardMessage(discarded);
    f.sockets[0].receive({ type: "message", message: message(discarded) });
  });
  expect(f.notify).not.toHaveBeenCalled();
});
it("uses the poll question in notification delivery", async () => {
  const f = setup(); await f.hydrate(); let id;
  await act(async () => { id = f.result.current.send("", "text", { poll: { question: "Ready?", options: ["Yes", "No"] } }); f.sockets[0].receive({ type: "message", message: message(id) }); });
  expect(f.notify.mock.calls[0][0]).toMatchObject({ text: "Ready?", messageId: id });
});
it("retries a saved reaction notification without toggling the reaction again", async () => {
  const notify = vi.fn().mockRejectedValueOnce(new Error("Inbox failed")).mockImplementation(async input => ({ ...input, notified: 1 }));
  const f = setup(notify); await f.hydrate([message("crew-message", { senderId: "crew", senderName: "Crew" })]);
  let pending; await act(async () => { pending = f.result.current.toggleReaction("crew-message", "👍"); });
  const sent = f.sockets[0].sent.at(-1);
  await act(async () => {
    f.sockets[0].receive({ type: "message-edited", message: message("crew-message", { senderId: "crew", senderName: "Crew", reactions: [{ emoji: "👍", userIds: ["operator"] }] }) });
    f.sockets[0].receive({ type: "mutation-result", requestId: sent.requestId, ok: true });
    await pending;
  }); await f.flush();
  expect(f.result.current.outbox[0]).toMatchObject({ kind: "notification-failed", id: sent.requestId });
  expect(notify.mock.calls[0][0]).toEqual({ kind: "reaction", orgId: "org", userId: "operator", roomId: "production", messageId: "crew-message", requestId: sent.requestId, targetUserId: "crew", emoji: "👍" });
  await act(async () => f.result.current.retryNotifications(sent.requestId)); await f.flush();
  expect(f.result.current.outbox).toEqual([]); expect(f.sockets[0].sent).toHaveLength(1);
  expect(notify.mock.calls[1][0]).toEqual(notify.mock.calls[0][0]);
});
it.each(["removed", "self"])("does not notify a %s reaction", async kind => {
  const f = setup(); await f.hydrate([message("target", { senderId: kind === "self" ? "operator" : "crew", reactions: kind === "self" ? [{ emoji: "👍", userIds: ["operator"] }] : [] })]);
  let pending; await act(async () => { pending = f.result.current.toggleReaction("target", "👍"); });
  await act(async () => { f.sockets[0].receive({ type: "mutation-result", requestId: f.sockets[0].sent.at(-1).requestId, ok: true }); await pending; });
  expect(f.notify).not.toHaveBeenCalled(); expect(f.result.current.outbox).toEqual([]);
});
