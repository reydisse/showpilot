import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await abortAllDurableObjects();
});

async function command(stub: DurableObjectStub, action: string, payload?: Record<string, unknown>) {
  const response = await stub.fetch(new Request("https://timecode.test/command?orgId=format-test&access=write", {
    method: "POST",
    body: JSON.stringify({ action, payload }),
  }));
  expect(response.status).toBe(200);
}

describe("TimecodeRelay incoming format changes", () => {
  it("atomically reframes existing events and ignores a stale client total", async () => {
    const stub = env.TIMECODE_RELAY.getByName("timecode-format-change");
    await command(stub, "add-event", {
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

    await command(stub, "feed-tc", {
      timecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 },
      totalFrames: 1_800,
      format: { frameRate: 25, dropFrame: "ndf" },
    });

    const events = await (await stub.fetch(new Request("https://timecode.test/events?orgId=format-test&access=write"))).json<Array<{ triggerFrame: number; fired: boolean }>>();
    expect(events).toEqual([expect.objectContaining({ triggerFrame: 1_500, fired: true })]);
    const state = await (await stub.fetch(new Request("https://timecode.test/state?orgId=format-test&access=write"))).json<{ totalFrames: number; format: unknown; lyrics: unknown }>();
    expect(state).toMatchObject({
      totalFrames: 1_500,
      format: { frameRate: 25, dropFrame: "ndf" },
      lyrics: { lyrics: "At one minute" },
    });
  });

  it("does not let a delayed clear from one song erase the next song", async () => {
    const stub = env.TIMECODE_RELAY.getByName("timecode-scoped-lyric-clear");
    const lyric = (id: string, frame: number, sourceKey: string, lyrics: string) => ({
      triggerTimecode: { hours: 0, minutes: 0, seconds: 0, frames: frame },
      action: "lyrics-goto",
      payload: { songId: id, songTitle: id, sectionId: `${id}-section`, sectionLabel: "Verse", lyrics },
      label: id,
      toleranceFrames: 1,
      sourceKey,
    });
    await command(stub, "add-event", lyric("song-a", 10, "generation-a", "Song A"));
    await command(stub, "add-event", lyric("song-b", 20, "generation-b", "Song B"));
    await command(stub, "add-event", {
      triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      action: "lyrics-clear",
      payload: { generationKey: "generation-a" },
      label: "Clear A",
      toleranceFrames: 1,
      sourceKey: "generation-a",
    });

    for (const frames of [10, 20, 30]) {
      await command(stub, "feed-tc", {
        timecode: { hours: 0, minutes: 0, seconds: frames === 30 ? 1 : 0, frames: frames % 30 },
        format: { frameRate: 30, dropFrame: "ndf" },
      });
    }

    const state = await (await stub.fetch(new Request("https://timecode.test/state?orgId=format-test&access=write"))).json<{ lyrics: { lyrics: string } | null }>();
    expect(state.lyrics?.lyrics).toBe("Song B");
  });
});
