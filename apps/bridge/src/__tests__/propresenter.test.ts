import { afterEach, describe, expect, it, vi } from "vitest";
import { ProPresenterBridge } from "../protocols/propresenter.js";
import { once } from "node:events";
import { WebSocketServer } from "ws";

function createBridge(onStatusChange: (connected: boolean) => void) {
  return new ProPresenterBridge({
    host: "127.0.0.1",
    port: 1025,
    apiPort: 1025,
    onSlideChange: () => {},
    onStatusChange,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProPresenter slide continuity", () => {
  it("holds the lyric through a long empty transition while the slide layer remains active", async () => {
    vi.useFakeTimers();
    let payload: unknown = { current: { text: "Lyric A", uuid: "a" } };
    let layerActive = true;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => Response.json(
      url.endsWith("/v1/status/layers") ? { slide: layerActive } : payload,
    )));
    const slides: (Record<string, unknown> | null)[] = [];
    const bridge = new ProPresenterBridge({ host: "127.0.0.1", port: 1025, apiPort: 1025, onSlideChange: (slide) => slides.push(slide), onStatusChange: () => {} });
    try {
      bridge.connect();
      await vi.advanceTimersByTimeAsync(0);
      payload = { current: null };
      await vi.advanceTimersByTimeAsync(4000);
      expect(slides.map((slide) => slide?.text ?? null)).toEqual(["Lyric A"]);
      payload = { current: { text: "Lyric B", uuid: "b" } };
      await vi.advanceTimersByTimeAsync(400);
      expect(slides.map((slide) => slide?.text ?? null)).toEqual(["Lyric A", "Lyric B"]);
      payload = { current: null };
      layerActive = false;
      await vi.advanceTimersByTimeAsync(1600);
      expect(slides.map((slide) => slide?.text ?? null)).toEqual(["Lyric A", "Lyric B", null]);
    } finally { bridge.disconnect(); }
  });

  it("does not turn unsupported or unavailable responses into a slide clear", async () => {
    vi.useFakeTimers();
    let payload: unknown = { current: { text: "Lyric A", uuid: "a" }, next: { text: "Lyric B", uuid: "b" } };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(payload)));
    const slides: (Record<string, unknown> | null)[] = [];
    const bridge = new ProPresenterBridge({ host: "127.0.0.1", port: 1025, apiPort: 1025, onSlideChange: (slide) => slides.push(slide), onStatusChange: () => {} });
    try {
      bridge.connect();
      await vi.advanceTimersByTimeAsync(0);
      payload = {}; // Reachable API, but no usable current-slide response.
      await vi.advanceTimersByTimeAsync(2400);
      expect(slides.map((slide) => slide?.text ?? null)).toEqual(["Lyric A"]);
      payload = { current: { text: "Lyric B", uuid: "b" }, next: { text: "Lyric C", uuid: "c" } };
      await vi.advanceTimersByTimeAsync(400);
      expect(slides.map((slide) => slide?.text ?? null)).toEqual(["Lyric A", "Lyric B"]);
    } finally { bridge.disconnect(); }
  });

  it("ignores an empty transition, but forwards a sustained clear or blank slide", async () => {
    vi.useFakeTimers();
    let payload: unknown = { current: { text: "Lyric A", uuid: "a" } };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(payload)));
    const slides: (Record<string, unknown> | null)[] = [];
    const bridge = new ProPresenterBridge({ host: "127.0.0.1", port: 1025, apiPort: 1025, onSlideChange: (slide) => slides.push(slide), onStatusChange: () => {} });
    try {
      bridge.connect();
      await vi.advanceTimersByTimeAsync(0);
      payload = { current: null };
      await vi.advanceTimersByTimeAsync(800);
      payload = { current: { text: "Lyric B", uuid: "b" } };
      await vi.advanceTimersByTimeAsync(400);
      expect(slides.map((slide) => slide?.text ?? null)).toEqual(["Lyric A", "Lyric B"]);
      payload = { current: { text: "", uuid: "blank" } };
      await vi.advanceTimersByTimeAsync(1600);
      expect(slides.map((slide) => slide?.text ?? null)).toEqual(["Lyric A", "Lyric B", null]);
    } finally { bridge.disconnect(); }
  });
});

