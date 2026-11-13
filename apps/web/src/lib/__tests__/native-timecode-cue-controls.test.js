import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTimecodeCueControls } from "../../test/native-timecode-cue-controls-hook.js";
const scope = { orgId: "org", userId: "operator", showId: "show", serviceDate: "2026-11-08" };
const state = { ...scope, automationRevision: "gate", triggersEnabled: true, totalFrames: 0, running: false, format: { frameRate: 30, dropFrame: "ndf" } };
const cue = { id: "cue", label: "Opening", editRevision: "revision", fired: false, enabled: true, executionStatus: "scheduled" };
const receipt = command => ({ ...scope, requestId: command.requestId, outcome: "applied" });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(send = vi.fn(async command => receipt(command)), refresh = vi.fn(async () => {})) {
  const client = new QueryClient(); const initialProps = { identity: scope, active: true, canSend: true, state, events: [cue] };
  const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (props = initialProps) => renderHook(({ identity, ...options }) => useTimecodeCueControls(identity, { ...options, send, refresh }), { initialProps: props, wrapper });
  return { ...mount(), mount, send, refresh, initialProps };
}
it.each(["remove", "reset", "rearm", "fire", "retry", "refire"])("requires explicit confirmation for %s", async operation => {
  const f = setup(); await act(async () => f.result.current.prepare(operation, "cue"));
  await waitFor(() => expect(f.result.current.review).not.toBeNull()); expect(f.send).not.toHaveBeenCalled();
  await act(async () => f.result.current.confirm());
  expect(f.send.mock.calls[0][0]).toMatchObject({ operation, confirmed: true });
  expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "done" });
});
it.each(["enable", "disable"])("sends %s once without a destructive confirmation", async operation => {
  const f = setup(); await act(async () => { f.result.current.prepare(operation, "cue"); f.result.current.prepare(operation, "cue"); });
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.result.current.review).toBeNull();
});
it.each([{ editRevision: "new" }, { executionId: "new-attempt" }, { executionStatus: "failed" }, { enabled: false }])("blocks stale confirmation after %j", async change => {
  const f = setup(); await act(async () => f.result.current.prepare("remove", "cue"));
  f.rerender({ ...f.initialProps, events: [{ ...cue, ...change }] });
  expect(f.result.current.changed).toBe(true); await act(async () => f.result.current.confirm()); expect(f.send).not.toHaveBeenCalled();
});
it("reset detects new cues and clock movement while a one-cue review ignores frame ticks", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("reset"));
  f.rerender({ ...f.initialProps, state: { ...state, totalFrames: 1 } }); expect(f.result.current.changed).toBe(true);
  f.rerender({ ...f.initialProps, events: [cue, { ...cue, id: "other" }] }); expect(f.result.current.changed).toBe(true);
  await act(async () => f.result.current.cancel()); await act(async () => f.result.current.prepare("remove", "cue"));
  f.rerender({ ...f.initialProps, state: { ...state, totalFrames: 1 } }); expect(f.result.current.changed).toBe(false);
});
it("retains review across navigation and permits explicit review of a changed cue", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("remove", "cue")); f.unmount();
  const next = f.mount({ ...f.initialProps, events: [{ ...cue, editRevision: "new", label: "Changed" }] });
  expect(next.result.current.changed).toBe(true); await act(async () => next.result.current.reviewCurrent());
  await waitFor(() => expect(next.result.current.review.label).toBe("Changed")); expect(next.result.current.changed).toBe(false);
  await act(async () => next.result.current.cancel()); expect(f.send).not.toHaveBeenCalled();
});
it("retains an uncertain action through navigation and retries the same identity", async () => {
  vi.useFakeTimers(); const send = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async command => receipt(command));
  const f = setup(send); await act(async () => f.result.current.prepare("disable", "cue")); const original = send.mock.calls[0][0]; f.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(15001)); const next = f.mount();
  expect(next.result.current.attempt.kind).toBe("failed"); expect(send.mock.calls[0][1].aborted).toBe(true);
  await act(async () => next.result.current.retry()); expect(send.mock.calls[1][0]).toEqual(original);
});
it("refresh recovery cannot resend or dismiss an unresolved cue request", async () => {
  vi.useFakeTimers(); const refresh = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(undefined);
  const f = setup(undefined, refresh); await act(async () => f.result.current.prepare("disable", "cue"));
  await act(async () => vi.advanceTimersByTimeAsync(12001)); await act(async () => { f.result.current.retry(); f.result.current.finish(); });
  expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "failed" });
  await act(async () => f.result.current.refresh()); expect(f.send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.finish()); expect(f.result.current.attempt).toBeUndefined();
});
it.each(["orgId", "userId", "showId"])("keeps late results out of another %s", async field => {
  let finish; const f = setup(vi.fn(command => new Promise(resolve => { finish = () => resolve(receipt(command)); })));
  await act(async () => f.result.current.prepare("disable", "cue"));
  f.rerender({ ...f.initialProps, identity: { ...scope, [field]: "other" } }); await act(async () => finish());
  expect(f.result.current.attempt).toBeUndefined(); expect(f.refresh).not.toHaveBeenCalled();
});
it("rejects offline confirmation, missing cues, running resets and in-flight deletion", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("remove", "cue"));
  f.rerender({ ...f.initialProps, canSend: false }); await act(async () => f.result.current.confirm()); expect(f.send).not.toHaveBeenCalled();
  await act(async () => f.result.current.cancel()); f.rerender({ ...f.initialProps, state: { ...state, running: true } });
  await act(async () => f.result.current.prepare("reset")); expect(f.result.current.error).toMatch(/Stop the clock/);
  await act(async () => f.result.current.prepare("remove", "missing")); expect(f.result.current.error).toMatch(/no longer/);
  f.rerender({ ...f.initialProps, events: [{ ...cue, executionStatus: "dispatching" }] });
  await act(async () => f.result.current.prepare("remove", "cue")); expect(f.result.current.error).toMatch(/delivery result/);
});

it("surfaces invalid review information instead of throwing from a button", async () => {
  const f = setup(); f.rerender({ ...f.initialProps, events: [{ ...cue, editRevision: "" }] });
  await act(async () => f.result.current.prepare("remove", "cue"));
  expect(f.result.current.error).toMatch(/could not be validated/); expect(f.send).not.toHaveBeenCalled();
});

it("invalidates an output confirmation after another automation decision", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("fire", "cue"));
  f.rerender({ ...f.initialProps, state: { ...state, automationRevision: "new-stop-and-resume" } });
  expect(f.result.current.changed).toBe(true); await act(async () => f.result.current.confirm()); expect(f.send).not.toHaveBeenCalled();
  await act(async () => f.result.current.reviewCurrent()); await waitFor(() => expect(f.result.current.changed).toBe(false));
  await act(async () => f.result.current.confirm()); expect(f.send.mock.calls[0][0].gateRevision).toBe("new-stop-and-resume");
});

it("explains why a live cue cannot be reviewed after automation stops", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("fire", "cue"));
  f.rerender({ ...f.initialProps, state: { ...state, triggersEnabled: false } });
  await act(async () => f.result.current.reviewCurrent());
  expect(f.result.current.error).toBe("Enable automation before firing this cue.");
  expect(f.result.current.changed).toBe(true); await act(async () => f.result.current.confirm()); expect(f.send).not.toHaveBeenCalled();
});
