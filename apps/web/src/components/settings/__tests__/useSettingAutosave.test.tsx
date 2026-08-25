import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingAutosave } from "../useSettingAutosave";

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("useSettingAutosave", () => {
  it("keeps same-key writes in operator order", async () => {
    const first = deferred();
    const second = deferred();
    const persist = vi
      .fn<(key: string, value: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useSettingAutosave({ initialSettings: { volume: "low" }, persist }),
    );

    let firstSave = Promise.resolve();
    let secondSave = Promise.resolve();
    act(() => {
      firstSave = result.current.saveSetting("volume", "medium");
      secondSave = result.current.saveSetting("volume", "high");
    });

    await act(async () => Promise.resolve());
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenNthCalledWith(1, "volume", "medium");
    expect(result.current.getSetting("volume")).toBe("high");

    await act(async () => {
      first.resolve();
      await firstSave;
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(2, "volume", "high");

    await act(async () => {
      second.resolve();
      await secondSave;
    });
    expect(result.current.getSetting("volume")).toBe("high");
    expect(result.current.saveState).toEqual({ kind: "saved" });
  });

  it("rolls the newest failed write back to the last confirmed value", async () => {
    const first = deferred();
    const second = deferred();
    const persist = vi
      .fn<(key: string, value: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useSettingAutosave({ initialSettings: { volume: "low" }, persist }),
    );

    let firstSave = Promise.resolve();
    let secondSave = Promise.resolve();
    act(() => {
      firstSave = result.current.saveSetting("volume", "medium");
      secondSave = result.current.saveSetting("volume", "high");
    });

    await act(async () => {
      first.resolve();
      await firstSave;
    });
    await act(async () => {
      second.reject(new Error("offline"));
      await secondSave;
    });

    expect(result.current.getSetting("volume")).toBe("medium");
    expect(result.current.saveState).toEqual({
      kind: "error",
      message: "offline",
    });
  });

  it("saves different keys in parallel", async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const persist = vi.fn((key: string) => {
      const operation = deferred();
      pending.set(key, operation);
      return operation.promise;
    });
    const { result } = renderHook(() =>
      useSettingAutosave({ initialSettings: {}, persist }),
    );

    let firstSave = Promise.resolve();
    let secondSave = Promise.resolve();
    act(() => {
      firstSave = result.current.saveSetting("chat", "on");
      secondSave = result.current.saveSetting("timer", "off");
    });
    await act(async () => Promise.resolve());

    expect(persist).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.get("chat")?.resolve();
      pending.get("timer")?.resolve();
      await Promise.all([firstSave, secondSave]);
    });
    expect(result.current.saveState).toEqual({ kind: "saved" });
  });

  it("never retargets an already queued write when persist changes", async () => {
    const first = deferred();
    const second = deferred();
    const originalPersist = vi
      .fn<(key: string, value: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const replacementPersist = vi.fn<(key: string, value: string) => Promise<void>>();
    const { result, rerender } = renderHook(
      ({ persist }) => useSettingAutosave({ initialSettings: { volume: "low" }, persist }),
      { initialProps: { persist: originalPersist } },
    );

    let firstSave = Promise.resolve();
    let secondSave = Promise.resolve();
    act(() => {
      firstSave = result.current.saveSetting("volume", "medium");
      secondSave = result.current.saveSetting("volume", "high");
    });
    await act(async () => Promise.resolve());

    rerender({ persist: replacementPersist });
    await act(async () => {
      first.resolve();
      await firstSave;
    });

    expect(originalPersist).toHaveBeenCalledTimes(2);
    expect(originalPersist).toHaveBeenNthCalledWith(2, "volume", "high");
    expect(replacementPersist).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve();
      await secondSave;
    });
  });
});
