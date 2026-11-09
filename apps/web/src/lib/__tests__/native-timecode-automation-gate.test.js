import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTimecodeAutomationGate } from "../../test/native-timecode-automation-gate-hook.js";
const scope = { orgId: "org", userId: "operator", showId: "show", serviceDate: "2026-11-08" };
const state = { ...scope, automationRevision: "review-1", triggersEnabled: false, automaticCuesEnabled: true, automationHold: null };
const receipt = command => ({ ...scope, requestId: command.requestId, outcome: "applied" });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(send = vi.fn(async command => receipt(command)), refresh = vi.fn(async () => {})) {
  const client = new QueryClient();
  const initialProps = { identity: scope, active: true, canSend: true, canResume: true, state };
  const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (props = initialProps) => renderHook(({ identity, ...options }) =>
    useTimecodeAutomationGate(identity, { ...options, send, refresh }), { initialProps: props, wrapper });
  return { ...mount(), mount, send, refresh, initialProps };
}
const attempts = f => Object.values(f.result.current.work);
it("stops immediately even while another change prevents resuming", async () => {
  const f = setup(); f.rerender({ ...f.initialProps, canResume: false });
  await act(async () => f.result.current.stop());
  expect(f.send.mock.calls[0][0]).toMatchObject({ operation: "stop" });
  expect(attempts(f)[0]).toMatchObject({ kind: "confirmed", refresh: "done" });
});
it("requires confirmation, permits cancellation, and retains a review across navigation", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("resume"));
  await waitFor(() => expect(f.result.current.review).not.toBeNull());
  expect(f.send).not.toHaveBeenCalled();
  f.unmount(); const next = f.mount();
  expect(next.result.current.review.command.operation).toBe("resume");
  await act(async () => next.result.current.cancel());
  await waitFor(() => expect(next.result.current.review).toBeNull());
  expect(f.send).not.toHaveBeenCalled();
});
it.each([
  { automationRevision: "new-stop" }, { automationHold: { id: "new-jump" } }, { serviceDate: "2026-11-09" },
])("rejects stale confirmation after %j", async change => {
  const f = setup(); await act(async () => f.result.current.prepare("resume"));
  f.rerender({ ...f.initialProps, state: { ...state, ...change } });
  expect(f.result.current.changed).toBe(true);
  await act(async () => f.result.current.confirm());
  expect(f.send).not.toHaveBeenCalled();
});
it("explicit review uses the new decision and does not depend on frame ticks", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("resume"));
  f.rerender({ ...f.initialProps, state: { ...state, automationRevision: "new-stop", totalFrames: 100 } });
  await act(async () => f.result.current.reviewCurrent());
  await waitFor(() => expect(f.result.current.changed).toBe(false));
  f.rerender({ ...f.initialProps, state: { ...state, automationRevision: "new-stop", totalFrames: 101 } });
  expect(f.result.current.changed).toBe(false);
  await act(async () => f.result.current.confirm());
  expect(f.send.mock.calls[0][0]).toMatchObject({ operation: "resume", expected: { revision: "new-stop" }, confirmed: true });
});
it("Stop remains available while Resume waits and duplicate stop clicks send once", async () => {
  const f = setup(vi.fn(() => new Promise(() => {}))); vi.useFakeTimers();
  await act(async () => f.result.current.prepare("resume"));
  await act(async () => f.result.current.confirm());
  await act(async () => { f.result.current.stop(); f.result.current.stop(); });
  expect(f.send.mock.calls.map(([command]) => command.operation)).toEqual(["resume", "stop"]);
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(attempts(f).every(value => value.kind === "failed")).toBe(true);
});
it("keeps timed-out requests across navigation and retries the same identity", async () => {
  vi.useFakeTimers(); const send = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async command => receipt(command));
  const f = setup(send); await act(async () => f.result.current.stop());
  const original = send.mock.calls[0][0]; f.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  const next = f.mount();
  expect(attempts(next)[0].kind).toBe("failed");
  expect(send.mock.calls[0][1].aborted).toBe(true);
  await act(async () => next.result.current.retry(original.requestId));
  expect(send.mock.calls[1][0]).toEqual(original);
  expect(attempts(next)[0]).toMatchObject({ kind: "confirmed", refresh: "done" });
});
it("refresh recovery never repeats the mutation and cannot dismiss an unresolved refresh", async () => {
  vi.useFakeTimers(); const refresh = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(undefined);
  const f = setup(undefined, refresh); await act(async () => f.result.current.stop());
  const id = f.send.mock.calls[0][0].requestId;
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  await act(async () => { f.result.current.finish(id); f.result.current.retry(id); });
  expect(attempts(f)[0]).toMatchObject({ kind: "confirmed", refresh: "failed" });
  await act(async () => f.result.current.refresh(id));
  expect(f.send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.finish(id)); expect(attempts(f)).toEqual([]);
});
it.each(["orgId", "userId", "showId"])("keeps late results with their original %s", async field => {
  let finish; const f = setup(vi.fn(command => new Promise(resolve => { finish = () => resolve(receipt(command)); })));
  await act(async () => f.result.current.stop());
  f.rerender({ ...f.initialProps, identity: { ...scope, [field]: "other" } });
  await act(async () => finish());
  expect(attempts(f)).toEqual([]); expect(f.refresh).not.toHaveBeenCalled();
  f.rerender(f.initialProps); expect(attempts(f)[0]).toMatchObject({ kind: "confirmed", refresh: "idle" });
});
it("refuses offline changes, missing revision and incoming format proposals", async () => {
  const f = setup(); f.rerender({ ...f.initialProps, canSend: false });
  await act(async () => { f.result.current.stop(); f.result.current.prepare("resume"); f.result.current.confirm(); });
  expect(f.send).not.toHaveBeenCalled();
  for (const change of [{ automationRevision: undefined }, { incomingFormat: { id: "format" } }]) {
    f.rerender({ ...f.initialProps, state: { ...state, ...change } });
    await act(async () => f.result.current.prepare("resume"));
    expect(f.result.current.canReview).toBe(false); expect(f.result.current.review).toBeNull();
  }
});
it("requires the global gate before reviewing automatic cues", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("resume-automatic"));
  expect(f.result.current.error).toMatch(/Enable automation/);
  f.rerender({ ...f.initialProps, state: { ...state, triggersEnabled: true, automaticCuesEnabled: false } });
  await act(async () => f.result.current.prepare("resume-automatic"));
  await act(async () => f.result.current.confirm());
  expect(f.send.mock.calls[0][0].operation).toBe("resume-automatic");
});
