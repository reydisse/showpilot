import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";
import { mediaStorageKey } from "../media-library.server";
import {
  MediaOutputManager,
  isMediaOutputSocket,
} from "../media-output.server";
import {
  mediaOutputServerMessageSchema,
  type MediaOutputServerMessage,
} from "../media-output";
import { cueReviewState } from "../automation-cues";
import type {
  AutomationEvent,
  TimecodeState,
  TimecodeDisplayState,
} from "@/types/timecode";

const buckets: string[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
afterEach(async () => {
  timers.splice(0).forEach(clearInterval);
  await abortAllDurableObjects();
  for (const key of buckets.splice(0)) await env.STORAGE.delete(key);
});
const zero = { hours: 0, minutes: 0, seconds: 0, frames: 0 };
type Execute = Extract<MediaOutputServerMessage, { type: "media-execute" }>;

async function fixture(orgId?: string, showId?: string) {
  const test = await timecodeFixture(orgId, showId);
  const mediaId = crypto.randomUUID();
  const key = mediaStorageKey(test.orgId, mediaId);
  buckets.push(key);
  const object = await env.STORAGE.put(key, "RIFF1234WAVEfixture media bytes", {
    httpMetadata: { contentType: "audio/wav" },
    customMetadata: { name: "Opening sting.wav" },
  });
  const play = {
    id: "play",
    action: "media-play",
    label: "Opening sting",
    triggerTimecode: zero,
    toleranceFrames: 0,
    payload: {
      output: "Program",
      mediaId,
      etag: object!.httpEtag,
      volume: 0.5,
    },
  };
  const stop = {
    id: "stop",
    action: "media-stop",
    label: "Stop program",
    triggerTimecode: { ...zero, frames: 1 },
    toleranceFrames: 0,
    payload: { output: "Program" },
  };
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), {
      method: "POST",
      body: JSON.stringify({ action, payload }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(status);
  };
  return {
    ...test,
    mediaId,
    key,
    play,
    stop,
    command,
    state: async () =>
      (await test.stub.fetch(test.url("/state"))).json<TimecodeState>(),
    events: async () =>
      (await test.stub.fetch(test.url("/events"))).json<AutomationEvent[]>(),
  };
}

async function output(
  test: Awaited<ReturnType<typeof fixture>>,
  name = "Program",
  arm = true,
) {
  const authority = await seedRelayMember(
    test.orgId,
    `output-${crypto.randomUUID()}`,
  );
  const url = test.url("/media-ws");
  url.searchParams.set("authUserId", authority.userId);
  url.searchParams.set("authSessionId", authority.sessionId);
  const response = await test.stub.fetch(url, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing output socket");
  const messages: MediaOutputServerMessage[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(
      mediaOutputServerMessageSchema.parse(JSON.parse(String(event.data))),
    );
  });
  socket.accept();
  await expect
    .poll(() => messages.some((message) => message.type === "media-hello"))
    .toBe(true);
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  if (arm) {
    send({ type: "media-arm", output: name, requestId: "arm" });
    await expect
      .poll(() => messages.some((message) => message.type === "media-armed"))
      .toBe(true);
  }
  timers.push(
    setInterval(() => {
      if (socket.readyState === WebSocket.OPEN)
        send({ type: "media-ping", nonce: crypto.randomUUID() });
    }, 4000),
  );
  const commands = () =>
    messages.filter(
      (message): message is Execute => message.type === "media-execute",
    );
  const next = async (index = 0) => {
    await expect.poll(() => commands().length).toBeGreaterThan(index);
    return commands()[index];
  };
  const acknowledge = (
    command: Pick<Execute, "executionId" | "requestId">,
    result = { ok: true, state: "playing" },
  ) =>
    send({
      type: "media-result",
      executionId: command.executionId,
      requestId: command.requestId,
      result,
    });
  return { socket, authority, messages, send, commands, next, acknowledge };
}

async function interrupt(
  test: Awaited<ReturnType<typeof fixture>>,
  id = "play",
  uncertainReceipt = false,
) {
  await runInDurableObject(test.stub, async (_instance, ctx) => {
    const snapshot = await ctx.storage.get<{ events: AutomationEvent[] }>(
      "timecode",
    );
    const event = snapshot?.events.find((event) => event.id === id);
    if (!snapshot || !event) throw new Error("Missing event");
    event.executionStatus = "dispatching";
    event.fired = false;
    if (uncertainReceipt)
      ctx.storage.sql.exec(
        "UPDATE media_cue_receipts SET status='pending' WHERE execution_id=?",
        event.executionId!,
      );
    await ctx.storage.put("timecode", snapshot);
  });
  await evictDurableObject(test.stub);
}

it("fires timed Play and Stop and waits for the selected output's actual acknowledgments", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  await test.command("add-event", test.stop);
  await test.command("start");
  const started = test.command("feed-tc", {
    timecode: zero,
    format: { frameRate: 30, dropFrame: "ndf" },
  });
  const play = await player.next();
  expect(play.command).toMatchObject({
    action: "media-play",
    asset: { id: test.mediaId, name: "Opening sting.wav" },
    volume: 0.5,
  });
  expect((await test.events())[0]).toMatchObject({
    fired: false,
    executionStatus: "dispatching",
  });
  player.acknowledge(play);
  await started;
  expect((await test.events())[0]).toMatchObject({
    fired: true,
    executionStatus: "acknowledged",
  });
  const stopped = test.command("feed-tc", {
    timecode: { ...zero, frames: 1 },
    format: { frameRate: 30, dropFrame: "ndf" },
  });
  const stop = await player.next(1);
  expect(stop.command.action).toBe("media-stop");
  player.acknowledge(stop, { ok: true, state: "stopped" });
  await stopped;
  expect((await test.events()).every((event) => event.fired)).toBe(true);
  expect((await test.state()).mediaOutputs).toMatchObject([
    { name: "Program", status: "stopped" },
  ]);
});

