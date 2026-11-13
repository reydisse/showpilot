import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTimecodeCueSave } from "../../test/native-timecode-cue-save-hook.js";
const scope = { orgId: "org", userId: "operator", showId: "show", serviceDate: "2026-11-08" };
const format = { frameRate: 30, dropFrame: "ndf" };
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(send = vi.fn(async command => ({ ...command, outcome: "applied" })), refresh = vi.fn(async () => {})) {
  const client = new QueryClient();
  const initialProps = { identity: scope, active: true, canSend: true, format };
  const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (props = initialProps) => renderHook(({ identity, ...options }) =>
    useTimecodeCueSave(identity, { ...options, send, refresh }), { initialProps: props, wrapper });
  return { ...mount(), mount, client, send, refresh, initialProps };
}
async function fill(f, changes = {}) {
  await act(async () => f.result.current.update({ label: "Keep this cue", action: "lyrics-clear", ...changes }));
}
it("bounds a lost save reply and retries the same immutable request after navigation", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementation(async command => ({ ...command, outcome: "applied" }));
  const f = setup(send);
  await fill(f);
  await act(async () => { f.result.current.save(); f.result.current.save(); });
  expect(send).toHaveBeenCalledTimes(1);
  const original = send.mock.calls[0][0];
  await fill(f, { label: "Must not replace pending draft" });
  expect(f.result.current.draft.label).toBe("Keep this cue");
  f.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(send.mock.calls[0][1].aborted).toBe(true);
  const next = f.mount();
  expect(next.result.current.attempt.kind).toBe("failed");
  expect(next.result.current.attempt.message).toMatch(/may have completed/i);
  expect(next.result.current.draft.label).toBe("Keep this cue");
  await act(async () => next.result.current.retry());
  expect(send.mock.calls[1][0]).toEqual(original);
  expect(next.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "done" });
  await act(async () => next.result.current.finish(false));
  expect(next.result.current.attempt).toBeUndefined();
  expect(next.result.current.draft.label).toBe("");
});
it("retries a failed refresh without creating another cue", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(undefined);
  const f = setup(undefined, refresh);
  await fill(f);
  await act(async () => f.result.current.save());
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "failed" });
  await act(async () => { f.result.current.finish(false); f.result.current.retry(); });
  expect(f.result.current.locked).toBe(true);
  await act(async () => f.result.current.refresh());
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.attempt.refresh).toBe("done");
});
it.each(["orgId", "userId", "showId"])("keeps late saves with their original %s", async field => {
  let finish;
  const f = setup(vi.fn(command => new Promise(resolve => { finish = () => resolve({ ...command, outcome: "applied" }); })));
  await fill(f);
  await act(async () => f.result.current.save());
  f.rerender({ ...f.initialProps, identity: { ...scope, [field]: "other" } });
  await act(async () => finish());
  expect(f.result.current.attempt).toBeUndefined();
  expect(f.result.current.draft.label).toBe("");
  expect(f.refresh).not.toHaveBeenCalled();
  f.rerender(f.initialProps);
  expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "idle" });
  expect(f.result.current.draft.label).toBe("Keep this cue");
});
it.each(["orgId", "userId", "showId", "requestId"])("rejects a receipt with the wrong %s", async field => {
  const f = setup(vi.fn(async command => ({ ...command, [field]: field === "requestId" ? crypto.randomUUID() : "other", outcome: "applied" })));
  await fill(f);
  await act(async () => f.result.current.save());
  expect(f.result.current.attempt.kind).toBe("failed");
  expect(f.refresh).not.toHaveBeenCalled();
});
it.each(["removed", "conflict", "rejected"])("keeps a %s result available for explicit draft review", async outcome => {
  const f = setup(vi.fn(async command => ({ ...command, outcome })));
  await fill(f);
  await act(async () => f.result.current.save());
  await act(async () => f.result.current.retry());
  expect(f.send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.finish(true));
  expect(f.result.current.draft.label).toBe("Keep this cue");
  await act(async () => f.result.current.save());
  expect(f.send.mock.calls[1][0].requestId).not.toBe(f.send.mock.calls[0][0].requestId);
});
it("preserves an offline draft but cannot send it without control", async () => {
  const f = setup();
  f.rerender({ ...f.initialProps, canSend: false });
  await fill(f);
  await act(async () => f.result.current.save());
  expect(f.send).not.toHaveBeenCalled();
  expect(f.result.current.error).toMatch(/claim control/i);
  f.unmount();
  expect(f.mount().result.current.draft.label).toBe("Keep this cue");
});
it("does not silently reinterpret draft time after a format change", async () => {
  const f = setup();
  await fill(f, { timecode: "00:01:00:00" });
  f.rerender({ ...f.initialProps, format: { frameRate: 29.97, dropFrame: "df" } });
  expect(f.result.current.draft.format).toEqual(format);
  await act(async () => f.result.current.reviewFormat());
  await act(async () => f.result.current.save());
  expect(f.send).not.toHaveBeenCalled();
  expect(f.result.current.error).toMatch(/drop-frame/);
  await fill(f, { timecode: "00:01:00;02" });
  await act(async () => f.result.current.save());
  expect(f.send.mock.calls[0][0].expectedFormat).toEqual({ frameRate: 29.97, dropFrame: "df" });
});
