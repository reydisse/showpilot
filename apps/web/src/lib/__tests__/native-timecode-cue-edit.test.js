import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTimecodeCueEdit } from "../../test/native-timecode-cue-edit-hook.js";
const scope = { orgId: "org", userId: "operator", showId: "show", serviceDate: "2026-11-08" };
const format = { frameRate: 30, dropFrame: "ndf" };
const event = { id: "cue", label: "Original", action: "stage-message", payload: { message: "Stand by" }, enabled: true, skipped: false, fired: false,
  triggerTimecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, triggerFrame: 300, editRevision: "revision1", toleranceFrames: 7, leadMs: 100, executionStatus: "scheduled" };
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(send = vi.fn(async command => ({ ...command, outcome: "applied" })), refresh = vi.fn(async () => {})) {
  const client = new QueryClient();
  const initialProps = { identity: scope, active: true, canSend: true, format, events: [event] };
  const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (props = initialProps) => renderHook(({ identity, ...options }) => useTimecodeCueEdit(identity, { ...options, send, refresh }), { initialProps: props, wrapper });
  return { ...mount(), mount, client, send, refresh, initialProps };
}
async function edit(f) { await act(async () => f.result.current.begin("cue")); await act(async () => f.result.current.update({ label: "Changed" })); }
it("keeps definition and execution review through navigation and saves only allowed fields", async () => {
  const f = setup(); await edit(f); f.unmount(); const next = f.mount();
  expect(next.result.current.draft.definition.label).toBe("Changed");
  await act(async () => next.result.current.save());
  expect(f.send.mock.calls[0][0]).toMatchObject({ id: "cue", expected: { revision: "revision1", fired: false }, updates: { label: "Changed", toleranceFrames: 7, leadMs: 100 } });
  expect(f.send.mock.calls[0][0].updates).not.toHaveProperty("payload");
  expect(f.send.mock.calls[0][0].updates).not.toHaveProperty("fired");
  await act(async () => next.result.current.finish()); expect(next.result.current.draft).toBeNull();
});
it("changes action details only when explicitly enabled", async () => {
  const f = setup(); await edit(f);
  await act(async () => { f.result.current.changeDetails(true); f.result.current.update({ payload: JSON.stringify({ message: "Go" }) }); });
  await act(async () => f.result.current.save()); expect(f.send.mock.calls[0][0].updates.payload).toEqual({ message: "Go" });
});
it("bounds lost replies and retries the same immutable edit after navigation", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async command => ({ ...command, outcome: "applied" }));
  const f = setup(send); await edit(f);
  await act(async () => { f.result.current.save(); f.result.current.save(); }); const original = send.mock.calls[0][0];
  await act(async () => { f.result.current.cancel(); f.result.current.reload(); f.result.current.update({ label: "No" }); });
  expect(f.result.current.draft.definition.label).toBe("Changed");
  f.unmount(); await act(async () => vi.advanceTimersByTimeAsync(15001)); expect(send.mock.calls[0][1].aborted).toBe(true);
  const next = f.mount({ ...f.initialProps, events: [{ ...event, label: "Later", editRevision: "later" }] });
  expect(next.result.current.changed).toBe(true);
  await act(async () => next.result.current.retry());
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0]).toEqual(original);
  expect(next.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "done" });
});
it("refreshes a known edit result without resending the mutation", async () => {
  vi.useFakeTimers(); const refresh = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(undefined);
  const f = setup(undefined, refresh); await edit(f); await act(async () => f.result.current.save());
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  await act(async () => { f.result.current.finish(); f.result.current.retry(); }); expect(f.result.current.locked).toBe(true);
  await act(async () => f.result.current.refresh()); expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.attempt.refresh).toBe("done");
});
it.each(["revision", "fired", "removed", "sending", "format"])("preserves a draft when %s changes and blocks an unreviewed overwrite", async kind => {
  const f = setup(); await edit(f);
  f.rerender({ ...f.initialProps, format: kind === "format" ? { frameRate: 25, dropFrame: "ndf" } : format,
    events: kind === "removed" ? [] : [{ ...event, ...(kind === "revision" ? { editRevision: "new" } : kind === "fired" ? { fired: true } : kind === "sending" ? { executionStatus: "dispatching" } : {}) }] });
  await act(async () => f.result.current.save()); expect(f.send).not.toHaveBeenCalled(); expect(f.result.current.draft.definition.label).toBe("Changed");
  await act(async () => f.result.current.reload());
  expect(f.result.current.draft.definition.label).toBe(kind === "removed" || kind === "sending" ? "Changed" : "Original");
});
it.each(["orgId", "userId", "showId"])("keeps late edit results with the original %s", async field => {
  let finish; const f = setup(vi.fn(command => new Promise(resolve => { finish = () => resolve({ ...command, outcome: "applied" }); })));
  await edit(f); await act(async () => f.result.current.save());
  f.rerender({ ...f.initialProps, identity: { ...scope, [field]: "other" } }); await act(async () => finish());
  expect(f.result.current.draft).toBeNull(); expect(f.result.current.attempt).toBeUndefined(); expect(f.refresh).not.toHaveBeenCalled();
  f.rerender(f.initialProps); expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "idle" });
});
it.each(["orgId", "userId", "showId", "requestId"])("rejects an edit receipt for the wrong %s", async field => {
  const f = setup(vi.fn(async command => ({ ...command, [field]: field === "requestId" ? crypto.randomUUID() : "other", outcome: "applied" })));
  await edit(f); await act(async () => f.result.current.save()); expect(f.result.current.attempt.kind).toBe("failed");
});
it("keeps rejected drafts and requires review before a new save", async () => {
  const f = setup(vi.fn(async command => ({ ...command, outcome: "conflict" }))); await edit(f);
  await act(async () => f.result.current.save()); await waitFor(() => expect(f.result.current.attempt.refresh).toBe("done")); await act(async () => f.result.current.finish());
  expect(f.result.current.draft.definition.label).toBe("Changed");
  await act(async () => f.result.current.reload()); await waitFor(() => expect(f.result.current.draft.definition.label).toBe("Original"));
});
it("cannot start, save or retry without control", async () => {
  const f = setup(); f.rerender({ ...f.initialProps, canSend: false });
  await act(async () => f.result.current.begin("cue")); expect(f.result.current.draft).toBeNull();
  f.rerender(f.initialProps); await edit(f); f.rerender({ ...f.initialProps, canSend: false });
  await act(async () => f.result.current.save()); expect(f.send).not.toHaveBeenCalled(); expect(f.result.current.draft).not.toBeNull();
});
