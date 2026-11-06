import { afterEach, expect, it, vi } from "vitest";
import { MediaPlaybackSession } from "../media-playback";
import { MEDIA_OUTPUT_LEASE_MS, mediaOutputClientMessageSchema } from "../media-output";

class OutputSocket {
  static OPEN = 1;
  static instances: OutputSocket[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    OutputSocket.instances.push(this);
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  OutputSocket.instances = [];
});

function deferred() {
  let resolve: () => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

it("stops on a silent connection's expired heartbeat and requires Enable after reconnect", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  vi.stubGlobal("WebSocket", OutputSocket);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:probe"; }
    static revokeObjectURL() {}
  });
  const video = document.createElement("video");
  vi.spyOn(video, "play").mockResolvedValue();
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const load = vi.spyOn(video, "load").mockImplementation(() => {});
  const status = vi.fn();
  const session = new MediaPlaybackSession({ video, orgId: "org", showId: "show", output: "Program", status, preparation: () => {} });
  try {
    session.connect(); const socket = OutputSocket.instances[0];
    await session.enable();
    const arm = socket.send.mock.calls.map(([value]) => mediaOutputClientMessageSchema.parse(JSON.parse(value))).find(message => message.type === "media-arm");
    if (!arm || arm.type !== "media-arm") throw new Error("Missing arm request");
    socket.onmessage?.({ data: JSON.stringify({ type: "media-armed", requestId: arm.requestId, leaseId: "lease", output: "Program", serverTime: Date.now() }) });
    expect(status.mock.calls.at(-1)?.[0].kind).toBe("enabled");
    pause.mockClear(); load.mockClear();
    vi.advanceTimersByTime(MEDIA_OUTPUT_LEASE_MS + 201);
    expect(socket.close).toHaveBeenCalledOnce(); expect(pause).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledOnce();
    expect(status.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "disconnected", message: expect.stringContaining("heartbeat expired") });
    session.connect(); const next = OutputSocket.instances[1];
    next.onmessage?.({ data: JSON.stringify({ type: "media-hello", orgId: "org", showId: "show", serverTime: Date.now() }) });
    expect(status.mock.calls.at(-1)?.[0].kind).toBe("disabled");
    expect(next.send).not.toHaveBeenCalled();
  } finally { session.dispose(); }
});

it.each(["resolve", "reject"])(
  "ignores a cancelled sound probe that later %ss after another Enable",
  async (outcome) => {
    vi.stubGlobal("WebSocket", OutputSocket);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL() {
          return `blob:fixture-${crypto.randomUUID()}`;
        }
        static revokeObjectURL() {}
      },
    );
    const video = document.createElement("video");
    const first = deferred();
    const second = deferred();
    vi.spyOn(video, "play")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    vi.spyOn(video, "load").mockImplementation(() => {});
    const status = vi.fn();
    const session = new MediaPlaybackSession({
      video,
      orgId: "org",
      showId: "show",
      output: "Program",
      status,
      preparation: () => {},
    });
    try {
      session.connect();
      const socket = OutputSocket.instances[0];
      const enablingFirst = session.enable();
      session.disable();
      const enablingSecond = session.enable();
      const secondSource = video.src;
      const pauses = pause.mock.calls.length;
      if (outcome === "resolve") first.resolve();
      else
        first.reject(new DOMException("Interrupted by disable", "AbortError"));
      await enablingFirst;
      expect(video.src).toBe(secondSource);
      expect(pause).toHaveBeenCalledTimes(pauses);
      expect(status.mock.calls.at(-1)?.[0].kind).toBe("enabling");
      second.resolve();
      await enablingSecond;
      const messages = socket.send.mock.calls.map(([value]) =>
        JSON.parse(value),
      );
      expect(
        messages.filter((message) => message.type === "media-arm"),
      ).toHaveLength(1);
      expect(
        messages.filter((message) => message.type === "media-disarm"),
      ).toHaveLength(1);
    } finally {
      session.dispose();
    }
  },
);
