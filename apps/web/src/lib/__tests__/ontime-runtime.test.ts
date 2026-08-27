import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOntimeRuntimeState } from "../ontime-runtime";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OnTime runtime boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes flat OnTime events and timer defaults", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/api/poll")
      ? jsonResponse({ payload: { timer: { playback: "play", current: 75_000 }, eventNow: { id: "event-1", type: "event", title: "Welcome" }, clock: 1_000 } })
      : jsonResponse([
        { id: "event-1", type: "event", title: "Welcome", duration: 300_000 },
        { id: "event-skip", type: "event", title: "Hidden", skip: true },
        { id: "group-1", type: "group", title: "Not an event" },
      ])));

    const state = await fetchOntimeRuntimeState("https://ontime.example.test/");

    expect(state.connected).toBe(true);
    expect(state.timer).toMatchObject({ playback: "play", current: 75_000, elapsed: null });
    expect(state.eventNow).toMatchObject({ id: "event-1", title: "Welcome", cue: "", skip: false });
    expect(state.events.map((event) => event.id)).toEqual(["event-1"]);
  });

  it("supports OnTime's ordered entry response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/api/poll")
      ? jsonResponse({ payload: { timer: { playback: "stop" } } })
      : jsonResponse({
        order: ["event-2", "event-1"],
        entries: {
          "event-1": { id: "event-1", type: "event", title: "First" },
          "event-2": { id: "event-2", type: "event", title: "Second" },
        },
      })));

    const state = await fetchOntimeRuntimeState("https://ontime.example.test");

    expect(state.events.map((event) => event.title)).toEqual(["Second", "First"]);
  });

  it("returns a disconnected state when the poll response is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ unexpected: true })));

    await expect(fetchOntimeRuntimeState("https://ontime.example.test")).resolves.toMatchObject({
      connected: false,
      eventNow: null,
      events: [],
    });
  });
});