it("keeps output windows separate from show control and refuses a second owner of the same named output", async () => {
  const test = await fixture();
  const first = await output(test);
  const second = await output(test, "program", false);
  second.send({ type: "media-arm", output: "program", requestId: "other" });
  await expect
    .poll(() =>
      second.messages.some((message) => message.type === "media-rejected"),
    )
    .toBe(true);
  const closed = new Promise<number>((resolve) =>
    first.socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  first.send({ type: "command", action: "claim-control" });
  expect(await closed).toBe(4400);
  expect((await test.state()).running).toBe(false);
  expect(
    first.messages.every((message) => message.type.startsWith("media-")),
  ).toBe(true);
});

it("waits for Play acknowledgement before dispatching Stop on the same normalized output", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  await test.command("add-event", {
    ...test.stop,
    triggerTimecode: zero,
    payload: { output: "program" },
  });
  await test.command("start");
  const feed = test.command("feed-tc", {
    timecode: zero,
    format: { frameRate: 30, dropFrame: "ndf" },
  });
  const play = await player.next();
  expect(player.commands()).toHaveLength(1);
  expect(
    (await test.events()).find((event) => event.id === "stop")?.fired,
  ).toBe(false);
  player.acknowledge(play);
  const stop = await player.next(1);
  expect(stop.command.action).toBe("media-stop");
  player.acknowledge(stop, { ok: true, state: "stopped" });
  await feed;
  expect((await test.events()).every((event) => event.fired)).toBe(true);
});

it("does not resend an acknowledged Stop after a new clip starts and the relay restarts", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.stop);
  await test.command("add-event", test.play);
  const stopping = test.command("fire-event", { id: "stop" });
  const stop = await player.next();
  player.acknowledge(stop, { ok: true, state: "stopped" });
  await stopping;
  const playing = test.command("fire-event", { id: "play" });
  const play = await player.next(1);
  player.acknowledge(play);
  await playing;
  await interrupt(test, "stop");
  await test.command("retry-event", { id: "stop" });
  expect(player.commands()).toHaveLength(2);
  expect(
    (await test.events()).find((event) => event.id === "stop"),
  ).toMatchObject({ fired: true, executionStatus: "acknowledged" });
  expect((await test.state()).mediaOutputs?.[0].status).toBe("playing");
});

