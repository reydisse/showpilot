import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDestinationControl } from "../../test/native-destination-control-hook.js";
const scope = { orgId: "org", userId: "operator" };
const fields = { name: "Destination", platform: "custom", rtmpUrl: "rtmp://fixture.invalid/live", streamKey: "" };
const snapshot = () => ({ ...scope, serverTime: Date.now(), canManage: true, destinations: [{ id: "destination", revision: 1, ...fields, hasStreamKey: true, selected: false, status: "none" }] });
const target = () => snapshot().destinations[0];
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(overrides = {}, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  const read = overrides.read ?? vi.fn(async identity => ({ ...snapshot(), ...identity }));
  const send = overrides.send ?? vi.fn(async command => ({ ...command, destinationId: "destination", outcome: "applied" }));
  const view = renderHook(({ identity, enabled }) => useDestinationControl(identity, { enabled, pollingInterval: enabled ? 5000 : false, read, send }), {
    initialProps: { identity: scope, enabled: true }, wrapper: ({ children }) => React.createElement(QueryClientProvider, { client }, children),
  });
  return { ...view, client, read, send };
}
it("prepares without sending, sends once for double confirm and rejects a changed review", async () => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  const review = f.result.current.prepare("disable", target()); expect(f.send).not.toHaveBeenCalled();
  await act(async () => { f.result.current.confirm(review); f.result.current.confirm(review); });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0][0].operation).toMatchObject({ kind: "disable", expectedRevision: 1 });
  await act(async () => f.client.setQueryData(["mobile-destination-control", scope.userId, scope.orgId], { ...snapshot(), destinations: [{ ...target(), revision: 2 }] }));
  expect(f.result.current.matches(review)).toBe(false);
});
it("retains drafts including unsent keys and retries the exact failed command after navigation", async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error("Lost reply")).mockImplementation(async command => ({ ...command, destinationId: "destination", outcome: "applied" }));
  const f = setup({ send }); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  act(() => f.result.current.edit(target())); act(() => f.result.current.change({ ...fields, name: "Retained", streamKey: "unsent-private-key" }));
  await act(async () => f.result.current.confirm(f.result.current.prepareSave()));
  const original = f.result.current.attempt.command; f.unmount();
  const next = setup({ send }, f.client);
  expect(next.result.current.draft.fields.streamKey).toBe("unsent-private-key"); expect(next.result.current.canStart).toBe(false);
  await act(async () => next.result.current.retry()); expect(send.mock.calls[1][0]).toEqual(original);
  await waitFor(() => expect(next.result.current.draft).toBeUndefined());
});
it("keeps admitted but unconfirmed provider work locked and review does not silently dismiss it", async () => {
  const send = vi.fn(async command => ({ ...command, destinationId: "destination", outcome: "unconfirmed" }));
  const f = setup({ send }); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  await act(async () => f.result.current.confirm(f.result.current.prepare("disable", target())));
  const original = f.result.current.attempt.command;
  expect(f.result.current.canStart).toBe(false); expect(f.result.current.settled).toBe(false);
  act(() => f.result.current.dismiss()); expect(f.result.current.attempt.result.outcome).toBe("unconfirmed");
  await act(async () => f.result.current.review()); expect(send.mock.calls[1][0]).toEqual(original); expect(send.mock.calls[1][2]).toBe(true);
  send.mockImplementation(async command => ({ ...command, destinationId: "destination", outcome: "applied" }));
  await act(async () => f.result.current.retry()); expect(send.mock.calls[2][0]).toEqual(original); expect(f.result.current.canStart).toBe(true);
});
it("retains stale fields and requires an explicit revision review", async () => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  act(() => f.result.current.edit(target())); act(() => f.result.current.change({ ...fields, name: "My draft" }));
  await act(async () => f.client.setQueryData(["mobile-destination-control", scope.userId, scope.orgId], { ...snapshot(), destinations: [{ ...target(), revision: 2, name: "Other edit" }] }));
  await waitFor(() => expect(f.result.current.draftStale).toBe(true)); expect(f.result.current.matches(f.result.current.prepareSave())).toBe(false);
  act(() => f.result.current.rebase()); expect(f.result.current.draft.fields.name).toBe("My draft"); expect(f.result.current.prepareSave().operation.expectedRevision).toBe(2);
});
it.each(["userId", "orgId"])("isolates drafts and stale callbacks when %s changes", async field => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true)); act(() => f.result.current.edit(target()));
  const old = f.result.current, review = old.prepareSave();
  f.rerender({ identity: { ...scope, [field]: "other" }, enabled: true }); expect(f.result.current.draft).toBeUndefined();
  await act(async () => old.confirm(review)); expect(f.send).not.toHaveBeenCalled();
  f.rerender({ identity: scope, enabled: true }); expect(f.result.current.draft.fields.name).toBe("Destination");
});
it("bounds reads, ignores late replies and provides an explicit retry", async () => {
  vi.useFakeTimers(); let resolve;
  const read = vi.fn(() => new Promise(done => { resolve = done; })); const f = setup({ read });
  await act(async () => { await vi.advanceTimersByTimeAsync(10010); }); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(f.result.current.state.isError).toBe(true); expect(read.mock.calls[0][1].aborted).toBe(true);
  await act(async () => { resolve(snapshot()); await vi.advanceTimersByTimeAsync(5100); });
  expect(f.result.current.state.data).toBeUndefined(); expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(snapshot()); await act(async () => { await f.result.current.state.refetch(); await vi.advanceTimersByTimeAsync(1); });
  expect(f.result.current.canStart).toBe(true);
});
it("retries only the read after an acknowledged save cannot refresh", async () => {
  const read = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("Read failed"));
  const f = setup({ read }); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  await act(async () => f.result.current.confirm(f.result.current.prepare("select", target()))); expect(f.result.current.attempt.refresh).toBe("failed");
  read.mockResolvedValue(snapshot()); await act(async () => f.result.current.refresh()); expect(f.send).toHaveBeenCalledTimes(1); expect(f.result.current.attempt.refresh).toBe("done");
});
it("blocks commands and polling when the route loses focus", async () => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true)); const review = f.result.current.prepare("disable", target());
  vi.useFakeTimers(); f.rerender({ identity: scope, enabled: false }); const count = f.read.mock.calls.length;
  await act(async () => { f.result.current.confirm(review); await vi.advanceTimersByTimeAsync(15000); });
  expect(f.read).toHaveBeenCalledTimes(count); expect(f.send).not.toHaveBeenCalled();
});
