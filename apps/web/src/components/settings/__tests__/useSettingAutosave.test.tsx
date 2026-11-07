import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SETTING_SAVE_TIMEOUT_MS, useSettingAutosave, type PersistSetting } from "../useSettingAutosave";
import type { SettingChange, SettingWriteResult } from "@/lib/setting-writes";

afterEach(() => { cleanup(); vi.useRealTimers(); });
function transport() {
  const requests: { change: SettingChange; signal: AbortSignal; resolve: (reply: SettingWriteResult) => void; reject: (error: Error) => void }[] = [];
  const persist = vi.fn<PersistSetting>((change, signal) => new Promise((resolve, reject) => { requests.push({ change, signal, resolve, reject }); }));
  const ack = (index: number, outcome: "applied" | "conflict" = "applied", currentValue = requests[index].change.value) => {
    const request = requests[index]; request.resolve({ key: request.change.key, requestId: request.change.requestId, outcome, currentValue });
  };
  return { persist, requests, ack };
}
const flush = () => act(async () => { await Promise.resolve(); });

it("orders writes for one field and waits for acknowledgement even when the optimistic value matches", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: { "org-timezone": "UTC" }, persist: wire.persist }));
  let first = Promise.resolve(false), second = first, duplicate = first;
  act(() => {
    first = result.current.saveSetting("org-timezone", "America/Toronto");
    second = result.current.saveSetting("org-timezone", "Pacific/Auckland");
    duplicate = result.current.saveSetting("org-timezone", "Pacific/Auckland");
  });
  expect(duplicate).toBe(second);
  await flush(); expect(wire.requests).toHaveLength(1);
  expect(wire.requests[0].change.expectedValue).toBe("UTC");
  expect(result.current.getSetting("org-timezone")).toBe("Pacific/Auckland");
  await act(async () => { wire.ack(0); expect(await first).toBe(true); });
  expect(wire.requests).toHaveLength(2);
  expect(wire.requests[1].change.expectedValue).toBe("America/Toronto");
  await act(async () => { wire.ack(1); expect(await second).toBe(true); });
  expect(result.current.saveState.kind).toBe("saved");
  expect(result.current.hasUnsavedChanges).toBe(false);
});

it("bounds a lost response, reverts the displayed value, ignores late acknowledgement and retries the exact request", async () => {
  vi.useFakeTimers();
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: { "org-timezone": "UTC" }, persist: wire.persist }));
  let save = Promise.resolve(true);
  act(() => { save = result.current.saveSetting("org-timezone", "America/Toronto"); });
  await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(SETTING_SAVE_TIMEOUT_MS); expect(await save).toBe(false); });
  expect(wire.requests[0].signal.aborted).toBe(true);
  expect(result.current.getSetting("org-timezone")).toBe("UTC");
  expect(result.current.saveState).toMatchObject({ kind: "error", failures: [{ occurredAt: Date.now() }] });
  await act(async () => { wire.ack(0); });
  expect(result.current.saveState.kind).toBe("error");
  act(() => { save = result.current.retrySetting("org-timezone"); });
  await flush();
  expect(wire.requests[1].change).toEqual(wire.requests[0].change);
  expect(result.current.getSetting("org-timezone")).toBe("America/Toronto");
  await act(async () => { wire.ack(1); expect(await save).toBe(true); });
  expect(result.current.saveState.kind).toBe("saved");
});

it("keeps each failure visible when another field saves and signals false to awaiting callers", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: {}, persist: wire.persist }));
  let failed = Promise.resolve(true);
  act(() => { failed = result.current.saveSetting("org-timezone", "UTC"); });
  await flush();
  await act(async () => { wire.requests[0].reject(new Error("offline")); expect(await failed).toBe(false); });
  act(() => { void result.current.saveSetting("clock-format", "24hr"); });
  await flush(); await act(async () => { wire.ack(1); });
  expect(result.current.saveState).toMatchObject({ kind: "error", failures: [{ key: "org-timezone", kind: "uncertain" }] });
});

it("holds newer edits after an uncertain write and sends only the latest after exact Retry confirms the old one", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: {}, persist: wire.persist }));
  let queued = Promise.resolve(true);
  act(() => {
    void result.current.saveSetting("propresenter-host", "first.local");
    queued = result.current.saveSetting("propresenter-host", "second.local");
  });
  await flush();
  await act(async () => { wire.requests[0].reject(new Error("lost response")); expect(await queued).toBe(false); });
  await act(async () => { expect(await result.current.saveSetting("propresenter-host", "latest.local")).toBe(false); });
  expect(wire.requests).toHaveLength(1);
  act(() => { void result.current.retrySetting("propresenter-host"); });
  await flush(); await act(async () => { wire.ack(1); });
  expect(wire.requests[2].change).toMatchObject({ value: "latest.local", expectedValue: "first.local" });
  expect(result.current.getSetting("propresenter-host")).toBe("latest.local");
  await act(async () => { wire.ack(2); });
  expect(result.current.saveState.kind).toBe("saved");
});

