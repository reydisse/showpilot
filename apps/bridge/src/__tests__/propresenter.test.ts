import { afterEach, describe, expect, it, vi } from "vitest";
import { ProPresenterBridge } from "../protocols/propresenter.js";

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
});

describe("ProPresenter connection readiness", () => {
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

    expect(JSON.parse(response as string)).toHaveLength(750);
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
            { name: "Verse 1", slides: [{ enabled: true, text: "Amazing grace", notes: "Lead", label: "" }] },
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
        { index: 0, text: "Amazing grace", label: "Verse 1", notes: "Lead" },
        { index: 1, text: "My chains are gone", label: "Big", notes: "" },
      ],
    });
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
