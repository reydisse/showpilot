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
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.onclose?.(); }
}

describe("NativeChatAdapter recovery and history", () => {
  beforeEach(() => {
    localStorage.clear();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => vi.unstubAllGlobals());

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
