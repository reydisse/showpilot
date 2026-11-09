import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTimecodeLyricsControls } from "../../test/native-timecode-lyrics-hook.js";
const scope = { orgId: "org", userId: "operator", showId: "show", serviceDate: "2026-11-08" };
const lyrics = { songId: "song", songTitle: "Song", sectionId: "verse", sectionLabel: "Verse", lyrics: "First\n\nLast", nextLabel: "Chorus", updatedAt: 10, revision: "r1", generationKey: "load1" };
const state = { showId: scope.showId, serviceDate: scope.serviceDate, lyrics };
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(send = vi.fn(async command => ({ ...command, outcome: "applied" })), refresh = vi.fn(async () => {})) {
  const client = new QueryClient();
  const initialProps = { identity: scope, active: true, canSend: true, state };
  const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (props = initialProps) => renderHook(({ identity, ...options }) => useTimecodeLyricsControls(identity, { ...options, send, refresh }), { initialProps: props, wrapper });
  return { ...mount(), mount, client, send, refresh, initialProps };
}
it.each(["next", "previous", "clear"])("requires a current review before %s output", async operation => {
  const f = setup(); await act(async () => f.result.current.prepare(operation));
  await waitFor(() => expect(f.result.current.review).not.toBeNull());
  expect(f.send).not.toHaveBeenCalled(); expect(f.result.current.review.command.expected).toMatchObject({ revision: "r1", generationKey: "load1" });
  await act(async () => f.result.current.cancel()); expect(f.send).not.toHaveBeenCalled();
  await act(async () => f.result.current.prepare(operation)); await act(async () => { f.result.current.confirm(); f.result.current.confirm(); });
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][0].operation).toBe(operation);
  await act(async () => f.result.current.finish()); expect(f.result.current.locked).toBe(false);
});
it.each(["revision", "generationKey", "sectionId", "cleared", "serviceDate"])("blocks a stale review when %s changes until explicitly reviewed again", async field => {
  const f = setup(); await act(async () => f.result.current.prepare("next"));
  f.rerender({ ...f.initialProps, state: { ...state, ...(field === "serviceDate" ? { serviceDate: "other" } : { lyrics: field === "cleared" ? null : { ...lyrics, [field]: "new" } }) } });
  expect(f.result.current.changed).toBe(true);
  await act(async () => f.result.current.confirm()); expect(f.send).not.toHaveBeenCalled();
  if (field !== "cleared" && field !== "serviceDate") {
    await act(async () => f.result.current.reviewCurrent()); await act(async () => f.result.current.confirm());
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][0].expected[field]).toBe("new");
  }
});
it("retains review across navigation but never treats it as permission to send", async () => {
  const f = setup(); await act(async () => f.result.current.prepare("clear")); f.unmount();
  const next = f.mount({ ...f.initialProps, canSend: false });
  expect(next.result.current.review.command.operation).toBe("clear");
  await act(async () => next.result.current.confirm()); expect(f.send).not.toHaveBeenCalled();
});
it("bounds a lost Clear reply and retries the same identity after navigation even with no lyrics", async () => {
  vi.useFakeTimers(); const send = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async command => ({ ...command, outcome: "applied" }));
  const f = setup(send); await act(async () => f.result.current.prepare("clear")); await act(async () => f.result.current.confirm());
  const original = send.mock.calls[0][0]; f.unmount(); await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(send.mock.calls[0][1].aborted).toBe(true);
  const next = f.mount({ ...f.initialProps, state: { ...state, lyrics: null } });
  expect(next.result.current.canReview).toBe(false);
  await act(async () => next.result.current.retry()); expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0]).toEqual(original);
  expect(next.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "done" });
});
it("refreshes a known result without repeating Next", async () => {
  vi.useFakeTimers(); const refresh = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(undefined);
  const f = setup(undefined, refresh); await act(async () => f.result.current.prepare("next")); await act(async () => f.result.current.confirm());
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  await act(async () => { f.result.current.finish(); f.result.current.retry(); }); expect(f.result.current.locked).toBe(true);
  await act(async () => f.result.current.refresh()); expect(f.send).toHaveBeenCalledTimes(1); expect(f.result.current.attempt.refresh).toBe("done");
});
it.each(["orgId", "userId", "showId"])("keeps late replies with the original %s", async field => {
  let finish; const f = setup(vi.fn(command => new Promise(resolve => { finish = () => resolve({ ...command, outcome: "applied" }); })));
  await act(async () => f.result.current.prepare("next")); await act(async () => f.result.current.confirm());
  f.rerender({ ...f.initialProps, identity: { ...scope, [field]: "other" } }); await act(async () => finish());
  expect(f.result.current.review).toBeNull(); expect(f.result.current.attempt).toBeUndefined(); expect(f.refresh).not.toHaveBeenCalled();
  f.rerender(f.initialProps); expect(f.result.current.attempt).toMatchObject({ kind: "confirmed", refresh: "idle" });
});
it.each(["orgId", "userId", "showId", "requestId"])("rejects a receipt for the wrong %s", async field => {
  const f = setup(vi.fn(async command => ({ ...command, [field]: field === "requestId" ? crypto.randomUUID() : "other", outcome: "applied" })));
  await act(async () => f.result.current.prepare("next")); await act(async () => f.result.current.confirm()); expect(f.result.current.attempt.kind).toBe("failed");
});
it("requires a new review after rejection and prevents actions without connection or lyrics", async () => {
  const f = setup(vi.fn(async command => ({ ...command, outcome: "conflict" })));
  await act(async () => f.result.current.prepare("next")); await act(async () => f.result.current.confirm());
  await waitFor(() => expect(f.result.current.attempt.refresh).toBe("done")); await act(async () => f.result.current.finish());
  await act(async () => f.result.current.confirm()); expect(f.send).toHaveBeenCalledTimes(1);
  for (const props of [{ ...f.initialProps, canSend: false }, { ...f.initialProps, state: { ...state, lyrics: null } }]) {
    f.rerender(props); await act(async () => { f.result.current.prepare("next"); f.result.current.confirm(); });
    expect(f.send).toHaveBeenCalledTimes(1);
  }
});

it("disables recovery while another pending operation blocks sending", async () => {
  const f = setup(vi.fn().mockRejectedValue(new Error("Lost reply")));
  await act(async () => f.result.current.prepare("next")); await act(async () => f.result.current.confirm());
  expect(f.result.current.attempt.kind).toBe("failed");
  f.rerender({ ...f.initialProps, canSend: false }); expect(f.result.current.canRecover).toBe(false);
  await act(async () => f.result.current.retry()); expect(f.send).toHaveBeenCalledTimes(1);
  f.rerender(f.initialProps); expect(f.result.current.canRecover).toBe(true);
});