describe("ProPresenter connection readiness", () => {
  it.each([true, false])("waits for Stage Display authentication, accepted=%s, even with a healthy REST API", async accepted => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
    const stage = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(stage, "listening");
    const address = stage.address();
    if (typeof address === "string") throw new Error("Missing Stage socket address");
    const connected = once(stage, "connection");
    const statuses: boolean[] = [];
    const slides: unknown[] = [];
    const bridge = new ProPresenterBridge({ host: "127.0.0.1", port: address.port, apiPort: 1025, password: "fixture-secret", onStatusChange: value => statuses.push(value), onSlideChange: value => slides.push(value) });
    try {
      bridge.connect();
      const readiness = bridge.waitUntilReady(1000).then(() => "ready", error => error.message);
      const [socket] = await connected;
      const [message] = await once(socket, "message");
      expect(JSON.parse(String(message))).toMatchObject({ acn: "ath", pwd: "fixture-secret" });
      socket.send(JSON.stringify({ acn: "sd", text: "Unauthenticated slide" }));
      const pong = once(socket, "pong"); socket.ping(); await pong;
      expect(statuses).not.toContain(true);
      expect(slides).toEqual([]);
      expect(bridge.getDebugState().connected).toBe(false);
      socket.send(JSON.stringify({ acn: "ath", ath: accepted }));
      expect(await readiness).toBe(accepted ? "ready" : "ProPresenter Stage Display authentication failed");
      expect(bridge.getDebugState().connected).toBe(accepted);
      expect(statuses.includes(true)).toBe(accepted);
    } finally {
      bridge.disconnect();
      for (const socket of stage.clients) socket.terminate();
      await new Promise<void>(resolve => stage.close(() => resolve()));
    }
  });

  it("reports connected only after the local API responds", async () => {
    let answerRequest: ((response: Response) => void) | undefined;
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        requestCount += 1;
        if (requestCount > 1) return Promise.resolve(Response.json({}));
        return new Promise<Response>((resolve) => {
          answerRequest = resolve;
        });
      }),
    );
    const statuses: boolean[] = [];
    const bridge = createBridge((connected) => statuses.push(connected));

    bridge.connect();
    expect(statuses).toEqual([]);

    answerRequest?.(Response.json({}));
    await bridge.waitUntilReady(100);
    expect(statuses).toEqual([true]);
    expect(bridge.getDebugState().connected).toBe(true);

    bridge.disconnect();
  });

  it("does not claim an unreachable API is connected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    const statuses: boolean[] = [];
    const bridge = createBridge((connected) => statuses.push(connected));

    bridge.connect();
    await expect(bridge.waitUntilReady(25)).rejects.toThrow(
      "connection timeout",
    );
    expect(statuses).not.toContain(true);
    expect(bridge.getDebugState().connected).toBe(false);

    bridge.disconnect();
  });
});