it("does not guess success or replay when the output has forgotten an uncertain receipt", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  const firing = test.command("fire-event", { id: "play" });
  const play = await player.next();
  player.acknowledge(play);
  await firing;
  await interrupt(test, "play", true);
  const retry = test.command("retry-event", { id: "play" });
  await expect
    .poll(() =>
      player.messages.some((message) => message.type === "media-query"),
    )
    .toBe(true);
  player.send({
    type: "media-unknown",
    requestId: play.requestId,
    executionId: play.executionId,
  });
  await retry;
  expect(player.commands()).toHaveLength(1);
  expect((await test.events())[0]).toMatchObject({
    fired: false,
    executionStatus: "failed",
    executionError: expect.stringContaining("re-arm"),
  });
});

it("keeps identical output names independent between two shows in the same organization", async () => {
  const first = await fixture();
  const second = await fixture(first.orgId, "second-show");
  const one = await output(first);
  const two = await output(second);
  await first.command("add-event", first.play);
  await second.command("add-event", second.play);
  const fireOne = first.command("fire-event", { id: "play" });
  const commandOne = await one.next();
  one.acknowledge(commandOne);
  await fireOne;
  expect(two.commands()).toHaveLength(0);
  expect((await second.events())[0].fired).toBe(false);
  const fireTwo = second.command("fire-event", { id: "play" });
  const commandTwo = await two.next();
  two.acknowledge(commandTwo);
  await fireTwo;
  expect(one.commands()).toHaveLength(1);
  expect((await second.events())[0].fired).toBe(true);
});

it("expires a silent output after relay hibernation and rejects a late heartbeat", async () => {
  const test = await fixture();
  const player = await output(test);
  const closed = new Promise<number>((resolve) =>
    player.socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  await runInDurableObject(test.stub, async (_instance, ctx) => {
    const schema = z
      .object({
        media: z.object({
          output: z.object({ until: z.number() }).passthrough().nullable(),
        }),
      })
      .passthrough();
    for (const socket of ctx.getWebSockets()) {
      const attachment = schema.safeParse(socket.deserializeAttachment());
      if (attachment.success && attachment.data.media.output) {
        attachment.data.media.output.until = Date.now() - 1;
        socket.serializeAttachment(attachment.data);
      }
    }
  });
  await evictDurableObject(test.stub);
  player.send({ type: "media-ping", nonce: "too-late" });
  expect(await closed).toBe(4408);
  expect((await test.state()).mediaOutputs ?? []).toEqual([]);
  await test.command("add-event", test.play);
  await test.command("fire-event", { id: "play" });
  expect((await test.events())[0]).toMatchObject({
    fired: false,
    executionStatus: "failed",
  });
  expect(player.commands()).toHaveLength(0);
});

it("keeps Disable effective when an earlier Enable permission check finishes late", async () => {
  const test = await fixture();
  const player = await output(test, "Program", false);
  await runInDurableObject(test.stub, async (_instance, ctx) => {
    const socket = ctx.getWebSockets().find(isMediaOutputSocket);
    if (!socket) throw new Error("Missing media socket");
    let authorize: (allowed: boolean) => void = () => {};
    const authority = new Promise<boolean>((resolve) => {
      authorize = resolve;
    });
    const manager = new MediaOutputManager({
      ctx,
      bucket: env.STORAGE,
      authorize: () => authority,
      changed: () => {},
    });
    const enabling = manager.message(socket, {
      type: "media-arm",
      output: "Program",
      requestId: "slow-enable",
    });
    await manager.message(socket, { type: "media-disarm" });
    authorize(true);
    await enabling;
    expect(manager.snapshot()).toEqual([]);
  });
  expect(
    player.messages.some((message) => message.type === "media-armed"),
  ).toBe(false);
});

it("reports a missing enabled output or missing/changed asset as failure without dispatch", async () => {
  const test = await fixture();
  await test.command("add-event", test.play);
  await test.command("fire-event", { id: "play" });
  expect((await test.events())[0].executionError).toContain("Enable");
  const player = await output(test);
  await env.STORAGE.delete(test.key);
  await test.command("retry-event", { id: "play" });
  expect((await test.events())[0].executionError).toContain("missing");
  await env.STORAGE.put(test.key, "RIFF1234WAVEdifferent bytes", {
    httpMetadata: { contentType: "audio/wav" },
    customMetadata: { name: "Changed.wav" },
  });
  await test.command("retry-event", { id: "play" });
  expect((await test.events())[0].executionError).toContain("changed");
  expect(player.commands()).toHaveLength(0);
});

it("retries a confirmed playback failure with a new request, preserving its execution identity", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  const fire = test.command("fire-event", { id: "play" });
  const failed = await player.next();
  player.send({
    type: "media-result",
    executionId: failed.executionId,
    requestId: failed.requestId,
    result: { ok: false, error: "Codec unsupported on this computer" },
  });
  await fire;
  expect((await test.events())[0]).toMatchObject({
    fired: false,
    executionStatus: "failed",
    executionError: "Codec unsupported on this computer",
  });
  const retry = test.command("retry-event", { id: "play" });
  const retried = await player.next(1);
  expect(retried.executionId).toBe(failed.executionId);
  expect(retried.requestId).not.toBe(failed.requestId);
  player.acknowledge(failed);
  expect((await test.events())[0].fired).toBe(false);
  player.acknowledge(retried);
  await retry;
  expect((await test.events())[0].fired).toBe(true);
});

