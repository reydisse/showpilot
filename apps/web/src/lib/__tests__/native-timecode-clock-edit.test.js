import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTimecodeClockEdit } from "../../test/native-timecode-clock-edit-hook.js";
const scope = { orgId: "org", userId: "operator", showId: "show", serviceDate: "2026-11-08" };
const state = { showId: scope.showId, serviceDate: scope.serviceDate, totalFrames: 0, display: "00:00:00:00", running: false,
  format: { frameRate: 30, dropFrame: "ndf" }, signal: { status: "idle", lastFeedAt: null } };
const receipt = command => ({ ...scope, requestId: command.requestId, outcome: "applied" });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(send = vi.fn(async command => receipt(command)), refresh = vi.fn(async () => {})) {
  const client = new QueryClient();
  const initialProps = { identity: scope, active: true, canSend: true, state };
  const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (props = initialProps) => renderHook(({ identity, ...options }) =>
    useTimecodeClockEdit(identity, { ...options, send, refresh }), { initialProps: props, wrapper });
  return { ...mount(), mount, client, send, refresh, initialProps };
}
async function prepare(f) {
  await act(async () => f.result.current.update("00:00:10:00"));
  await act(async () => f.result.current.prepare("seek"));
}
it("does not send until explicit confirmation of the reviewed clock", async () => {
  const f = setup(); await prepare(f);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.result.current.draft.review).toMatchObject({ from: "00:00:00:00", command: { kind: "seek", expected: { frame: 0 } } });
  await act(async () => f.result.current.confirm());
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "done" });
});
it.each([
  { totalFrames: 30, display: "00:00:01:00" },
  { format: { frameRate: 25, dropFrame: "ndf" } },
  { incomingFormat: { id: "new-input", format: { frameRate: 25, dropFrame: "ndf" } } },
  { serviceDate: "2026-11-09" },
])("rejects a confirmation after the reviewed state changes: %j", async changes => {
  const f = setup(); await prepare(f);
  f.rerender({ ...f.initialProps, state: { ...state, ...changes } });
  expect(f.result.current.reviewChanged).toBe(true);
  await act(async () => f.result.current.confirm());
  expect(f.send).not.toHaveBeenCalled();
});
it("allows explicit review of the current clock and cancels without sending", async () => {
  const f = setup(); await prepare(f);
  f.rerender({ ...f.initialProps, state: { ...state, totalFrames: 30, display: "00:00:01:00" } });
  await act(async () => f.result.current.reviewCurrent());
  await waitFor(() => expect(f.result.current.draft.review.from).toBe("00:00:01:00"));
  expect(f.result.current.reviewChanged).toBe(false);
  await act(async () => f.result.current.cancel());
  await waitFor(() => expect(f.result.current.draft.review).toBeNull());
  expect(f.result.current.draft.timecode).toBe("00:00:10:00");
  expect(f.send).not.toHaveBeenCalled();
});
it("keeps a timed-out request across navigation and checks the same identity", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async command => receipt(command));
  const f = setup(send); await prepare(f);
  await act(async () => { f.result.current.confirm(); f.result.current.confirm(); });
  const original = send.mock.calls[0][0];
  f.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  const next = f.mount();
  expect(next.result.current.attempt.kind).toBe("failed");
  expect(send.mock.calls[0][1].aborted).toBe(true);
  await act(async () => next.result.current.retry());
  expect(send.mock.calls[1][0]).toEqual(original);
  expect(next.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "done" });
});
it("keeps a known result while retrying refresh without replaying the edit", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(undefined);
  const f = setup(undefined, refresh); await prepare(f);
  await act(async () => f.result.current.confirm());
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "failed" });
  await act(async () => { f.result.current.finish(); f.result.current.retry(); });
  expect(f.result.current.locked).toBe(true);
  await act(async () => f.result.current.refresh());
  expect(f.send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.finish());
  expect(f.result.current.attempt).toBeUndefined();
});
it.each(["orgId", "userId", "showId"])("does not attach a late result to another %s", async field => {
  let finish;
  const f = setup(vi.fn(command => new Promise(resolve => { finish = () => resolve(receipt(command)); })));
  await prepare(f); await act(async () => f.result.current.confirm());
  f.rerender({ ...f.initialProps, identity: { ...scope, [field]: "other" } });
  await act(async () => finish());
  expect(f.result.current.attempt).toBeUndefined();
  expect(f.refresh).not.toHaveBeenCalled();
  f.rerender(f.initialProps);
  expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "idle" });
});
it("keeps the confirmation across navigation and rejects a running source", async () => {
  const f = setup(); await prepare(f); f.unmount();
  const next = f.mount({ ...f.initialProps, state: { ...state, running: true } });
  expect(next.result.current.draft.review).not.toBeNull();
  expect(next.result.current.canConfirm).toBe(false);
  await act(async () => next.result.current.confirm());
  expect(f.send).not.toHaveBeenCalled();
});
it("rejects invalid drop-frame labels and requires a reviewed format request", async () => {
  const f = setup(); f.rerender({ ...f.initialProps, state: { ...state, format: { frameRate: 29.97, dropFrame: "df" } } });
  await act(async () => f.result.current.update("00:01:00;00"));
  await act(async () => f.result.current.prepare("seek"));
  expect(f.result.current.error).toMatch(/drop-frame/);
  expect(f.result.current.draft.review).toBeNull();
  await act(async () => f.result.current.prepare("reformat", { frameRate: 25, dropFrame: "ndf" }));
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => f.result.current.confirm());
  expect(f.send.mock.calls[0][0]).toMatchObject({ kind: "reformat", expected: { format: { frameRate: 29.97, dropFrame: "df" } }, format: { frameRate: 25, dropFrame: "ndf" }, confirmed: true });
});

it("disables review and confirmation when connection or control is lost", async () => {
  const f = setup(); await prepare(f);
  f.rerender({ ...f.initialProps, canSend: false, state: { ...state, totalFrames: 30 } });
  expect(f.result.current.canReview).toBe(false);
  expect(f.result.current.canConfirm).toBe(false);
  await act(async () => f.result.current.confirm());
  expect(f.send).not.toHaveBeenCalled();
});