it("requires conflict review and uses the reviewed current value for a new request", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: { "org-timezone": "UTC" }, persist: wire.persist }));
  act(() => { void result.current.saveSetting("org-timezone", "America/Toronto"); });
  await flush(); await act(async () => { wire.ack(0, "conflict", "Pacific/Auckland"); });
  expect(await result.current.retrySetting("org-timezone")).toBe(false);
  expect(wire.requests).toHaveLength(1);
  act(() => { result.current.editSetting("org-timezone", "Europe/London"); void result.current.resolveConflict("org-timezone", "mine"); });
  await flush();
  expect(wire.requests[1].change).toMatchObject({ value: "Europe/London", expectedValue: "Pacific/Auckland" });
  expect(wire.requests[1].change.requestId).not.toBe(wire.requests[0].change.requestId);
  await act(async () => { wire.ack(1); });
  expect(result.current.hasUnsavedChanges).toBe(false);
});

it("can keep the saved value without sending another mutation", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: {}, persist: wire.persist }));
  act(() => { void result.current.saveSetting("clock-format", "24hr"); });
  await flush(); await act(async () => { wire.ack(0, "conflict", "12hr"); });
  await act(async () => { await result.current.resolveConflict("clock-format", "saved"); });
  expect(result.current.getSetting("clock-format")).toBe("12hr");
  expect(result.current.hasUnsavedChanges).toBe(false);
  expect(wire.requests).toHaveLength(1);
});

it("does not show an old receipt as current success after someone else changed the setting", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: {}, persist: wire.persist }));
  act(() => { void result.current.saveSetting("clock-format", "24hr"); });
  await flush(); await act(async () => { wire.ack(0, "applied", "12hr"); });
  expect(result.current.saveState).toMatchObject({ kind: "error", failures: [{ kind: "conflict", currentValue: "12hr" }] });
});

it("preserves an unsubmitted text draft when an older save completes", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: {}, persist: wire.persist }));
  act(() => { void result.current.saveSetting("propresenter-host", "first.local"); });
  await flush();
  act(() => { result.current.editSetting("propresenter-host", "still typing"); });
  await act(async () => { wire.ack(0); });
  expect(result.current.getSetting("propresenter-host")).toBe("still typing");
  expect(result.current.hasUnsavedChanges).toBe(true);
  act(() => { void result.current.saveSetting("propresenter-host", "still typing"); });
  await flush(); expect(wire.requests[1].change.expectedValue).toBe("first.local");
});

it("does not retarget queued work when the persistence callback changes", async () => {
  const first = transport(), next = transport();
  const { result, rerender } = renderHook(({ persist }) => useSettingAutosave({ initialSettings: {}, persist }), { initialProps: { persist: first.persist } });
  act(() => { void result.current.saveSetting("clock-format", "24hr"); void result.current.saveSetting("clock-format", "12hr"); });
  await flush(); rerender({ persist: next.persist });
  await act(async () => { first.ack(0); });
  expect(first.requests).toHaveLength(2); expect(next.requests).toHaveLength(0);
});

it("settles pending callers and drops unsent work on unmount", async () => {
  const wire = transport();
  const { result, unmount } = renderHook(() => useSettingAutosave({ initialSettings: {}, persist: wire.persist }));
  let first = Promise.resolve(true), second = first;
  act(() => { first = result.current.saveSetting("clock-format", "24hr"); second = result.current.saveSetting("clock-format", "12hr"); });
  await flush(); unmount();
  expect(await first).toBe(false); expect(await second).toBe(false);
  expect(wire.requests[0].signal.aborted).toBe(true);
  wire.ack(0); await Promise.resolve(); expect(wire.requests).toHaveLength(1);
});

it("saves different fields in parallel and distinguishes an absent value from an empty stored value", async () => {
  const wire = transport();
  const { result } = renderHook(() => useSettingAutosave({ initialSettings: { "org-timezone": "" }, persist: wire.persist }));
  act(() => { void result.current.saveSetting("org-timezone", "UTC"); void result.current.saveSetting("clock-format", "24hr"); });
  await flush();
  expect(wire.requests).toHaveLength(2);
  expect(wire.requests[0].change.expectedValue).toBe("");
  expect(wire.requests[1].change.expectedValue).toBeNull();
});
