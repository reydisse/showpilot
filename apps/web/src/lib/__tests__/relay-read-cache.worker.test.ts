import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { TestTimecodeRelay } from "@/test/worker-entry";
import { seedRelayMember } from "@/test/relay-fixtures";

const roomKinds = ["timecode", "rundown", "bridge", "graphics", "cue-sheet", "chat", "chat-planning"] as const;
type RoomKind = typeof roomKinds[number];

async function readRoom(kind: RoomKind) {
  const orgId = `read-cache-${crypto.randomUUID()}`;
  const member = await seedRelayMember(orgId);
  const clock = kind === "timecode" ? await timecodeFixture(orgId) : null;
  const stub = clock?.stub ?? (kind === "rundown" ? env.RUNDOWN_RELAY.getByName(orgId)
    : kind === "bridge" ? env.BRIDGE_RELAY.getByName(orgId)
    : kind === "graphics" ? env.LOWER_THIRDS_RELAY.getByName(orgId)
    : kind === "cue-sheet" ? env.CUE_SHEET_RELAY.getByName(orgId)
    : env.CHAT_RELAY.getByName(`${orgId}:${kind === "chat-planning" ? "planning" : "production"}`));
  const url = clock?.url("/ws") ?? new URL("https://relay.test/ws");
  for (const [name, value] of Object.entries({ orgId, authUserId: member.userId, authSessionId: member.sessionId, userId: member.userId, room: kind === "chat-planning" ? "planning" : "production", access: ["rundown", "graphics", "cue-sheet"].includes(kind) ? "observe" : "write", role: "client" })) url.searchParams.set(name, value);
  const response = await stub.fetch(url, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing reader socket");
  const hydrated = kind === "graphics" || kind === "cue-sheet" ? Promise.resolve()
    : new Promise(resolve => socket.addEventListener("message", resolve, { once: true }));
  socket.accept(); await hydrated;
  return { orgId, member, stub, socket, url };
}

afterEach(() => abortAllDurableObjects());
describe("relay read authorization cache", () => {
  it.each(roomKinds)("refreshes %s reads by alarm and cuts revoked idle readers off after hibernation", async kind => {
    const test = await readRoom(kind);
    const deadline = await runInDurableObject(test.stub, async (_instance, ctx) => ctx.storage.getAlarm());
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThanOrEqual(Date.now() + 30_000);
    await evictDurableObject(test.stub);
    const closed = new Promise<CloseEvent>(resolve => test.socket.addEventListener("close", resolve, { once: true }));
    await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.member.userId).run();
    expect(await runDurableObjectAlarm(test.stub)).toBe(true);
    expect(await closed).toMatchObject({ code: 4403 });
  });

  it.each(roomKinds)("refreshes a healthy %s reader and accepts a permission-change push", async kind => {
    const test = await readRoom(kind);
    await runInDurableObject(test.stub, async (_instance, ctx) => {
      for (const socket of ctx.getWebSockets()) {
        const current: unknown = socket.deserializeAttachment();
        if (!current || typeof current !== "object") throw new Error("Missing read attachment");
        socket.serializeAttachment({ ...current, readAuthorizedUntil: Date.now() + 1000 });
      }
    });
    await runDurableObjectAlarm(test.stub);
    await runInDurableObject(test.stub, async (_instance, ctx) => {
      const current: unknown = ctx.getWebSockets()[0].deserializeAttachment();
      expect(current).toHaveProperty("readAuthorizedUntil", expect.any(Number));
      if (!current || typeof current !== "object" || !("readAuthorizedUntil" in current) || typeof current.readAuthorizedUntil !== "number") throw new Error("Missing refreshed lease");
      expect(current.readAuthorizedUntil).toBeGreaterThan(Date.now() + 30_000);
    });
    const closed = new Promise<CloseEvent>(resolve => test.socket.addEventListener("close", resolve, { once: true }));
    await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(test.member.sessionId).run();
    await test.stub.refreshReadAuthority(test.member.userId);
    expect(await closed).toMatchObject({ code: 4403 });
  });

  it.each(["graphics", "cue-sheet", "chat"] as const)("rejects an expired %s member on upgrade instead of granting a display session", async kind => {
    const test = await readRoom(kind);
    await env.DB.prepare("UPDATE session SET expiresAt='2000-01-01' WHERE id=?").bind(test.member.sessionId).run();
    const response = await test.stub.fetch(test.url, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(401); await response.text();
    test.socket.close();
  });

  it.each(["graphics", "cue-sheet", "chat"] as const)("stops %s delivery when read refresh is overdue", async kind => {
    const test = await readRoom(kind);
    await evictDurableObject(test.stub);
    await runInDurableObject(test.stub, async (_instance, ctx) => {
      const server = ctx.getWebSockets()[0];
      const current: unknown = server.deserializeAttachment();
      if (!current || typeof current !== "object") throw new Error("Missing attachment");
      server.serializeAttachment({ ...current, readAuthorizedUntil: Date.now() - 1 });
    });
    const messages: unknown[] = [];
    test.socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
    const closed = new Promise<CloseEvent>(resolve => test.socket.addEventListener("close", resolve, { once: true }));
    const url = new URL(test.url);
    url.pathname = kind === "graphics" ? "/trigger" : kind === "cue-sheet" ? "/broadcast" : "/send";
    url.searchParams.set("access", kind === "cue-sheet" ? "notes" : "write");
    const body = kind === "graphics" ? { line1: "Private graphic" }
      : kind === "cue-sheet" ? { type: "note", serviceDate: "2026-11-05", itemId: "fixture", columnId: "fixture", text: "Private note", by: "Fixture", at: 1 }
      : { text: "Private message" };
    const response = await test.stub.fetch(url, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(200); await response.text();
    expect(await closed).toMatchObject({ code: 4403 });
    expect(messages).toEqual([]);
  });

  it("does not broadcast private state after a lease expires even if its alarm is delayed", async () => {
    const test = await timecodeFixture();
    const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing writer");
    const hydrated = new Promise(resolve => socket.addEventListener("message", resolve, { once: true }));
    socket.accept(); await hydrated;
    const messages: unknown[] = [];
    socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
    await runInDurableObject(test.stub, async (_instance, ctx) => {
      const server = ctx.getWebSockets()[0];
      const current: unknown = server.deserializeAttachment();
      if (!current || typeof current !== "object") throw new Error("Missing attachment");
      server.serializeAttachment({ ...current, readAuthorizedUntil: Date.now() - 1 });
    });
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", resolve, { once: true }));
    const update = await test.stub.fetch(test.url("/command"), { method: "POST", body: '{"action":"set-lyrics","payload":{"songId":"fixture","songTitle":"Fixture","sectionId":"verse","sectionLabel":"Verse","lyrics":"Private lyric"}}' });
    expect(update.status).toBe(200); await update.text();
    expect(await closed).toMatchObject({ code: 4403 });
    expect(messages).toEqual([]);
  });

  it("broadcasts a 10 Hz feed to four operator sockets without any D1 reads", async () => {
    const test = await timecodeFixture();
    const sockets: WebSocket[] = [];
    const received = [0, 0, 0, 0];
    for (let index = 0; index < received.length; index++) {
      const response = await test.stub.fetch(test.url("/ws"), { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      if (!socket) throw new Error("Missing operator socket");
      const hydrate = new Promise(resolve => socket.addEventListener("message", resolve, { once: true }));
      socket.addEventListener("message", event => { if (JSON.parse(String(event.data)).type === "tc-update") received[index]++; });
      socket.accept(); await hydrate;
      sockets.push(socket);
    }
    const queryCount = () => runInDurableObject(test.stub, async instance => {
      if (!(instance instanceof TestTimecodeRelay)) throw new Error("Missing instrumented real relay");
      return instance.getQueryCount();
    });
    const before = await queryCount();
    for (let tick = 0; tick < 10; tick++) {
      const response = await test.stub.fetch(test.url("/internal/bridge-feed"), {
        method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
        body: JSON.stringify({ payload: { timecode: { hours: 0, minutes: 0, seconds: 0, frames: tick * 3 }, format: { frameRate: 30, dropFrame: "ndf" } } }),
      });
      expect(response.status).toBe(200); await response.text();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(received.every(count => count >= 10)).toBe(true);
    expect(new Set(received).size).toBe(1);
    expect(await queryCount()).toBe(before);
    for (const socket of sockets) socket.close();
  });
});
