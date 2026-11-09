import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeChatAdapter } from "../adapters/native-chat-adapter";
import { chatOutboxStorageKey } from "../chat-outbox";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(value: string) { this.sent.push(value); }
  close(code = 1000, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
}

describe("NativeChatAdapter recovery and history", () => {
  beforeEach(() => {
    localStorage.clear();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reports Connected only after the room confirms its state", async () => {
    const adapter = new NativeChatAdapter("org-1");
    try {
      const opening = adapter.connect();
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open(); await opening;
      expect(adapter.connectionStatus()).toBe("connecting");
      socket.receive({ type: "hydrate", messages: [], readReceipts: {} });
      expect(adapter.connectionStatus()).toBe("connected");
    } finally { adapter.disconnect(); }
  });

  it("retires an unconfirmed room at the deadline even when the socket close handshake stalls", async () => {
    vi.useFakeTimers();
    const adapter = new NativeChatAdapter("org-1");
    try {
      const opening = adapter.connect();
      const old = FakeWebSocket.instances.at(-1)!;
      old.open(); await opening;
      vi.spyOn(old, "close").mockImplementation(() => { old.readyState = 2; });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(adapter.connectionStatus()).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
      old.receive({ type: "hydrate", messages: [], readReceipts: {} });
      old.onclose?.({ code: 1006, reason: "Late close" });
      expect(adapter.connectionStatus()).toBe("reconnecting");
      const replacement = FakeWebSocket.instances.at(-1)!;
      replacement.open(); replacement.receive({ type: "hydrate", messages: [], readReceipts: {} });
      expect(adapter.connectionStatus()).toBe("connected");
    } finally { adapter.disconnect(); vi.useRealTimers(); }
  });

  it("bounds a missing room confirmation, preserves queued messages, and ignores a superseded socket", async () => {
    vi.useFakeTimers();
    const adapter = new NativeChatAdapter("org-1", undefined, "production", "retry-user", "user-1");
    try {
      const opening = adapter.connect();
      const old = FakeWebSocket.instances.at(-1)!;
      old.open(); await opening;
      await adapter.sendMessage("Queued before room confirmation", "text", "Ada");
      expect(old.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(old.readyState).toBe(3);
      expect(adapter.connectionStatus()).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(1_000);
      const current = FakeWebSocket.instances.at(-1)!;
      current.open();
      expect(adapter.connectionStatus()).toBe("reconnecting");
      old.receive({ type: "hydrate", messages: [], readReceipts: {} });
      old.close();
      expect(adapter.connectionStatus()).toBe("reconnecting");
      expect(current.sent).toEqual([]);
      current.receive({ type: "hydrate", messages: [], readReceipts: {} });
      expect(adapter.connectionStatus()).toBe("connected");
      expect(current.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === "message")).toHaveLength(1);
      current.receive({ type: "history", messages: [], readReceipts: {} });
      expect(current.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === "message")).toHaveLength(1);
    } finally { adapter.disconnect(); vi.useRealTimers(); }
  });

  it("retries constructor failures and bounds sockets that never open", async () => {
    vi.useFakeTimers();
    const adapter = new NativeChatAdapter("org-1");
    try {
      vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unavailable"); } });
      await expect(adapter.connect()).rejects.toThrow("Unavailable");
      expect(adapter.connectionStatus()).toBe("reconnecting");
      vi.stubGlobal("WebSocket", FakeWebSocket);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(FakeWebSocket.instances[0].readyState).toBe(3);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
      adapter.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { adapter.disconnect(); vi.useRealTimers(); }
  });

  it("bounds stalled history, aborts it, and retries without advancing the cursor", async () => {
    vi.useFakeTimers();
    const adapter = new NativeChatAdapter("org-1", undefined, "planning");
    const connected = adapter.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open(); await connected;
    socket.receive({ type: "hydrate", messages: [{ id: "new", orgId: "org-1", senderName: "Ada", text: "New", type: "text", timestamp: 200 }], readReceipts: {} });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json({ messages: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const first = adapter.loadOlder();
      const outcome = expect(first).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(8001);
      await outcome;
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      finish(Response.json({ messages: [{ id: "late", timestamp: 100 }], nextCursor: { id: "late", timestamp: 100 } }));
      await Promise.resolve(); await Promise.resolve();
      await adapter.loadOlder();
      expect(fetcher.mock.calls[1][0]).toContain("beforeId=new");
      expect((await adapter.getHistory()).map(message => message.id)).toEqual(["new"]);
    } finally { adapter.disconnect(); vi.useRealTimers(); }
  });

  it("coalesces older history and cancels it on disconnect even if fetch ignores abort", async () => {
    const adapter = new NativeChatAdapter("org-1");
    const connected = adapter.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open(); await connected;
    socket.receive({ type: "hydrate", messages: [{ id: "new", orgId: "org-1", senderName: "Ada", text: "New", type: "text", timestamp: 200 }], readReceipts: {} });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const first = adapter.loadOlder(); const second = adapter.loadOlder();
    const outcomes = Promise.allSettled([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    adapter.disconnect();
    expect((await outcomes).map(result => result.status)).toEqual(["rejected", "rejected"]);
    finish(Response.json({ messages: [{ id: "late", timestamp: 100 }], nextCursor: null }));
    await Promise.resolve(); await Promise.resolve();
    expect((await adapter.getHistory()).map(message => message.id)).toEqual(["new"]);
  });

  it("restores a scoped offline outbox in a replacement adapter and clears it only after relay acknowledgement", async () => {
    const messageId = "11111111-1111-4111-8111-111111111111";
    const first = new NativeChatAdapter("org-1", undefined, "production", "user-user-1", "user-1");
    await first.sendMessage("Still here", "text", "Ada", "PM", { clientMessageId: messageId });
    expect(JSON.parse(localStorage.getItem(chatOutboxStorageKey("user-user-1", "org-1", "production")) ?? "[]")).toHaveLength(1);

    const replacement = new NativeChatAdapter("org-1", undefined, "production", "user-user-1", "user-1");
    const outboxSnapshots: Array<Array<{ id: string; delivery?: string }>> = [];
    replacement.onOutboxChange((messages) => outboxSnapshots.push(messages));
    expect(outboxSnapshots.at(-1)).toMatchObject([{ id: messageId, delivery: "waiting" }]);
    expect(new NativeChatAdapter("org-1", undefined, "production", "user-other", "other").onOutboxChange((messages) => expect(messages).toEqual([]))).toBeTypeOf("function");

    const connected = replacement.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    await connected;
    socket.receive({ type: "hydrate", messages: [], readReceipts: {} });
    expect(socket.sent.some((frame) => JSON.parse(frame).clientMessageId === messageId)).toBe(true);
    expect(outboxSnapshots.at(-1)).toMatchObject([{ id: messageId, delivery: "sending" }]);

    socket.receive({ type: "message", message: { id: messageId, orgId: "org-1", senderId: "user-1", senderName: "Ada", text: "Still here", type: "text", timestamp: 10 } });
    expect(outboxSnapshots.at(-1)).toEqual([]);
    expect(localStorage.getItem(chatOutboxStorageKey("user-user-1", "org-1", "production"))).toBeNull();
  });

  it("requests and merges history before the hydration cursor", async () => {
    const adapter = new NativeChatAdapter("org-1", undefined, "planning", "user-user-1", "user-1");
    const connected = adapter.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    await connected;
    socket.receive({ type: "hydrate", messages: [{ id: "new", orgId: "org-1", senderName: "Ada", text: "New", type: "text", timestamp: 200 }], readReceipts: {} });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "old", orgId: "org-1", senderName: "Ben", text: "Old", type: "text", timestamp: 100 }], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const page = await adapter.loadOlder(100);
    expect(page.messages.map((message) => message.id)).toEqual(["old"]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("beforeTimestamp=200");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("beforeId=new");
    expect((await adapter.getHistory()).map((message) => message.id)).toEqual(["old", "new"]);
  });
});

it("reports a revoked guest pass without reconnecting or flushing its queued message", async () => {
  vi.useFakeTimers();
  FakeWebSocket.instances = []; vi.stubGlobal("WebSocket", FakeWebSocket);
  const revoked = vi.fn();
  const adapter = new NativeChatAdapter("revocation-org", { token: "fixture", name: "Crew", onRevoked: revoked });
  const connected = adapter.connect();
  const socket = FakeWebSocket.instances[0]; socket.open(); await connected;
  socket.close(4403, "Guest pass revoked");
  expect(revoked).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  await adapter.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals();
});


describe("web chat message and notification confirmation", () => {
  const adapters: NativeChatAdapter[] = [];
  let orgId = "";
  let fetcher = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); orgId = crypto.randomUUID();
    FakeWebSocket.instances = []; vi.stubGlobal("WebSocket", FakeWebSocket);
    fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body));
      return Response.json({ ...command, userId: command.expectedUserId, notified: 1 });
    });
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => { adapters.forEach(adapter => adapter.disconnect()); adapters.length = 0; vi.unstubAllGlobals(); vi.useRealTimers(); });
  async function open(userId = "actor", room = "production") {
    const adapter = new NativeChatAdapter(orgId, undefined, room, `user-${userId}`, userId); adapters.push(adapter);
    const connected = adapter.connect(); const socket = FakeWebSocket.instances.at(-1)!;
    socket.open(); await connected; socket.receive({ type: "hydrate", messages: [], readReceipts: {} });
    return { adapter, socket };
  }
  const confirmed = (id: string, more = {}) => ({ id, orgId, senderId: "actor", senderName: "Ada", text: "Fixture message", type: "text", timestamp: Date.now(), ...more });
  it("notifies only after the original message is acknowledged and keeps mention choices", async () => {
    const { adapter, socket } = await open(); const id = crypto.randomUUID();
    await adapter.sendMessage("Ready @Crew", "text", "Ada", "PM", { clientMessageId: id, mentionedUserIds: ["crew"] });
    expect(fetcher).not.toHaveBeenCalled();
    socket.receive({ type: "message", message: confirmed(id) });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({ requestId: expect.any(String), messageId: id, expectedUserId: "actor", mentionedUserIds: ["crew"] });
    socket.receive({ type: "message", message: confirmed(id) });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves the existing outbox when capacity rejects another draft", async () => {
    const { adapter } = await open();
    let outbox: Array<{ id: string }> = [];
    adapter.onOutboxChange(value => { outbox = value; });
    for (let index = 0; index < 50; index++) await adapter.sendMessage(`Queued ${index}`, "text", "Ada", "PM", { clientMessageId: `queued-${index}` });
    const original = outbox.map(item => item.id);
    await expect(adapter.sendMessage("Keep in composer", "text", "Ada", "PM", { clientMessageId: "new-draft" })).rejects.toThrow("queue is full");
    expect(outbox.map(item => item.id)).toEqual(original);
    adapter.cancelOutbox("queued-0");
    await adapter.sendMessage("Keep in composer", "text", "Ada", "PM", { clientMessageId: "new-draft" });
    expect(outbox.map(item => item.id)).toEqual([...original.slice(1), "new-draft"]);
  });
  it("settles a missing message acknowledgement and retries the same message ID", async () => {
    const { adapter, socket } = await open(); const id = crypto.randomUUID();
    let outbox: Array<{ id: string; delivery?: string }> = [];
    adapter.onOutboxChange(value => { outbox = value; });
    await adapter.sendMessage("Late acknowledgement", "text", "Ada", "PM", { clientMessageId: id });
    await vi.advanceTimersByTimeAsync(8_001);
    expect(outbox).toMatchObject([{ id, delivery: "failed" }]);
    expect(fetcher).not.toHaveBeenCalled();
    adapter.retryOutbox(id);
    const messages = socket.sent.map(frame => JSON.parse(frame)).filter(frame => frame.type === "message");
    expect(messages).toHaveLength(2); expect(messages[0]).toEqual(messages[1]);
    socket.receive({ type: "message", message: confirmed(id) });
    await vi.advanceTimersByTimeAsync(1); expect(outbox).toEqual([]); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("notifies for a legacy non-UUID message ID and bounds the text to the saved relay limit", async () => {
    const { adapter, socket } = await open();
    const id = "old-lan-message";
    await adapter.sendMessage("a".repeat(5000), "text", "Ada", "PM", { clientMessageId: id });
    socket.receive({ type: "message", message: confirmed(id, { text: "a".repeat(4000) }) });
    await vi.advanceTimersByTimeAsync(1);
    const command = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(command.messageId).toBe(id);
    expect(command.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(command.text).toBe("a".repeat(4000));
  });
  it.each(["senderId", "orgId"])("does not acknowledge a message with a different %s", async field => {
    const { adapter, socket } = await open(); const id = crypto.randomUUID();
    let outbox: Array<{ id: string }> = []; adapter.onOutboxChange(value => { outbox = value; });
    await adapter.sendMessage("Same ID, wrong identity", "text", "Ada", "PM", { clientMessageId: id });
    socket.receive({ type: "message", message: confirmed(id, { [field]: "other" }) });
    expect(outbox).toMatchObject([{ id }]); expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains a notification failure across adapter replacement and retries no message", async () => {
    fetcher.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    const first = await open(); const id = crypto.randomUUID();
    await first.adapter.sendMessage("Accepted message", "text", "Ada", "PM", { clientMessageId: id });
    first.socket.receive({ type: "message", message: confirmed(id) });
    await vi.advanceTimersByTimeAsync(1); first.adapter.disconnect();
    const second = await open();
    let work: import("../chat-notifications").ChatNotificationWork[] = [];
    second.adapter.onNotifications(value => { work = value; });
    expect(work).toMatchObject([{ status: "failed", command: { messageId: id } }]);
    const firstBody = fetcher.mock.calls[0][1].body;
    const requestId = work[0].command.requestId;
    second.adapter.retryNotifications(requestId); second.adapter.retryNotifications(requestId);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[1][1].body).toBe(firstBody);
    expect(second.socket.sent).toEqual([]); expect(work).toEqual([]);
  });
  it("bounds a stalled notification and ignores its late reply during a retry", async () => {
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { adapter, socket } = await open(); const id = crypto.randomUUID();
    let work: import("../chat-notifications").ChatNotificationWork[] = []; adapter.onNotifications(value => { work = value; });
    await adapter.sendMessage("Bounded notification", "text", "Ada", "PM", { clientMessageId: id });
    socket.receive({ type: "message", message: confirmed(id) }); await vi.advanceTimersByTimeAsync(15_001);
    expect(work[0].status).toBe("failed"); expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    fetcher.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    adapter.retryNotifications(work[0].command.requestId); await vi.advanceTimersByTimeAsync(1);
    const latest = work[0];
    finish(Response.json({ orgId, userId: "actor", roomId: "production", messageId: id, requestId: id, notified: 1 }));
    await vi.advanceTimersByTimeAsync(1); expect(work[0]).toBe(latest);
  });
  it.each(["userId", "orgId", "roomId", "requestId", "messageId"])("does not accept a notification acknowledgement for another %s", async field => {
    fetcher.mockImplementationOnce(async (_url, init) => {
      const command = JSON.parse(String(init.body));
      return Response.json({ ...command, userId: "actor", notified: 1, [field]: field === "requestId" ? crypto.randomUUID() : "other" });
    });
    const { adapter, socket } = await open(); const id = crypto.randomUUID();
    let work: import("../chat-notifications").ChatNotificationWork[] = []; adapter.onNotifications(value => { work = value; });
    await adapter.sendMessage("Identity check", "text", "Ada", "PM", { clientMessageId: id });
    socket.receive({ type: "message", message: confirmed(id) }); await vi.advanceTimersByTimeAsync(1);
    expect(work[0].status).toBe("failed");
  });
  it("retries an added reaction's notification without toggling the reaction again", async () => {
    fetcher.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    const { adapter, socket } = await open(); const id = crypto.randomUUID();
    socket.receive({ type: "message", message: confirmed(id, { senderId: "crew", senderName: "Crew" }) });
    const changing = adapter.toggleReaction(id, "👍");
    const mutation = JSON.parse(socket.sent.at(-1)!);
    socket.receive({ type: "message-edited", message: confirmed(id, { senderId: "crew", senderName: "Crew", reactions: [{ emoji: "👍", userIds: ["actor"] }] }) });
    socket.receive({ type: "mutation-result", requestId: mutation.requestId, ok: true });
    await changing; await vi.advanceTimersByTimeAsync(1);
    let work: import("../chat-notifications").ChatNotificationWork[] = []; adapter.onNotifications(value => { work = value; });
    expect(work).toMatchObject([{ status: "failed", command: { kind: "reaction", requestId: mutation.requestId } }]);
    adapter.retryNotifications(mutation.requestId); await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(1); expect(fetcher).toHaveBeenCalledTimes(2); expect(work).toEqual([]);
  });
});
