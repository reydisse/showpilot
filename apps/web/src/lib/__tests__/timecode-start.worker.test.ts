import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { timecodeFixture } from "@/test/timecode-fixtures";
import { framesToTimecode, timecodeToFrames } from "@/lib/timecode";
import type {
  AutomationEvent,
  TimecodeFormat,
  TimecodeState,
} from "@/types/timecode";
import type { TimecodeStartPosition } from "@/lib/timecode-start";

afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
});
const format = { frameRate: 30, dropFrame: "ndf" } as const;
async function fixture() {
  const test = await timecodeFixture();
  const command = async (action: string, payload?: unknown, status = 200) => {
    const response = await test.stub.fetch(test.url("/command"), {
      method: "POST",
      body: JSON.stringify({ action, payload }),
    });
    expect(response.status).toBe(status);
    return response.json();
  };
  const state = () =>
    test.stub
      .fetch(test.url("/state"))
      .then((response) => response.json<TimecodeState>());
  const position: TimecodeStartPosition = {
    timecode: framesToTimecode(300, format),
    expectedShowId: test.target.showId,
    expectedFrame: 0,
    expectedFormat: format,
    confirmed: true,
  };
  return { ...test, command, state, position };
}

it.each<TimecodeFormat>([
  { frameRate: 24, dropFrame: "ndf" },
  { frameRate: 25, dropFrame: "ndf" },
  { frameRate: 29.97, dropFrame: "df" },
  { frameRate: 29.97, dropFrame: "ndf" },
  format,
])(
  "starts at an exact reviewed position in $frameRate $dropFrame and preserves resume",
  async (fmt) => {
    const test = await fixture();
    await test.command("set-format", {
      format: fmt,
      expectedFormat: format,
      confirmed: true,
    });
    const tc = { hours: 0, minutes: 1, seconds: 0, frames: 2 };
    await test.command("start", {
      startPosition: { ...test.position, timecode: tc, expectedFormat: fmt },
    });
    const started = await test.state();
    const frame = timecodeToFrames(tc, fmt);
    expect(started).toMatchObject({
      running: true,
      source: "internal-freerun",
      timecode: tc,
      totalFrames: frame,
      signal: { status: "waiting" },
      triggersEnabled: false,
      automationHold: { reason: "timecode-jump" },
    });
    await test.command("feed-tc", { timecode: tc, format: fmt });
    expect((await test.state()).totalFrames).toBe(frame);
    await test.command("stop");
    await test.command("start");
    expect(await test.state()).toMatchObject({
      totalFrames: frame,
      timecode: tc,
      running: true,
    });
  },
);

it.each([
  { confirmed: false },
  { confirmed: undefined },
  { expectedFrame: 1 },
  { expectedShowId: "another-show" },
  { expectedFormat: { frameRate: 25, dropFrame: "ndf" } },
  { timecode: { hours: 24, minutes: 0, seconds: 0, frames: 0 } },
  { timecode: { hours: 0, minutes: 0, seconds: 0, frames: -1 } },
  { timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0.5 } },
])(
  "rejects an invalid or stale start review without changing the clock: %j",
  async (updates) => {
    const test = await fixture();
    const before = await test.state();
    await test.command(
      "start",
      { startPosition: { ...test.position, ...updates } },
      400,
    );
    expect(await test.state()).toEqual(before);
  },
);

it("rejects dropped frame labels and a chosen position while running or paused", async () => {
  const test = await fixture();
  const fmt = { frameRate: 29.97, dropFrame: "df" } as const;
  await test.command("set-format", {
    format: fmt,
    expectedFormat: format,
    confirmed: true,
  });
  await test.command(
    "start",
    {
      startPosition: {
        ...test.position,
        expectedFormat: fmt,
        timecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 },
      },
    },
    400,
  );
  expect((await test.state()).running).toBe(false);
  await test.command("start");
  await test.command(
    "start",
    { startPosition: { ...test.position, expectedFormat: fmt } },
    400,
  );
  await test.command("pause");
  await test.command(
    "start",
    { startPosition: { ...test.position, expectedFormat: fmt } },
    400,
  );
  expect(await test.state()).toMatchObject({
    running: false,
    totalFrames: 0,
    signal: { status: "paused" },
  });
});

it("does not re-arm fired cues or catch up missed cues when starting from a new position", async () => {
  const test = await fixture();
  for (const [id, frame] of [
    ["fired", 0],
    ["missed", 150],
  ] as const) {
    await test.command("add-event", {
      id,
      action: "lyrics-clear",
      label: id,
      payload: {},
      triggerTimecode: framesToTimecode(frame, format),
      toleranceFrames: 0,
    });
  }
  await test.command("start");
  await test.command("feed-tc", {
    timecode: framesToTimecode(0, format),
    format,
  });
  await test.command("stop");
  await test.command("start", { startPosition: test.position });
  await test.command("feed-tc", { timecode: test.position.timecode, format });
  const events = await (
    await test.stub.fetch(test.url("/events"))
  ).json<AutomationEvent[]>();
  expect(events[0]).toMatchObject({ fired: true, executionAttempts: 1 });
  expect(events[1]).toMatchObject({ fired: false, executionAttempts: 0 });
  expect((await test.state()).triggersEnabled).toBe(false);
});

it.each(["stop", "set-timecode", "set-format"])(
  "lets %s cancel a chosen start while device timing is loading",
  async (action) => {
    const test = await fixture();
    await runInDurableObject(test.stub, async (instance, ctx) => {
      let release = () => {};
      let entered = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const put = ctx.storage.put.bind(ctx.storage);
      const spy = vi
        .spyOn(ctx.storage, "put")
        .mockImplementationOnce(async (entries, options) => {
          entered();
          await pending;
          await put(entries, options);
        });
      const request = (name: string, payload?: unknown) =>
        new Request(test.url("/command"), {
          method: "POST",
          body: JSON.stringify({ action: name, payload }),
        });
      const starting = instance.fetch(
        request("start", { startPosition: test.position }),
      );
      try {
        await preparing;
        const payload =
          action === "set-timecode"
            ? { timecode: framesToTimecode(30, format) }
            : action === "set-format"
              ? {
                  format: { frameRate: 25, dropFrame: "ndf" },
                  expectedFormat: format,
                  confirmed: true,
                }
              : undefined;
        expect((await instance.fetch(request(action, payload))).status).toBe(
          200,
        );
      } finally {
        release();
      }
      expect((await starting).status).toBe(400);
      spy.mockRestore();
      const state = await (
        await instance.fetch(new Request(test.url("/state")))
      ).json<TimecodeState>();
      expect(state).toMatchObject({
        running: false,
        totalFrames: action === "set-timecode" ? 30 : 0,
      });
      expect(state.format.frameRate).toBe(action === "set-format" ? 25 : 30);
    });
  },
);
