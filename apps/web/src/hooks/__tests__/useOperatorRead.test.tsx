import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOperatorRead } from "../useOperatorRead";

let visibility: DocumentVisibilityState;
beforeEach(() => { vi.useFakeTimers(); visibility = "visible"; vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const errorMessage = "Read failed; showing the last confirmed value.";
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const changeVisibility = async (next: DocumentVisibilityState) => { await act(async () => { visibility = next; document.dispatchEvent(new Event("visibilitychange")); }); };

describe("useOperatorRead", () => {
  it("retains confirmed data on failure, timestamps it and retries with the current value", async () => {
    const read = vi.fn(async (_signal: AbortSignal, previous: number) => previous + 1);
    const { result } = renderHook(() => useOperatorRead({ key: "org-1", initialValue: 4, read, intervalMs: 2000, errorMessage }));
    await tick(); expect(result.current.value).toBe(5);
    read.mockRejectedValueOnce(new Error("private error details"));
    await tick(2000);
    expect(result.current.value).toBe(5);
    expect(result.current.error).toEqual({ message: errorMessage, occurredAt: Date.now() });
    await act(async () => result.current.retry());
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][1]).toBe(5);
    expect(result.current.value).toBe(6);
    expect(result.current.error).toBeNull();
  });

  it("does not overlap active reads or manual retries", async () => {
    let resolve: (value: number) => void = () => { throw new Error("missing request"); };
    const read = vi.fn((_signal: AbortSignal, _previous: number) => new Promise<number>(done => { resolve = done; }));
    const { result } = renderHook(() => useOperatorRead({ key: "org-1", initialValue: 0, read, intervalMs: 1000, errorMessage }));
    await tick(); await tick(6000);
    act(() => { result.current.retry(); result.current.retry(); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => resolve(1));
    expect(result.current.refreshing).toBe(false);
    await tick(999); expect(read).toHaveBeenCalledTimes(1);
    await tick(1); expect(read).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled request, rejects its late result and lets the operator retry", async () => {
    let resolveOld: (value: number) => void = () => { throw new Error("missing request"); };
    const read = vi.fn<(signal: AbortSignal, previous: number) => Promise<number>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(8);
    const { result } = renderHook(() => useOperatorRead({ key: "org-1", initialValue: 4, read, errorMessage }));
    await tick(8000);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.error?.occurredAt).toBe(Date.now());
    await act(async () => result.current.retry());
    expect(result.current.value).toBe(8);
    await act(async () => resolveOld(99));
    expect(result.current.value).toBe(8);
    expect(result.current.error).toBeNull();
  });

  it("backs off failed polls and returns to the normal interval after recovery", async () => {
    const read = vi.fn(async () => 1).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    renderHook(() => useOperatorRead({ key: "org-1", initialValue: 0, read, intervalMs: 2000, errorMessage }));
    await tick(); expect(read).toHaveBeenCalledTimes(1);
    await tick(3999); expect(read).toHaveBeenCalledTimes(1);
    await tick(1); expect(read).toHaveBeenCalledTimes(2);
    await tick(7999); expect(read).toHaveBeenCalledTimes(2);
    await tick(1); expect(read).toHaveBeenCalledTimes(3);
    await tick(2000); expect(read).toHaveBeenCalledTimes(4);
  });

  it("cancels reads and timers while hidden and refreshes once on return", async () => {
    let resolveOld: (value: number) => void = () => { throw new Error("missing request"); };
    const read = vi.fn<(signal: AbortSignal, previous: number) => Promise<number>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(2);
    const { result } = renderHook(() => useOperatorRead({ key: "org-1", initialValue: 0, read, intervalMs: 1000, errorMessage }));
    await tick(); await changeVisibility("hidden");
    expect(read.mock.calls[0][0].aborted).toBe(true);
    await tick(60_000); act(() => result.current.retry());
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => resolveOld(99));
    expect(result.current.value).toBe(0);
    expect(result.current.error).toBeNull();
    await changeVisibility("visible");
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.value).toBe(2);
  });

  it("does not start a hidden or disabled read", async () => {
    visibility = "hidden";
    const read = vi.fn(async () => 1);
    const { rerender, result } = renderHook(({ enabled }) => useOperatorRead({ key: "org-1", initialValue: 0, read, enabled, errorMessage }), { initialProps: { enabled: true } });
    await tick(60_000); expect(read).not.toHaveBeenCalled();
    rerender({ enabled: false }); await changeVisibility("visible");
    act(() => result.current.retry()); await tick();
    expect(read).not.toHaveBeenCalled();
    rerender({ enabled: true }); await tick();
    expect(result.current.value).toBe(1);
  });

  it("drops previous workspace data and callbacks immediately when the key changes", async () => {
    let rejectOld: (cause: Error) => void = () => { throw new Error("missing request"); };
    const read = vi.fn<(signal: AbortSignal, previous: number) => Promise<number>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; })).mockResolvedValue(20);
    const { result, rerender, unmount } = renderHook(({ key, initial }) => useOperatorRead({ key, initialValue: initial, read, errorMessage }), { initialProps: { key: "old-org", initial: 10 } });
    await tick();
    rerender({ key: "new-org", initial: 0 });
    expect(result.current.value).toBe(0);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    await tick(); await act(async () => rejectOld(new Error("Old workspace failed")));
    expect(result.current.value).toBe(20);
    expect(result.current.error).toBeNull();
    unmount(); await tick(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
