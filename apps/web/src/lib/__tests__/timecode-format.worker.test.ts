import { env } from "cloudflare:workers";
import type { TimecodeState } from "@/types/timecode";
import { timecodeFixture, startFixtureTimecodeFeed } from "@/test/timecode-fixtures";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const fmt30 = { frameRate: 30, dropFrame: "ndf" } as const;
const fmt25 = { frameRate: 25, dropFrame: "ndf" } as const;
const tick = { timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 } };

afterEach(async () => {
  await abortAllDurableObjects();
});

async function command(fixture: Awaited<ReturnType<typeof timecodeFixture>>, action: string, payload?: Record<string, unknown>, status = 200) {
  if (action === "feed-tc") await startFixtureTimecodeFeed(fixture.stub, fixture.url);
  const response = await fixture.stub.fetch(new Request(fixture.url("/command"), {
    method: "POST",
    body: JSON.stringify({ action, payload }),
  }));
  expect(response.status).toBe(status);
  return response.json();
}

describe("TimecodeRelay incoming format changes", () => {
  it("ignores transient and alternating formats, restarting the count after a correct-format feed or gap", async () => {
    const test = await timecodeFixture();
    const state = async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>();
    await command(test, "feed-tc", { ...tick, format: fmt30 });
    for (let i = 0; i < 4; i++) await command(test, "feed-tc", { ...tick, format: fmt25 });
    expect(await state()).toMatchObject({ format: fmt30, totalFrames: 30, triggersEnabled: true });
    expect((await state()).incomingFormat).toBeFalsy();
    await command(test, "feed-tc", { ...tick, format: fmt30 });
    for (let i = 0; i < 8; i++) await command(test, "feed-tc", { ...tick, format: { frameRate: i % 2 ? 24 : 25, dropFrame: "ndf" } });
    expect((await state()).incomingFormat).toBeFalsy();
    for (let i = 0; i < 4; i++) await command(test, "feed-tc", { ...tick, format: fmt25 });
    await new Promise(resolve => setTimeout(resolve, 550));
    await command(test, "feed-tc", { ...tick, format: fmt25 });
    expect((await state()).incomingFormat).toBeFalsy();
    for (let i = 0; i < 4; i++) await command(test, "feed-tc", { ...tick, format: fmt25 });
    expect(await state()).toMatchObject({ format: fmt30, triggersEnabled: false, running: false, incomingFormat: { format: fmt25 } });
    await command(test, "set-triggers-enabled", { enabled: true }, 400);
  });

  it("persists consecutive observations through eviction and rejects a stale input-format confirmation", async () => {
    const test = await timecodeFixture();
    const state = async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>();
    for (let i = 0; i < 3; i++) await command(test, "feed-tc", { ...tick, format: fmt25 });
    await evictDurableObject(test.stub);
    for (let i = 0; i < 2; i++) await command(test, "feed-tc", { ...tick, format: fmt25 });
    const proposal = (await state()).incomingFormat;
    expect(proposal).toMatchObject({ format: fmt25 });
    await command(test, "feed-tc", { ...tick, format: { frameRate: 24, dropFrame: "ndf" } });
    expect((await state()).incomingFormat).toBeNull();
    await command(test, "set-format", { format: fmt25, expectedFormat: fmt30, expectedIncomingFormatId: proposal?.id, confirmed: true }, 400);
    await command(test, "feed-tc", { ...tick, format: fmt30 });
    expect(await state()).toMatchObject({ format: fmt30, running: true, incomingFormat: null, triggersEnabled: false });
  });

  it("does not combine Bridge and browser observations into one stable-format claim", async () => {
    const test = await timecodeFixture();
    for (let i = 0; i < 3; i++) {
      const response = await test.stub.fetch(test.url("/internal/bridge-feed"), { method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ payload: { ...tick, format: fmt25 } }) });
      expect(response.status).toBe(200); await response.arrayBuffer();
    }
    await command(test, "start");
    for (let i = 0; i < 2; i++) await command(test, "feed-tc", { ...tick, format: fmt25 });
    const state = async () => (await test.stub.fetch(test.url("/state"))).json<TimecodeState>();
    expect((await state()).incomingFormat).toBeFalsy();
    for (let i = 0; i < 3; i++) await command(test, "feed-tc", { ...tick, format: fmt25 });
    expect((await state()).incomingFormat).toMatchObject({ format: fmt25 });
    const display = test.url("/state", "read");
    display.searchParams.delete("authSessionId");
    expect(await (await test.stub.fetch(display)).json()).not.toHaveProperty("incomingFormat");
  });

  it("requires confirmation and a stopped clock, rejects invalid cue labels, and keeps the held clock valid", async () => {
    const test = await timecodeFixture();
    await command(test, "set-format", { format: fmt25 }, 400);
    await command(test, "start");
    await command(test, "set-format", { format: fmt25, expectedFormat: fmt30, confirmed: true }, 400);
    await command(test, "stop");
    await command(test, "add-event", { id: "invalid", label: "Frame 29", action: "lyrics-clear", triggerTimecode: { ...tick.timecode, frames: 29 }, payload: {} });
    const rejected = await command(test, "set-format", { format: fmt25, expectedFormat: fmt30, confirmed: true }, 400);
    expect(rejected).toMatchObject({ error: expect.stringContaining("Frame 29") });
    expect(await (await test.stub.fetch(test.url("/state"))).json()).toMatchObject({ format: fmt30 });
    await command(test, "remove-event", { id: "invalid" });
    await command(test, "set-timecode", { timecode: { ...tick.timecode, frames: 29 } });
    await command(test, "set-format", { format: fmt25, expectedFormat: fmt30, confirmed: true });
    expect(await (await test.stub.fetch(test.url("/state"))).json()).toMatchObject({ format: fmt25, totalFrames: 49, timecode: { frames: 24 }, triggersEnabled: false });
    await command(test, "set-format", { format: fmt30, expectedFormat: fmt30, confirmed: true }, 400);
  });

  it("rejects nonexistent drop-frame cue labels instead of silently moving or rearming them", async () => {
    const test = await timecodeFixture();
    await command(test, "add-event", { id: "df-invalid", label: "Minute boundary", action: "lyrics-clear", triggerTimecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 }, payload: {} });
    await command(test, "set-format", { format: { frameRate: 29.97, dropFrame: "df" }, expectedFormat: fmt30, confirmed: true }, 400);
    expect(await (await test.stub.fetch(test.url("/events"))).json()).toEqual([expect.objectContaining({ triggerFrame: 1800, fired: false })]);
  });

  it("requires stable input and explicit reformat, preserving fired lyrics cues and ignoring stale client totals", async () => {
    const fixture = await timecodeFixture();
    const { stub, url } = fixture;
    await command(fixture, "add-event", {
      triggerTimecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 },
      triggerFrame: 1_800,
      action: "lyrics-goto",
      payload: {
        songId: "song-1",
        songTitle: "Format Test",
        sectionId: "section-1",
        sectionLabel: "Verse",
        lyrics: "At one minute",
      },
      label: "One minute",
      toleranceFrames: 2,
    });

    const tick = { timecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 }, totalFrames: 1800 };
    await command(fixture, "feed-tc", { ...tick, format: fmt30 });
    for (let i = 0; i < 5; i++) await command(fixture, "feed-tc", { ...tick, format: fmt25 });
    await evictDurableObject(stub);
    const held = await (await stub.fetch(url("/state"))).json<TimecodeState>();
    expect(held).toMatchObject({ format: fmt30, running: false, triggersEnabled: false, signal: { status: "format-mismatch" } });
    expect(await (await stub.fetch(url("/events"))).json()).toEqual([expect.objectContaining({ triggerFrame: 1800, fired: true })]);
    await command(fixture, "set-format", { format: fmt25, expectedFormat: fmt30, expectedIncomingFormatId: held.incomingFormat?.id, confirmed: true });
    await command(fixture, "feed-tc", { ...tick, format: fmt25 });

    const events = await (await stub.fetch(new Request(url("/events")))).json<Array<{ triggerFrame: number; fired: boolean }>>();
    expect(events).toEqual([expect.objectContaining({ triggerFrame: 1_500, fired: true })]);
    const state = await (await stub.fetch(new Request(url("/state")))).json<{ totalFrames: number; format: unknown; lyrics: unknown }>();
    expect(state).toMatchObject({
      totalFrames: 1_500,
      format: { frameRate: 25, dropFrame: "ndf" },
      lyrics: { lyrics: "At one minute" },
    });
  });

  it("does not let a delayed clear from one song erase the next song", async () => {
    const fixture = await timecodeFixture();
    const { stub, url } = fixture;
    const lyric = (id: string, frame: number, sourceKey: string, lyrics: string) => ({
      triggerTimecode: { hours: 0, minutes: 0, seconds: 0, frames: frame },
      action: "lyrics-goto",
      payload: { songId: id, songTitle: id, sectionId: `${id}-section`, sectionLabel: "Verse", lyrics },
      label: id,
      toleranceFrames: 1,
      sourceKey,
    });
    await command(fixture, "add-event", lyric("song-a", 10, "generation-a", "Song A"));
    await command(fixture, "add-event", lyric("song-b", 20, "generation-b", "Song B"));
    await command(fixture, "add-event", {
      triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      action: "lyrics-clear",
      payload: { generationKey: "generation-a" },
      label: "Clear A",
      toleranceFrames: 1,
      sourceKey: "generation-a",
    });

    for (const frames of [10, 20, 30]) {
      await command(fixture, "feed-tc", {
        timecode: { hours: 0, minutes: 0, seconds: frames === 30 ? 1 : 0, frames: frames % 30 },
        format: { frameRate: 30, dropFrame: "ndf" },
      });
    }

    const state = await (await stub.fetch(new Request(url("/state")))).json<{ lyrics: { lyrics: string } | null }>();
    expect(state.lyrics?.lyrics).toBe("Song B");
  });
});
