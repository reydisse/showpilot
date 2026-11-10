import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirmedWrite } from "./useConfirmedWrite";

afterEach(() => { cleanup(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("confirmed write recovery", () => {
  it("retries the same request after a lost reply and ignores its late completion", async () => {
    vi.useFakeTimers();
    const late = deferred<{ id: string }>();
    const write = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce({ id: "saved" });
    const apply = vi.fn();
    const { result } = renderHook(() => useConfirmedWrite("org/song"));
    let first!: Promise<boolean>;
    act(() => { first = result.current.start({ label: "Save section", write, apply }); });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(await first).toBe(false);
    expect(result.current.state).toMatchObject({ status: "failed", saved: false });
    expect(write.mock.calls[0][1].aborted).toBe(true);
    await act(async () => { expect(await result.current.retry()).toBe(true); });
    expect(write.mock.calls[1][0]).toBe(write.mock.calls[0][0]);
    expect(apply).toHaveBeenCalledExactlyOnceWith({ id: "saved" });
    await act(async () => late.resolve({ id: "late" }));
    expect(apply).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("idle");
  });

  it("serializes rapid clicks and retains the original command across edits", async () => {
    const response = deferred<string>();
    const write = vi.fn(() => response.promise);
    const otherWrite = vi.fn();
    const apply = vi.fn();
    const { result, rerender } = renderHook(() => useConfirmedWrite("org/song"));
    let first!: Promise<boolean>;
    act(() => { first = result.current.start({ label: "Save original", write, apply }); });
    rerender();
    await act(async () => { expect(await result.current.start({ label: "Changed draft", write: otherWrite, apply })).toBe(false); });
    expect(otherWrite).not.toHaveBeenCalled();
    await act(async () => { response.resolve("original"); await first; });
    expect(apply).toHaveBeenCalledExactlyOnceWith("original");
  });

  it("retries opening after acknowledgement without repeating the write or local reconciliation", async () => {
    const write = vi.fn().mockResolvedValue({ id: "saved" });
    const apply = vi.fn();
    const finish = vi.fn().mockRejectedValueOnce(new Error("Could not open page")).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useConfirmedWrite("org/new"));
    await act(async () => { await result.current.start({ label: "Create song", write, apply, finish }); });
    expect(result.current.state).toMatchObject({ status: "failed", saved: true, message: "Could not open page" });
    await act(async () => { await result.current.retry(); });
    expect(write).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledTimes(2);
  });

  it("bounds post-save navigation too", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue("saved");
    const finish = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useConfirmedWrite("org/new"));
    act(() => { void result.current.start({ label: "Create song", write, apply: vi.fn(), finish }); });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.state).toMatchObject({ status: "failed", saved: true });
    await act(async () => { await result.current.retry(); });
    expect(write).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe("idle");
  });

  it("cancels on unmount and never applies an abandoned response", async () => {
    const late = deferred<string>();
    const apply = vi.fn();
    const write = vi.fn(() => late.promise);
    const { result, unmount } = renderHook(() => useConfirmedWrite("org/song"));
    let pending!: Promise<boolean>;
    await act(async () => { pending = result.current.start({ label: "Save", write, apply }); });
    unmount();
    expect(await pending).toBe(false);
    expect(write.mock.calls[0]).toHaveLength(2);
    await act(async () => late.resolve("abandoned"));
    expect(apply).not.toHaveBeenCalled();
  });

  it("isolates a different song and a return to the original song", async () => {
    const late = deferred<string>();
    const apply = vi.fn();
    const { result, rerender } = renderHook(({ scope }) => useConfirmedWrite(scope), { initialProps: { scope: "org/a" } });
    await act(async () => { void result.current.start({ label: "Save A", write: () => late.promise, apply }); });
    rerender({ scope: "org/b" });
    expect(result.current.state.status).toBe("idle");
    rerender({ scope: "org/a" });
    await act(async () => late.resolve("old A"));
    expect(apply).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.start({ label: "New A", write: async () => "new A", apply })).toBe(true); });
    expect(apply).toHaveBeenCalledExactlyOnceWith("new A");
  });
});