it("uses durable success receipts after relay eviction, and reviewed Re-fire creates one new attempt", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  const fire = test.command("fire-event", { id: "play" });
  const first = await player.next();
  player.acknowledge(first);
  await fire;
  await interrupt(test);
  await test.command("retry-event", { id: "play" });
  expect(player.commands()).toHaveLength(1);
  expect((await test.events())[0].executionId).toBe(first.executionId);
  await test.command("retry-event", { id: "play" }, 400);
  const refire = test.command("retry-event", {
    id: "play",
    confirmed: true,
    expected: cueReviewState((await test.events())[0]),
  });
  const second = await player.next(1);
  expect(second.executionId).not.toBe(first.executionId);
  player.acknowledge(second);
  await refire;
});

it("queries an uncertain receipt without replaying the media", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  const fire = test.command("fire-event", { id: "play" });
  const first = await player.next();
  player.acknowledge(first);
  await fire;
  await interrupt(test, "play", true);
  const retry = test.command("retry-event", { id: "play" });
  await expect
    .poll(() =>
      player.messages.some((message) => message.type === "media-query"),
    )
    .toBe(true);
  player.acknowledge(first);
  await retry;
  expect(player.commands()).toHaveLength(1);
  expect((await test.events())[0].fired).toBe(true);
});

it("requires reviewed re-arm when an uncertain attempt belongs to a previous output session", async () => {
  const test = await fixture();
  const first = await output(test);
  await test.command("add-event", test.play);
  const fire = test.command("fire-event", { id: "play" });
  await first.next();
  first.socket.close(1000, "Output closed");
  await fire;
  const second = await output(test);
  await test.command("retry-event", { id: "play" });
  expect((await test.events())[0].executionError).toContain(
    "another output session",
  );
  expect(second.commands()).toHaveLength(0);
  await test.command("rearm-event", {
    id: "play",
    confirmed: true,
    expected: cueReviewState((await test.events())[0]),
  });
  const rearmed = test.command("fire-event", { id: "play" });
  const command = await second.next();
  second.acknowledge(command);
  await rearmed;
  expect((await test.events())[0].fired).toBe(true);
});

it("does not let a second output or malformed result acknowledge another output's cue", async () => {
  const test = await fixture();
  const program = await output(test);
  const auxiliary = await output(test, "Aux");
  await test.command("add-event", test.play);
  const fire = test.command("fire-event", { id: "play" });
  const command = await program.next();
  auxiliary.acknowledge(command);
  program.acknowledge(command, { ok: true, state: "stopped" });
  expect((await test.events())[0].fired).toBe(false);
  program.acknowledge(command);
  await fire;
  expect((await test.events())[0].fired).toBe(true);
});

