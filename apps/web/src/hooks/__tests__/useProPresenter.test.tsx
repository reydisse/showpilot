import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProPresenter } from "../useProPresenter";
import type { ProPresenterFeedState } from "@/lib/propresenter-client";
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), event: null as ((target: string, event: string, data: string) => void) | null,
  online: null as ((online: boolean) => void) | null,
  device: null as ((target: string, connected: boolean) => void) | null,
}));
vi.mock("@/lib/rundown", () => ({ getProPresenterFeed: mocks.refresh }));
vi.mock("@/lib/device-modules/bridge-proxy", () => ({ getSharedProPresenterProxy: () => ({
  isBridgeOnline: () => true,
  onBridgeStatus: (listener: typeof mocks.online) => { mocks.online = listener; return () => { mocks.online = null; }; },
  onDeviceStatus: (listener: typeof mocks.device) => { mocks.device = listener; return () => { mocks.device = null; }; },
  onDeviceEvent: (listener: typeof mocks.event) => { mocks.event = listener; return () => { mocks.event = null; }; },
}) }));
const target = "propresenter:venue.local:50001";
function snapshot(text = "Opening"): ProPresenterFeedState {
  return { status: "connected", target, bridgeOnline: true, event: { kind: "slide", slide: {
    text, notes: "", presentationName: "Service", slideIndex: 0, isScripture: false, receivedAt: 1,
  } } };
}
const options = { orgId: "org-one", host: "venue.local", port: 50001, enabled: true };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mocks.refresh.mockResolvedValue(snapshot());
  vi.stubGlobal("WebSocket", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function mount() {
  const changed = vi.fn();
  const hook = renderHook(props => useProPresenter({ ...props, onSlideChange: changed }), { initialProps: options });
  await act(async () => {});
  return { ...hook, changed };
}

it("uses the authorized venue feed without opening a direct Stage Display socket or sending credentials", async () => {
  const { result } = await mount();
  expect(result.current.currentSlide?.text).toBe("Opening");
  expect(result.current.status).toBe("connected");
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-one" }, signal: expect.any(AbortSignal) });
  expect(WebSocket).not.toHaveBeenCalled();
});

it("keeps the last confirmed lyric through transport failure and applies only an explicit clear", async () => {
  const { result, changed } = await mount();
  act(() => mocks.online?.(false));
  expect(result.current.status).toBe("error");
  expect(result.current.currentSlide?.text).toBe("Opening");
  mocks.refresh.mockResolvedValue({ status: "error", target, bridgeOnline: false, event: null, error: "Offline" });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.currentSlide?.text).toBe("Opening");
  expect(changed).toHaveBeenCalledTimes(1);
  act(() => mocks.event?.(target, "slide", "null"));
  expect(result.current.currentSlide).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("never applies an older refresh after a newer event and keeps upcoming lyrics with the slide", async () => {
  let finish!: (state: ProPresenterFeedState) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, changed } = await mount();
  act(() => mocks.event?.(target, "slide", JSON.stringify({ text: "New lyric", nextText: "Upcoming", slideId: "new" })));
  await act(async () => { finish(snapshot("Old lyric")); });
  expect(result.current.currentSlide).toMatchObject({ text: "New lyric", nextText: "Upcoming", slideId: "new" });
  expect(changed).toHaveBeenCalledTimes(1);
});

it("ignores malformed/unrelated events and suppresses duplicate updates", async () => {
  const { result, changed } = await mount();
  act(() => {
    mocks.event?.("propresenter:another:50001", "slide", "null");
    mocks.event?.(target, "slide", "{}");
    mocks.event?.(target, "slide", JSON.stringify(snapshot().event?.kind === "slide" ? { text: "Opening", presentationName: "Service" } : {}));
  });
  expect(result.current.currentSlide?.text).toBe("Opening");
  expect(changed).toHaveBeenCalledTimes(1);
});

it("stops hidden polling, ignores the previous organization's pending response and detaches on unmount", async () => {
  const { result, rerender, unmount } = await mount();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let finish!: (state: ProPresenterFeedState) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  mocks.refresh.mockResolvedValue(snapshot("Other org"));
  rerender({ ...options, orgId: "org-two" });
  await act(async () => { finish(snapshot("Stale org")); });
  expect(result.current.currentSlide?.text).toBe("Other org");
  unmount();
  const count = mocks.refresh.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.refresh).toHaveBeenCalledTimes(count);
  expect(mocks.event).toBeNull();
});

