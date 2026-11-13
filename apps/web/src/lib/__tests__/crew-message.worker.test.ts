import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { timecodeRelayKey } from "../timecode-target.server";
import type { AutomationEvent } from "@/types/timecode";
import type { ChatRelay } from "@/durable-objects/ChatRelay";
import type { CrewMessageDelivery } from "../crew-message";

// Normalize Cloudflare's pipelined RPC thenable before attaching assertions.
async function post(stub: DurableObjectStub<ChatRelay>, delivery: CrewMessageDelivery) {
  const result = await stub.postAutomationCue(delivery);
  if (!result.ok) throw new Error(result.error);
  return result;
}

afterEach(abortAllDurableObjects);
const zero = { hours: 0, minutes: 0, seconds: 0, frames: 0 };
const cue = { id: "crew", action: "crew-message", label: "Camera standby", triggerTimecode: zero, payload: { message: "Standby cameras\nCamera 2 next" } };
type Message = { id: string; timestamp: number; text: string; roomId: string; senderId: string; senderName: string; type: string; deletedAt?: number; externalDelivery?: { platform: string; status: string; error?: string } };

async function fixture() {
  const test = await timecodeFixture();
  const chat = env.CHAT_RELAY.getByName(`${test.orgId}:production`);
  const chatUrl = (path: string, room = "production") => `https://chat.test${path}?${new URLSearchParams({ orgId: test.orgId, room, userId: test.authority.userId, name: "Spoofed name", role: "Spoofed role", access: "write", authUserId: test.authority.userId, authSessionId: test.authority.sessionId })}`;
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    expect(response.status).toBe(status); await response.text();
  };
  const history = async (room = "production") => (await env.CHAT_RELAY.getByName(`${test.orgId}:${room}`).fetch(chatUrl("/history", room))).json<{ messages: Message[] }>();
  return { ...test, chat, chatUrl, command, history,
    delivery: () => ({ orgId: test.orgId, showId: test.target.showId, eventId: cue.id, executionId: crypto.randomUUID(), payload: cue.payload, authority: test.authority, deadline: Date.now() + 10000 }),
    events: async () => (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
  };
}