it("keeps independent outputs moving and honors disable, skip and the safety kill switch", async () => {
  const test = await fixture();
  const program = await output(test);
  const auxiliary = await output(test, "Aux");
  await test.command("add-event", test.play);
  await test.command("add-event", {
    ...test.play,
    id: "aux",
    payload: { ...test.play.payload, output: "Aux" },
  });
  await test.command("set-event-enabled", { id: "play", enabled: false });
  await test.command("fire-event", { id: "play" }, 400);
  expect(program.commands()).toHaveLength(0);
  await test.command("set-event-enabled", { id: "play", enabled: true });
  await test.command("set-triggers-enabled", { enabled: false });
  await test.command("fire-event", { id: "play" }, 400);
  expect(program.commands()).toHaveLength(0);
  await test.command("set-triggers-enabled", { enabled: true });
  await test.command("start");
  const feed = test.command("feed-tc", {
    timecode: zero,
    format: { frameRate: 30, dropFrame: "ndf" },
  });
  const one = await program.next();
  const two = await auxiliary.next();
  auxiliary.acknowledge(two);
  await expect
    .poll(
      async () =>
        (await test.events()).find((event) => event.id === "aux")?.fired,
    )
    .toBe(true);
  expect(
    (await test.events()).find((event) => event.id === "play")?.fired,
  ).toBe(false);
  program.acknowledge(one);
  await feed;
  await test.command("add-event", { ...test.stop, id: "skipped" });
  await test.command("skip-event", { id: "skipped" });
  await test.command("fire-event", { id: "skipped" }, 400);
  expect(program.commands()).toHaveLength(1);
});

it("closes revoked output authority, fails pending cues, and keeps media details out of display projection", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  const fire = test.command("fire-event", { id: "play" });
  const command = await player.next();
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(player.authority.sessionId)
    .run();
  player.acknowledge(command);
  await fire;
  expect((await test.events())[0].fired).toBe(false);
  const displayUrl = test.url("/state", "read");
  displayUrl.searchParams.delete("authUserId");
  displayUrl.searchParams.delete("authSessionId");
  const display = await (
    await test.stub.fetch(displayUrl)
  ).json<TimecodeDisplayState>();
  expect(display.automation.failedCueCount).toBe(1);
  expect(display).not.toHaveProperty("mediaOutputs");
  expect(JSON.stringify(display)).not.toContain(test.mediaId);
});

it("times out an unconfirmed cue and does not turn a late result into an automatically successful event", async () => {
  const test = await fixture();
  const player = await output(test);
  await test.command("add-event", test.play);
  const fire = test.command("fire-event", { id: "play" });
  const command = await player.next();
  await fire;
  expect((await test.events())[0]).toMatchObject({
    fired: false,
    executionStatus: "failed",
  });
  expect(
    player.messages.some((message) => message.type === "media-cancel"),
  ).toBe(true);
  player.acknowledge(command);
  await expect
    .poll(async () => (await test.state()).mediaOutputs?.[0].status)
    .toBe("playing");
  expect((await test.events())[0].fired).toBe(false);
  await test.command("retry-event", { id: "play" });
  expect((await test.events())[0].fired).toBe(true);
  expect(player.commands()).toHaveLength(1);
}, 15000);

it.each([
  { action: "media-play", payload: { output: "Program", mediaId: "bad" } },
  {
    action: "media-play",
    payload: {
      output: "Program",
      mediaId: "valid-media-id-1234",
      etag: "version",
      volume: 2,
    },
  },
  { action: "media-stop", payload: { output: "" } },
  {
    action: "media-stop",
    payload: { output: "Program", url: "https://example.com" },
  },
])(
  "rejects invalid media payloads at the relay boundary: $action",
  async (cue) => {
    const test = await fixture();
    await test.command("add-event", { ...test.play, ...cue }, 400);
    expect(await test.events()).toHaveLength(0);
  },
);
