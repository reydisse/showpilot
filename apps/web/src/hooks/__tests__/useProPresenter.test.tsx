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
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-one" } });
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