it("posts a timed cue only to Production Chat, with server-owned sender identity and a live broadcast", async () => {
  const test = await fixture();
  const response = await test.chat.fetch(test.chatUrl("/ws"), { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing chat socket");
  const received: Message[] = [];
  socket.addEventListener("message", event => { const frame = JSON.parse(String(event.data)); if (frame.type === "message") received.push(frame.message); });
  socket.accept();
  await test.command("add-event", cue);
  await test.command("start");
  const feed = { timecode: zero, format: { frameRate: 30, dropFrame: "ndf" } };
  await test.command("feed-tc", feed);
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]).toMatchObject({ text: cue.payload.message, roomId: "production", senderId: test.authority.userId, senderName: "Relay operator · Automation", type: "cue" });
  expect((await test.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  await test.command("feed-tc", feed);
  expect((await test.history()).messages).toHaveLength(1);
  expect((await test.history("planning")).messages).toEqual([]);
  const rundown = env.RUNDOWN_RELAY.getByName(timecodeRelayKey(test.target));
  const rdUrl = test.url("/state"); rdUrl.searchParams.set("access", "read");
  expect(await (await rundown.fetch(rdUrl)).json()).toMatchObject({ stageMessage: "" });
});

it("honors disabled cues, kill switch, retry and reviewed re-fire without duplicate retries", async () => {
  const test = await fixture();
  await test.command("add-event", { ...cue, enabled: false });
  await test.command("fire-event", { id: cue.id }, 400);
  expect((await test.history()).messages).toEqual([]);
  await test.command("set-event-enabled", { id: cue.id, enabled: true });
  await test.command("set-triggers-enabled", { enabled: false });
  await test.command("fire-event", { id: cue.id }, 400);
  await test.command("set-triggers-enabled", { enabled: true });
  await test.command("fire-event", { id: cue.id });
  const first = (await test.events())[0];
  await test.command("retry-event", { id: cue.id });
  expect((await test.history()).messages).toHaveLength(1);
  expect((await test.events())[0].executionId).toBe(first.executionId);
  await test.command("fire-event", { id: cue.id }, 400);
  await test.command("rearm-event", { id: cue.id, confirmed: true, expected: { fired: true, skipped: false, executionId: first.executionId } });
  await test.command("fire-event", { id: cue.id });
  expect((await test.history()).messages).toHaveLength(2);
  expect((await test.events())[0].executionId).not.toBe(first.executionId);
  await test.command("retry-event", { id: cue.id, confirmed: true, expected: { fired: true, skipped: false, executionId: first.executionId } }, 400);
  const current = (await test.events())[0];
  await test.command("retry-event", { id: cue.id, confirmed: true, expected: { fired: true, skipped: false, executionId: current.executionId } });
  expect((await test.history()).messages).toHaveLength(3);
  expect((await test.events())[0].executionId).not.toBe(current.executionId);
});

it("requires the same reviewed re-fire contract for other acknowledged output actions", async () => {
  const test = await fixture();
  await test.command("add-event", { ...cue, action: "stage-message", payload: { message: "Standby" } });
  await test.command("fire-event", { id: cue.id });
  const sent = (await test.events())[0];
  expect(sent.fired).toBe(true);
  await test.command("retry-event", { id: cue.id }, 400);
  await test.command("retry-event", { id: cue.id, confirmed: true, expected: { fired: true, skipped: false, executionId: "stale" } }, 400);
  expect((await test.events())[0].executionId).toBe(sent.executionId);
  await test.command("retry-event", { id: cue.id, confirmed: true, expected: { fired: true, skipped: false, executionId: sent.executionId } });
  expect((await test.events())[0].fired).toBe(true);
  expect((await test.events())[0].executionId).not.toBe(sent.executionId);
});

it("reports a receipt conflict as failed and requires re-arming before posting edited content", async () => {
  const test = await fixture();
  await test.command("add-event", cue);
  await test.command("fire-event", { id: cue.id });
  await test.command("update-event", { id: cue.id, updates: { payload: { message: "Camera 3 instead" } } });
  await test.command("retry-event", { id: cue.id });
  const failed = (await test.events())[0];
  expect(failed).toMatchObject({ fired: false, executionStatus: "failed", executionRetryable: false });
  expect(failed.executionError).toContain("different content");
  expect((await test.history()).messages.map(message => message.text)).toEqual([cue.payload.message]);
  await test.command("rearm-event", { id: cue.id, confirmed: true, expected: { fired: false, skipped: false, executionId: failed.executionId } });
  await test.command("fire-event", { id: cue.id });
  expect((await test.history()).messages.map(message => message.text)).toEqual([cue.payload.message, "Camera 3 instead"]);
});

it("acknowledges the native post but exposes a linked chat configuration failure separately", async () => {
  const test = await fixture();
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'chat-adapter','slack')").bind(crypto.randomUUID(), test.orgId).run();
  await test.command("add-event", cue);
  await test.command("fire-event", { id: cue.id });
  expect((await test.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  await expect.poll(async () => (await test.history()).messages[0].externalDelivery?.status).toBe("failed");
  expect((await test.history()).messages[0].externalDelivery).toMatchObject({ platform: "slack", status: "failed", error: expect.stringContaining("Slack") });
  await test.command("retry-event", { id: cue.id });
  expect((await test.history()).messages).toHaveLength(1);
});

it("recovers an interrupted cue after chat committed but before timecode received its acknowledgment", async () => {
  const test = await fixture();
  await test.command("add-event", cue);
  const delivery = test.delivery();
  await runInDurableObject(test.stub, async (_instance, ctx) => {
    const snapshot = await ctx.storage.get<{ events: AutomationEvent[] }>("timecode");
    if (!snapshot) throw new Error("Missing timeline");
    Object.assign(snapshot.events[0], { executionStatus: "dispatching", executionId: delivery.executionId, executionAttempts: 1 });
    await ctx.storage.put("timecode", snapshot);
  });
  await post(test.chat, delivery);
  await evictDurableObject(test.chat);
  await evictDurableObject(test.stub);
  expect((await test.events())[0]).toMatchObject({ fired: false, executionStatus: "failed", executionId: delivery.executionId });
  await test.command("retry-event", { id: cue.id });
  expect((await test.events())[0]).toMatchObject({ fired: true, executionStatus: "acknowledged", executionId: delivery.executionId });
  expect((await test.history()).messages).toHaveLength(1);
});

it("deduplicates concurrent delivery and hibernation, and rejects changed content for an existing receipt", async () => {
  const test = await fixture();
  const delivery = test.delivery();
  const results = await Promise.all([post(test.chat, delivery), post(test.chat, delivery)]);
  expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
  expect(new Set(results.map(result => result.messageId)).size).toBe(1);
  await evictDurableObject(test.chat);
  expect(await post(test.chat, { ...delivery, deadline: Date.now() + 10000 })).toMatchObject({ duplicate: true, messageId: results[0].messageId });
  await expect(post(test.chat, { ...delivery, payload: { message: "Changed content" }, deadline: Date.now() + 10000 })).rejects.toThrow("different content");
  expect((await test.history()).messages).toHaveLength(1);
});

it("keeps a deleted message deleted when its delivery is retried", async () => {
  const test = await fixture();
  const delivery = test.delivery();
  const sent = await post(test.chat, delivery);
  const response = await test.chat.fetch(test.chatUrl("/ws"), { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing chat socket");
  socket.accept();
  const original = (await test.history()).messages[0];
  socket.send(JSON.stringify({ type: "mutation", command: {
    orgId: test.orgId, userId: test.authority.userId, roomId: "production", messageId: sent.messageId,
    requestId: crypto.randomUUID(), expiresAt: Date.now() + 10000,
    operation: { kind: "delete", expectedEditTime: original.timestamp },
  } }));
  await expect.poll(async () => (await test.history()).messages[0].deletedAt).toBeTypeOf("number");
  await evictDurableObject(test.chat);
  await post(test.chat, { ...delivery, deadline: Date.now() + 10000 });
  const messages = (await test.history()).messages;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: "", deletedAt: expect.any(Number) });
});

it.each([{ message: " " }, { message: "x".repeat(4001) }, { message: "Hi", room: "planning" }, { message: 42 }])("rejects malformed payloads on every timeline write: %j", async payload => {
  const test = await fixture();
  await test.command("add-event", cue);
  await test.command("add-event", { ...cue, id: "bad", payload }, 400);
  await test.command("update-event", { id: cue.id, updates: { payload } }, 400);
  await test.command("replace-event-group", { sourceKey: "crew", events: [{ ...cue, payload }] }, 400);
  expect((await test.events())[0].payload).toEqual(cue.payload);
  expect((await test.history()).messages).toEqual([]);
});

it("rejects foreign shows/orgs, non-production rooms, expired requests and revoked sessions", async () => {
  const test = await fixture();
  const other = await fixture();
  await expect(post(test.chat, { ...test.delivery(), showId: other.target.showId })).rejects.toThrow("current timecode and chat access");
  await expect(post(test.chat, { ...test.delivery(), orgId: other.orgId })).rejects.toThrow("organization mismatch");
  await test.history("planning");
  await expect(post(env.CHAT_RELAY.getByName(`${test.orgId}:planning`), test.delivery())).rejects.toThrow("Production Chat");
  await expect(post(test.chat, { ...test.delivery(), deadline: Date.now() - 1 })).rejects.toThrow("expired");
  await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
  await expect(post(test.chat, test.delivery())).rejects.toThrow("current timecode and chat access");
  await env.DB.prepare("DELETE FROM session WHERE id=? AND userId=?").bind(test.authority.sessionId, test.authority.userId).run();
  await expect(post(test.chat, test.delivery())).rejects.toThrow("current timecode and chat access");
  expect((await test.history()).messages).toEqual([]);
});
