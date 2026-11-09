import { afterEach, expect, it, vi } from "vitest";
import { DesktopOperation, getDesktopActions } from "../desktop-operations";
afterEach(() => { vi.useRealTimers(); window.__TAURI__ = undefined; });
it("retains ownership after the UI deadline until the native result settles", async () => {
  vi.useFakeTimers(); const operation = new DesktopOperation<string>();
  let finish!: (value: string) => void;
  const work = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  expect(operation.start("Installation", work, 60000)).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(operation.getSnapshot()).toEqual({ kind: "unconfirmed", label: "Installation" });
  expect(operation.start("Duplicate", work)).toBe(false);
  operation.dismiss(); expect(operation.getSnapshot().kind).toBe("unconfirmed");
  finish("installed"); await vi.advanceTimersByTimeAsync(0);
  expect(operation.getSnapshot()).toEqual({ kind: "complete", label: "Installation", value: "installed" });
  expect(work).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it("shows a real late native rejection and permits an explicitly requested new attempt", async () => {
  vi.useFakeTimers(); const operation = new DesktopOperation<void>();
  let fail!: (error: Error) => void;
  operation.start("Window", () => new Promise((_, reject) => { fail = reject; }));
  await vi.advanceTimersByTimeAsync(12000); fail(new Error("Window permission denied"));
  await vi.advanceTimersByTimeAsync(0);
  expect(operation.getSnapshot()).toMatchObject({ kind: "failed", message: "Window permission denied" });
  expect(operation.start("Window", async () => {})).toBe(true);
  await vi.advanceTimersByTimeAsync(0); expect(operation.getSnapshot().kind).toBe("complete");
});
it("keeps pending actions for the same native webview, independently of another core", async () => {
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  const first = getDesktopActions();
  expect(getDesktopActions()).toBe(first);
  window.__TAURI__ = { core: { invoke: vi.fn() } };
  expect(getDesktopActions()).not.toBe(first);
});
it("stops staged provisioning after its deadline without pretending IPC was cancelled", async () => {
  vi.useFakeTimers(); const operation = new DesktopOperation<void>();
  let canContinue!: () => boolean, finish!: () => void;
  operation.start("Local devices", current => { canContinue = current; return new Promise(resolve => { finish = resolve; }); });
  await vi.advanceTimersByTimeAsync(0); expect(canContinue()).toBe(true);
  await vi.advanceTimersByTimeAsync(12000); expect(canContinue()).toBe(false);
  finish(); await vi.advanceTimersByTimeAsync(0);
});
