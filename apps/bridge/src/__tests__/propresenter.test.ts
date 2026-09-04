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
});
