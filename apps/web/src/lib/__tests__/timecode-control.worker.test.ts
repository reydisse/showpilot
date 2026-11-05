import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";
import type { TimecodeWsMessage } from "@/types/timecode";

afterEach(() => abortAllDurableObjects());
type Fixture = Awaited<ReturnType<typeof timecodeFixture>>;
const cue = { id: "protected-cue", label: "Protected", action: "lyrics-clear", payload: {}, triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 } };
async function operator(test: Fixture, authority = test.authority) {
  const url = (path: string) => {
    const result = test.url(path);
    result.searchParams.set("authUserId", authority.userId);
    result.searchParams.set("authSessionId", authority.sessionId);
    return result;
  };
  const response = await test.stub.fetch(url("/ws"), { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing operator socket");
  const messages: TimecodeWsMessage[] = [];
  socket.addEventListener("message", message => { messages.push(JSON.parse(String(message.data))); });
  socket.accept();
  await expect.poll(() => messages.some(message => message.type === "hydrate")).toBe(true);
  return {
    socket, messages, url,
    async command(action: string, payload?: unknown) {
      const response = await test.stub.fetch(url("/command"), { method: "POST", body: JSON.stringify({ action, payload }) });
      return { status: response.status, body: await response.json() };
    },
    send(action: string, payload?: unknown) { socket.send(JSON.stringify({ type: "command", action, payload })); },
  };
}
async function contents(test: Fixture) {
  const state = await (await test.stub.fetch(test.url("/state"))).json();
  const events = await (await test.stub.fetch(test.url("/events"))).json();
  return { state, events };
}

it("requires an existing socket owner for HTTP, including a valid member with no control claim", async () => {
  const test = await timecodeFixture(undefined, undefined, false);
  const first = await operator(test);
  expect((await first.command("add-event", cue)).status).toBe(409);
  expect((await first.command("claim-control")).status).toBe(409);
  first.send("add-event", cue); // First explicit edit atomically takes free control.
  await expect.poll(async () => (await contents(test)).events).toEqual([expect.objectContaining({ id: cue.id })]);
  expect(first.messages).toContainEqual({ type: "control-status", control: "yours" });
  expect((await first.command("set-triggers-enabled", { enabled: false })).status).toBe(200);
  expect((await first.command("bridge-disconnected")).status).toBe(400);
  first.send("bridge-disconnected");
  await expect.poll(() => first.messages.some(message => message.type === "command-rejected" && message.action === "bridge-disconnected")).toBe(true);
});

it("rejects every mutation from a second socket or another authenticated HTTP session without changing state", async () => {
  const test = await timecodeFixture();
  const other = await operator(test, await seedRelayMember(test.orgId, `${test.orgId}-second`));
  const sameLogin = await operator(test);
  expect(other.messages[0]).toMatchObject({ type: "hydrate", control: "other" });
  expect((await sameLogin.command("add-event", cue)).status).toBe(200);
  const before = await contents(test);
  const mutations = [
    ["start"], ["stop"], ["feed-tc", { timecode: cue.triggerTimecode, format: { frameRate: 30, dropFrame: "ndf" } }],
    ["set-timecode", { timecode: cue.triggerTimecode }], ["set-source", { source: "mtc" }],
    ["set-format", { format: { frameRate: 25, dropFrame: "ndf" } }], ["add-event", { ...cue, id: "intruder" }],
    ["replace-event-group", { sourceKey: "intruder", events: [{ ...cue, id: "intruder" }] }],
    ["update-event", { id: cue.id, updates: { label: "Changed" } }], ["remove-event", { id: cue.id }],
    ["reset-events"], ["retry-event", { id: cue.id }], ["set-event-enabled", { id: cue.id, enabled: false }],
    ["set-triggers-enabled", { enabled: false }], ["set-lyrics", { songId: "intruder", lyrics: "Changed" }],
    ["clear-lyrics"], ["claim-control"], ["release-control"],
  ] as const;
  for (const [action, payload] of mutations) {
    expect((await other.command(action, payload)).status).toBe(409);
    other.send(action, payload);
    sameLogin.send(action, payload); // Same cookie does not give a second tab socket ownership.
  }
  for (const client of [other, sameLogin]) {
    await expect.poll(() => client.messages.filter(message => message.type === "command-rejected").length).toBe(mutations.length);
  }
  expect(await contents(test)).toEqual(before);
});

it("grants only one racing claim and retains the owner through hibernation", async () => {
  const test = await timecodeFixture(undefined, undefined, false);
  const a = await operator(test);
  const b = await operator(test, await seedRelayMember(test.orgId, `${test.orgId}-second`));
  a.send("claim-control"); b.send("claim-control");
  const granted = () => [a, b].filter(client => client.messages.some(message => message.type === "control-status" && message.control === "yours"));
  await expect.poll(() => granted().length).toBe(1);
  await expect.poll(() => [a, b].flatMap(client => client.messages).filter(message => message.type === "command-rejected").length).toBe(1);
  const winner = granted()[0];
  const loser = winner === a ? b : a;
  await evictDurableObject(test.stub);
  expect((await winner.command("add-event", cue)).status).toBe(200);
  expect((await loser.command("remove-event", { id: cue.id })).status).toBe(409);
  winner.send("release-control");
  await expect.poll(() => loser.messages.some(message => message.type === "control-status" && message.control === "available")).toBe(true);
  loser.send("claim-control");
  await expect.poll(() => loser.messages.some(message => message.type === "control-status" && message.control === "yours")).toBe(true);
  expect((await loser.command("remove-event", { id: cue.id })).status).toBe(200);
});

it("keeps Bridge timecode running while an editor claims and releases control", async () => {
  const test = await timecodeFixture(undefined, undefined, false);
  const editor = await operator(test);
  const bridge = async (frames: number) => {
    const response = await test.stub.fetch(test.url("/internal/bridge-feed"), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
      body: JSON.stringify({ payload: { timecode: { hours: 0, minutes: 0, seconds: 0, frames }, format: { frameRate: 30, dropFrame: "ndf" } } }) });
    expect(response.status).toBe(200); await response.arrayBuffer();
  };
  await bridge(1);
  editor.send("claim-control");
  await expect.poll(() => editor.messages.some(message => message.type === "control-status" && message.control === "yours")).toBe(true);
  expect((await editor.command("add-event", cue)).status).toBe(200);
  await bridge(2);
  expect((await contents(test)).state).toMatchObject({ running: true, source: "mtc", totalFrames: 2 });
  editor.send("release-control");
  await expect.poll(() => editor.messages.some(message => message.type === "control-status" && message.control === "available")).toBe(true);
  await bridge(3);
  expect((await contents(test)).state).toMatchObject({ running: true, totalFrames: 3 });
});

it.each(["disconnect", "permission-revoked"])("releases control on %s and does not let the previous owner write over its successor", async reason => {
  const test = await timecodeFixture();
  const next = await operator(test, await seedRelayMember(test.orgId, `${test.orgId}-second`));
  if (reason === "disconnect") test.controlSocket?.close();
  else {
    await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(test.orgId, test.authority.userId).run();
    await test.stub.refreshReadAuthority(test.authority.userId);
  }
  await expect.poll(() => next.messages.some(message => message.type === "control-status" && message.control === "available")).toBe(true);
  next.send("add-event", cue);
  await expect.poll(() => next.messages.some(message => message.type === "events-update" && message.events[0]?.id === cue.id)).toBe(true);
  const response = await test.stub.fetch(test.url("/command"), { method: "POST", body: JSON.stringify({ action: "remove-event", payload: { id: cue.id } }) });
  expect(response.status).toBe(reason === "disconnect" ? 409 : 401);
});

it("requires stopping an owned local clock before releasing control", async () => {
  const test = await timecodeFixture(undefined, undefined, false);
  const owner = await operator(test);
  owner.send("start");
  await expect.poll(() => owner.messages.some(message => message.type === "master-status" && message.granted)).toBe(true);
  owner.send("release-control");
  await expect.poll(() => owner.messages.some(message => message.type === "command-rejected" && message.action === "release-control")).toBe(true);
  expect((await owner.command("stop")).status).toBe(200);
  owner.send("release-control");
  await expect.poll(() => owner.messages.some(message => message.type === "control-status" && message.control === "available")).toBe(true);
});

it("rejects delayed feeds after Stop or release, without restarting or reclaiming control", async () => {
  const test = await timecodeFixture(undefined, undefined, false);
  const owner = await operator(test);
  owner.send("start");
  await expect.poll(() => owner.messages.some(message => message.type === "master-status" && message.granted)).toBe(true);
  const feed = { timecode: cue.triggerTimecode, format: { frameRate: 30, dropFrame: "ndf" } };
  expect((await owner.command("feed-tc", feed)).status).toBe(200);
  expect((await owner.command("stop")).status).toBe(200);
  const stopped = await contents(test);
  expect((await owner.command("feed-tc", feed)).status).toBe(400);
  owner.send("release-control");
  await expect.poll(() => owner.messages.some(message => message.type === "control-status" && message.control === "available")).toBe(true);
  owner.send("feed-tc", feed);
  await expect.poll(() => owner.messages.some(message => message.type === "command-rejected" && message.action === "feed-tc")).toBe(true);
  expect(await contents(test)).toEqual(stopped);
  expect((await owner.command("set-timecode", { timecode: cue.triggerTimecode })).status).toBe(409);
});

it("preserves an existing generator's ownership when restoring a pre-ownership socket attachment", async () => {
  const test = await timecodeFixture();
  const sameLogin = await operator(test);
  expect((await sameLogin.command("start")).status).toBe(200);
  await runInDurableObject(test.stub, (_instance, ctx) => {
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      delete attachment.controlsTimecode;
      socket.serializeAttachment(attachment);
    }
  });
  await evictDurableObject(test.stub);
  sameLogin.send("set-timecode", { timecode: cue.triggerTimecode });
  await expect.poll(() => sameLogin.messages.some(message => message.type === "command-rejected" && message.action === "set-timecode")).toBe(true);
  test.controlSocket?.send(JSON.stringify({ type: "command", action: "feed-tc", payload: { timecode: cue.triggerTimecode, format: { frameRate: 30, dropFrame: "ndf" } } }));
  await expect.poll(async () => (await contents(test)).state).toMatchObject({ totalFrames: 300, running: true });
});
