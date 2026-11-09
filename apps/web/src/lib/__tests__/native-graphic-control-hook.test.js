import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGraphicControl } from "../../test/native-graphic-control-hook.js";
const scope = { orgId: "org", userId: "operator" };
const snapshot = () => ({ ...scope, serverTime: Date.now(), programRevision: 1, cloudEnabled: true, canConfigure: true, canTrigger: true, unknownProgram: false, activeIds: [], templates: [{ id: "graphic", revision: 1, name: "Name", title: "Title", subtitle: "" }] });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(overrides = {}, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  const read = overrides.read ?? vi.fn(async identity => ({ ...snapshot(), ...identity }));
  const send = overrides.send ?? vi.fn(async command => ({ ...command, outcome: "applied", snapshot: snapshot() }));
  const view = renderHook(({ identity, enabled }) => useGraphicControl(identity, { enabled, pollingInterval: enabled ? 2000 : false, read, send }), {
    initialProps: { identity: scope, enabled: true }, wrapper: ({ children }) => React.createElement(QueryClientProvider, { client }, children),
  });
  return { ...view, client, read, send };
}
it("prepares without sending, rejects changed reviews and sends only once for a double click", async () => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  const review = f.result.current.prepare("show", snapshot().templates[0]);
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => { f.result.current.confirm(review); f.result.current.confirm(review); });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0][0].operation).toMatchObject({ kind: "show", expectedProgramRevision: 1, expectedGraphicRevision: 1 });
  await act(async () => f.client.setQueryData(["mobile-graphic-control", scope.userId, scope.orgId], { ...snapshot(), programRevision: 2 }));
  expect(f.result.current.matches(review)).toBe(false);
});
it("retains drafts and the exact uncertain command across navigation", async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error("Lost reply")).mockImplementation(async command => ({ ...command, outcome: "applied", snapshot: snapshot() }));
  const f = setup({ send }); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  act(() => f.result.current.edit(snapshot().templates[0]));
  act(() => f.result.current.change({ name: "Kept", title: "Kept title", subtitle: "" }));
  await act(async () => f.result.current.confirm(f.result.current.prepareSave()));
  const original = f.result.current.attempt.command;
  expect(f.result.current.attempt.kind).toBe("failed");
  f.unmount();
  const next = setup({ send }, f.client);
  expect(next.result.current.draft.content.title).toBe("Kept title");
  expect(next.result.current.canStart).toBe(false);
  await act(async () => next.result.current.retry());
  expect(send.mock.calls[1][0]).toEqual(original);
  await waitFor(() => expect(next.result.current.draft).toBeUndefined());
});
it("reviews an uncertain request without resending it and preserves its draft", async () => {
  const send = vi.fn(async (command, _signal, review) => { if (!review) throw new Error("Lost reply"); return { ...command, outcome: "cancelled", snapshot: snapshot() }; });
  const f = setup({ send }); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  act(() => f.result.current.edit(snapshot().templates[0]));
  await act(async () => f.result.current.confirm(f.result.current.prepareSave()));
  await act(async () => f.result.current.review());
  expect(send.mock.calls[1][2]).toBe(true);
  expect(f.result.current.draft.content.title).toBe("Title");
  expect(f.result.current.attempt.result.outcome).toBe("cancelled");
});
it("retains stale content until the operator explicitly reviews the current revision", async () => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  act(() => f.result.current.edit(snapshot().templates[0]));
  act(() => f.result.current.change({ name: "Mine", title: "My draft", subtitle: "" }));
  const newer = { ...snapshot(), templates: [{ ...snapshot().templates[0], revision: 2, title: "Other edit" }] };
  await act(async () => f.client.setQueryData(["mobile-graphic-control", scope.userId, scope.orgId], newer));
  await waitFor(() => expect(f.result.current.draftStale).toBe(true));
  expect(f.result.current.matches(f.result.current.prepareSave())).toBe(false);
  act(() => f.result.current.rebase());
  expect(f.result.current.draft.content.title).toBe("My draft");
  expect(f.result.current.prepareSave().operation.expectedGraphicRevision).toBe(2);
});
it.each(["userId", "orgId"])("isolates drafts and late callbacks when %s changes", async field => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  act(() => f.result.current.edit(snapshot().templates[0]));
  const old = f.result.current, review = old.prepareSave();
  f.rerender({ identity: { ...scope, [field]: "other" }, enabled: true });
  expect(f.result.current.draft).toBeUndefined();
  await act(async () => old.confirm(review));
  expect(f.send).not.toHaveBeenCalled();
  f.rerender({ identity: scope, enabled: true });
  expect(f.result.current.draft.content.title).toBe("Title");
});
it("bounds reads, ignores late replies, and permits explicit retry", async () => {
  vi.useFakeTimers(); let resolve;
  const read = vi.fn(() => new Promise(done => { resolve = done; }));
  const f = setup({ read });
  await act(async () => { await vi.advanceTimersByTimeAsync(10010); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(f.result.current.state.isError).toBe(true);
  expect(read.mock.calls[0][1].aborted).toBe(true);
  await act(async () => { resolve(snapshot()); await vi.advanceTimersByTimeAsync(2100); });
  expect(f.result.current.state.data).toBeUndefined(); expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(snapshot());
  await act(async () => { await f.result.current.state.refetch(); await vi.advanceTimersByTimeAsync(1); });
  expect(f.result.current.canStart).toBe(true);
});
it("retries only the read after an acknowledged command cannot refresh", async () => {
  const read = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("Read failed"));
  const f = setup({ read }); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  await act(async () => f.result.current.confirm(f.result.current.prepare("show", snapshot().templates[0])));
  expect(f.result.current.attempt.refresh).toBe("failed");
  read.mockResolvedValue(snapshot());
  await act(async () => f.result.current.refresh());
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.result.current.attempt.refresh).toBe("done");
});
it("blocks writes and polling when the route loses focus", async () => {
  const f = setup(); await waitFor(() => expect(f.result.current.canStart).toBe(true));
  const review = f.result.current.prepare("show", snapshot().templates[0]);
  vi.useFakeTimers(); f.rerender({ identity: scope, enabled: false });
  const count = f.read.mock.calls.length;
  await act(async () => { f.result.current.confirm(review); await vi.advanceTimersByTimeAsync(6000); });
  expect(f.read).toHaveBeenCalledTimes(count); expect(f.send).not.toHaveBeenCalled();
});