it("bounds a stalled feed, preserves a timestamp through retry, and ignores the late response", async () => {
  const { result, changed } = await mount();
  let finish!: (state: ProPresenterFeedState) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const signal = mocks.refresh.mock.calls[1][0].signal;
  await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
  expect(signal.aborted).toBe(true);
  expect(result.current.status).toBe("error");
  expect(result.current.errorAt).toBe(Date.now());
  expect(result.current.currentSlide?.text).toBe("Opening");
  let recover!: (state: ProPresenterFeedState) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { recover = resolve; }));
  const failureAt = result.current.errorAt;
  act(() => result.current.connect());
  expect(result.current.errorAt).toBe(failureAt);
  expect(result.current.refreshing).toBe(true);
  await act(async () => { recover(snapshot()); finish(snapshot("Stale lyric")); });
  expect(result.current.status).toBe("connected");
  expect(result.current.error).toBeNull();
  expect(result.current.errorAt).toBeNull();
  expect(result.current.currentSlide?.text).toBe("Opening");
  expect(changed).toHaveBeenCalledTimes(1);
});

it("backs off rejected reads and resets the interval after confirmed recovery", async () => {
  mocks.refresh.mockRejectedValue(new Error("network unavailable"));
  const { result } = await mount();
  expect(result.current.errorAt).toBe(Date.now());
  await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  mocks.refresh.mockResolvedValue(snapshot());
  await act(async () => { await vi.advanceTimersByTimeAsync(7999); });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.status).toBe("connected");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(mocks.refresh).toHaveBeenCalledTimes(4);
});

it("does not let an offline response clear the slide even if it carries a clear event", async () => {
  const { result, changed } = await mount();
  mocks.refresh.mockResolvedValue({ ...snapshot(), status: "error", bridgeOnline: false, event: { kind: "clear" }, error: "Venue offline" });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.status).toBe("error");
  expect(result.current.errorAt).toBe(Date.now());
  expect(result.current.currentSlide?.text).toBe("Opening");
  expect(changed).toHaveBeenCalledTimes(1);
});

it("cancels a hidden request, retains push updates, and makes one new read on return", async () => {
  const { result } = await mount();
  let finish!: (state: ProPresenterFeedState) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const signal = mocks.refresh.mock.calls[1][0].signal;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(signal.aborted).toBe(true);
  expect(result.current.refreshing).toBe(false);
  act(() => mocks.event?.(target, "slide", JSON.stringify({ text: "Hidden live lyric" })));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); finish(snapshot("Stale")); });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(result.current.currentSlide?.text).toBe("Hidden live lyric");
  mocks.refresh.mockResolvedValue(snapshot("Confirmed on return"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  expect(result.current.currentSlide?.text).toBe("Confirmed on return");
});

it("cancels reads superseded by push events and ignores their later failures", async () => {
  const { result } = await mount();
  let reject!: (cause: Error) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const signal = mocks.refresh.mock.calls[1][0].signal;
  act(() => mocks.device?.(target, false));
  expect(signal.aborted).toBe(true);
  expect(result.current.errorAt).toBe(Date.now());
  act(() => mocks.event?.(target, "slide", JSON.stringify({ text: "Confirmed push" })));
  await act(async () => reject(new Error("Old read failure")));
  expect(result.current.status).toBe("connected");
  expect(result.current.error).toBeNull();
  expect(result.current.currentSlide?.text).toBe("Confirmed push");
});

it("clears the old target immediately, aborts its read and ignores its callbacks", async () => {
  const { result, rerender } = await mount();
  const oldEvent = mocks.event;
  let finish!: (state: ProPresenterFeedState) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const signal = mocks.refresh.mock.calls[1][0].signal;
  mocks.refresh.mockImplementationOnce(() => new Promise(() => {}));
  rerender({ ...options, host: "second-venue.local" });
  expect(signal.aborted).toBe(true);
  expect(result.current.currentSlide).toBeNull();
  act(() => oldEvent?.(target, "slide", JSON.stringify({ text: "Old target" })));
  await act(async () => finish(snapshot("Old HTTP")));
  expect(result.current.currentSlide).toBeNull();
});

it("disabling detaches the feed and re-enabling confirms the preview again without clearing output", async () => {
  const { result, changed, rerender } = await mount();
  rerender({ ...options, enabled: false });
  expect(result.current.status).toBe("disconnected");
  expect(result.current.error).toBeNull();
  expect(mocks.event).toBeNull();
  expect(changed).toHaveBeenCalledTimes(1);
  rerender(options);
  await act(async () => {});
  expect(result.current.status).toBe("connected");
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalledWith(null);
});
