import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesktopLocalShow } from "../useDesktopLocalShow";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: () => true }));
vi.mock("@/lib/desktop-local-show", () => ({
  readDesktopLocalShow: mocks.read,
}));
const empty = {
  mode: "empty",
  installationId: "fixture",
  commandSource: "cloud",
};
beforeEach(() => {
  vi.useFakeTimers();
  mocks.read.mockReset().mockResolvedValue(empty);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("does not overlap a slow read when manually refreshed", async () => {
  let release: (value: unknown) => void = () => {};
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result } = renderHook(() => useDesktopLocalShow());
  expect(mocks.read).toHaveBeenCalledTimes(1);
  act(() => result.current.refresh());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  await act(async () => {
    release({ ...empty, mode: "obsolete" });
  });
  expect(result.current.status).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.status).toEqual(empty);
});
it("does not publish a stale read after a mutation starts", async () => {
  let release: (value: unknown) => void = () => {};
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ paused }) => useDesktopLocalShow(paused),
    { initialProps: { paused: false } },
  );
  rerender({ paused: true });
  await act(async () => {
    release({ ...empty, mode: "obsolete" });
  });
  expect(result.current.status).toBeNull();
  rerender({ paused: false });
  await act(async () => {});
  expect(result.current.status).toEqual(empty);
});
it("pauses hidden-window polling and refreshes on visibility", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  renderHook(() => useDesktopLocalShow());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(mocks.read).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
