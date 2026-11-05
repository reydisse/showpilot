import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";
import { readRelaySequence, RelaySequenceTracker } from "@/lib/relay-sequence";

afterEach(() => abortAllDurableObjects());
async function listen(stub: { fetch: typeof fetch }, url: URL) {
  const response = await stub.fetch(url, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing relay socket");
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener("message", event => { messages.push(JSON.parse(String(event.data))); });
  socket.accept();
  await expect.poll(() => messages.some(message => message.type === "hydrate")).toBe(true);
  return { socket, messages };
}

it("persists timecode revisions across eviction and keeps predecessors specific to the reader's projection", async () => {
  const test = await timecodeFixture();
  const writer = await listen(test.stub, test.url("/ws"));
  const displayUrl = test.url("/ws", "read");
  displayUrl.searchParams.delete("authUserId"); displayUrl.searchParams.delete("authSessionId");
  const reader = await listen(test.stub, displayUrl);
  const writerTracker = new RelaySequenceTracker(); writerTracker.snapshot(writer.messages[0]);
  const readerTracker = new RelaySequenceTracker(); readerTracker.snapshot(reader.messages[0]);
  const command = async (action: string, payload?: unknown) => {
    const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
    expect(response.status).toBe(200); await response.arrayBuffer();
  };
  await command("add-event", { id: "cue", action: "lyrics-clear", triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, label: "Private timeline", payload: { secret: "never-public" } });
  await expect.poll(() => writer.messages.some(message => message.type === "events-update")).toBe(true);
  const event = writer.messages.find(message => message.type === "events-update");
  expect(writerTracker.delta(event)).toBe("apply");
  expect(reader.messages).toHaveLength(1);
  await evictDurableObject(test.stub);
  await command("set-timecode", { timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 } });
  await expect.poll(() => reader.messages.some(message => message.type === "tc-update")).toBe(true);
  const publicUpdate = reader.messages.find(message => message.type === "tc-update");
  expect(readRelaySequence(publicUpdate)?.sequence).toBeGreaterThan(readRelaySequence(event)?.sequence ?? 0);
  expect(readerTracker.delta(publicUpdate)).toBe("apply"); // Writer-only sequence was intentionally skipped.
  expect(JSON.stringify(reader.messages)).not.toContain("never-public");
  reader.socket.send(JSON.stringify({ type: "sync", lastSeenSequence: 0 }));
  await expect.poll(() => reader.messages.filter(message => message.type === "hydrate").length).toBe(2);
  expect(reader.messages.at(-1)).not.toHaveProperty("events");
  writer.socket.close(); reader.socket.close();
  const reconnected = await listen(test.stub, test.url("/ws"));
  expect(readRelaySequence(reconnected.messages[0])?.sequence).toBeGreaterThan(readRelaySequence(event)?.sequence ?? 0);
  expect(reconnected.messages[0]).toMatchObject({ events: [expect.objectContaining({ id: "cue" })] });
  reconnected.socket.close();
});

it("persists cue-sheet revisions, hydrates reconnects and treats a legacy ping as a read", async () => {
  const member = await seedRelayMember(`sequence-cues-${crypto.randomUUID()}`);
  const stub = env.CUE_SHEET_RELAY.getByName(member.orgId);
  const url = new URL("https://cue-sheet.test/ws");
  for (const [key, value] of Object.entries({ orgId: member.orgId, authUserId: member.userId, authSessionId: member.sessionId, access: "columns,notes" })) url.searchParams.set(key, value);
  const first = await listen(stub, url);
  first.socket.send(JSON.stringify({ type: "ping" }));
  await expect.poll(() => first.messages.some(message => message.type === "pong")).toBe(true);
  const publish = async (text: string) => {
    const endpoint = new URL(url); endpoint.pathname = "/broadcast";
    const response = await stub.fetch(endpoint, { method: "POST", body: JSON.stringify({ type: "note", showId: "show", serviceDate: "2026-11-05", itemId: "item", columnId: "column", text, by: "Operator", at: Date.now() }) });
    expect(response.status).toBe(200); await response.arrayBuffer();
  };
  await publish("Before disconnect");
  await expect.poll(() => first.messages.some(message => message.type === "note")).toBe(true);
  const before = readRelaySequence(first.messages.find(message => message.type === "note"));
  expect(before?.sequence).toBeGreaterThan(0);
  first.socket.close();
  await evictDurableObject(stub);
  await publish("While disconnected");
  const second = await listen(stub, url);
  expect(readRelaySequence(second.messages[0])?.sequence).toBeGreaterThan(before?.sequence ?? 0);
  second.socket.send(JSON.stringify({ type: "sync" }));
  await expect.poll(() => second.messages.length).toBe(2);
  expect(second.messages[1].type).toBe("hydrate");
  second.socket.close();
});