describe("ProPresenter commands", () => {
  it("does not acknowledge REST output by writing an unacknowledged Stage Display message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(null, { status: 404 })));
    const stage = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(stage, "listening");
    const address = stage.address();
    if (typeof address === "string") throw new Error("Missing Stage socket address");
    const connected = once(stage, "connection");
    const bridge = new ProPresenterBridge({ host: "127.0.0.1", port: address.port, apiPort: 1025, password: "fixture", onStatusChange: () => {}, onSlideChange: () => {} });
    try {
      bridge.connect();
      const [socket] = await connected;
      await once(socket, "message");
      const received: string[] = [];
      socket.on("message", data => received.push(String(data)));
      socket.send(JSON.stringify({ acn: "ath", ath: true }));
      await bridge.waitUntilReady(1000);
      for (const command of ["next", "previous", "clear-props"]) {
        await expect(bridge.sendCommand(command)).rejects.toThrow("No ProPresenter command endpoint worked");
      }
      const pong = once(socket, "pong"); socket.ping(); await pong;
      expect(received).toEqual([]);
    } finally {
      bridge.disconnect();
      for (const socket of stage.clients) socket.terminate();
      await new Promise<void>(resolve => stage.close(() => resolve()));
    }
  });

  it.each([
    ["next", "/v1/presentation/active/next/trigger"],
    ["previous", "/v1/presentation/active/previous/trigger"],
    ["clear", "/v1/clear/layer/slide"],
  ])("sends %s to the documented active-presentation endpoint", async (command, path) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = createBridge(() => {});

    await bridge.sendCommand(command);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:1025${path}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    bridge.disconnect();
  });

  it("lists every presentation without fetching slide payloads", async () => {
    const presentations = Array.from({ length: 750 }, (_, index) => ({
      uuid: `song-${index}`,
      name: `Song ${String(index).padStart(3, "0")}`,
      index,
    }));
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/libraries")) return Promise.resolve(Response.json([{ id: { uuid: "library-1", name: "Songs", index: 0 } }]));
      if (url.endsWith("/v1/library/library-1")) return Promise.resolve(Response.json({ update_type: "all", items: presentations }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = createBridge(() => {});

    const response = await bridge.sendCommand(JSON.stringify({ action: "query-presentations" }));

    expect(JSON.parse(response as string)).toEqual({
      presentations: expect.arrayContaining([
        expect.objectContaining({ uuid: "song-0" }),
        expect.objectContaining({ uuid: "song-749" }),
      ]),
      libraries: { total: 1, read: 1, failed: [] },
    });
    expect(JSON.parse(response as string).presentations).toHaveLength(750);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    bridge.disconnect();
  });

  it("imports the nested ProPresenter 21 response as ordered slides", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/presentation/song-1")) return Promise.resolve(Response.json({
        presentation: {
          id: { uuid: "song-1", name: "Amazing Grace", index: 0 },
          groups: [
            { name: "Verse 1", slides: [{ id: { uuid: "slide-1" }, enabled: true, text: "Amazing grace", notes: "Lead", label: "" }] },
            { name: "Chorus", slides: [{ enabled: true, text: "My chains are gone", notes: "", label: "Big" }] },
          ],
        },
        arrangements: [],
        current_arrangement: "",
      }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = createBridge(() => {});

    const response = await bridge.sendCommand(JSON.stringify({ action: "query-presentation", presentationUuid: "song-1" }));

    expect(JSON.parse(response as string)).toEqual({
      uuid: "song-1",
      name: "Amazing Grace",
      slides: [
        { index: 0, sourceId: "slide-1", text: "Amazing grace", label: "Verse 1", notes: "Lead" },
        { index: 1, sourceId: "", text: "My chains are gone", label: "Big", notes: "" },
      ],
    });
    bridge.disconnect();
  });

  it("reports partial library failures and can retry only failed libraries", async () => {
    let failedOnce = true;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/libraries")) return Promise.resolve(Response.json([
        { id: { uuid: "library-a", name: "Songs A" } },
        { id: { uuid: "library-b", name: "Songs B" } },
      ]));
      if (url.endsWith("/v1/library/library-a")) return Promise.resolve(Response.json({ items: [{ uuid: "song-a", name: "Song A" }] }));
      if (url.endsWith("/v1/library/library-b") && failedOnce) {
        failedOnce = false;
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      if (url.endsWith("/v1/library/library-b")) return Promise.resolve(Response.json({ items: [{ uuid: "song-b", name: "Song B" }] }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = createBridge(() => {});

    const initial = JSON.parse(await bridge.sendCommand(JSON.stringify({ action: "query-presentations" })) as string);
    expect(initial).toMatchObject({
      presentations: [{ uuid: "song-a", name: "Song A" }],
      libraries: { total: 2, read: 1, failed: [{ id: "library-b", name: "Songs B" }] },
    });

    const retry = JSON.parse(await bridge.sendCommand(JSON.stringify({
      action: "query-presentations",
      libraryIds: ["library-b"],
    })) as string);
    expect(retry).toEqual({
      presentations: [{ uuid: "song-b", name: "Song B" }],
      libraries: { total: 1, read: 1, failed: [] },
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/library/library-a"))).toHaveLength(1);
    bridge.disconnect();
  });

  it("triggers a mapped slide through the documented presentation endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = createBridge(() => {});

    await bridge.sendCommand(JSON.stringify({ action: "trigger-slide", presentationUuid: "song-1", slideIndex: 4 }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:1025/v1/presentation/song-1/4/trigger");
    bridge.disconnect();
  });
});
