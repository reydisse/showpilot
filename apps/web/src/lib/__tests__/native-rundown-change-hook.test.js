import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRundownChange } from "../../test/native-rundown-change-hook.js";
const scope = {
  orgId: "org",
  userId: "operator",
  showId: "show",
  serviceDate: "2026-11-08",
};
const remove = { action: "remove-item", itemId: "cue" };
const reply = (command) => ({ ...command, outcome: "applied", revision: 5 });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup(
  send = vi.fn(async (command) => reply(command)),
  refresh = vi.fn(async () => {}),
) {
  const client = new QueryClient();
  const view = renderHook(
    ({ identity, active }) =>
      useRundownChange(identity, { active, send, refresh }),
    {
      initialProps: { identity: scope, active: true },
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    },
  );
  return { ...view, client, send, refresh };
}
it("bounds an uncertain request and retries its exact item, identity and revision", async () => {
  vi.useFakeTimers();
  const send = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(async (c) => reply(c)),
    f = setup(send);
  await act(async () => f.result.current.confirm(remove, 4, "Welcome"));
  const [command, signal] = send.mock.calls[0];
  expect(command).not.toHaveProperty("initiatedAt");
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(signal.aborted).toBe(true);
  expect(f.result.current.attempt.kind).toBe("failed");
  await act(async () =>
    f.result.current.confirm({ action: "clear-all" }, 99, "New show"),
  );
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.retry());
  expect(send.mock.calls[1][0]).toEqual(command);
  expect(f.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "done",
  });
});
it("refresh retry does not repeat an accepted destructive command", async () => {
  vi.useFakeTimers();
  const refresh = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(undefined),
    f = setup(undefined, refresh);
  await act(async () => f.result.current.confirm(remove, 4, "Welcome"));
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
    message: "The rundown could not refresh. Retry to load its current state.",
  });
  await act(async () => f.result.current.refresh());
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.attempt.refresh).toBe("done");
});
it("undo is a separate revision checked request and preserves the removed item identity", async () => {
  const f = setup();
  await act(async () => f.result.current.confirm(remove, 4, "Welcome"));
  const original = f.send.mock.calls[0][0];
  await act(async () => f.result.current.undo(7));
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1][0]).toMatchObject({
    ...scope,
    action: "restore-item",
    itemId: "cue",
    expectedRevision: 7,
  });
  expect(f.send.mock.calls[1][0].requestId).not.toBe(original.requestId);
});
it("does not offer a fresh undo after the original submission window expires", async () => {
  vi.useFakeTimers();
  const f = setup();
  await act(async () => f.result.current.confirm(remove, 4, "Welcome"));
  await act(async () => vi.advanceTimersByTimeAsync(30001));
  await act(async () => f.result.current.undo(7));
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("does not refresh another account when a late acknowledgement arrives", async () => {
  let resolve;
  const f = setup(
    vi.fn(
      (command) =>
        new Promise((done) => {
          resolve = () => done(reply(command));
        }),
    ),
  );
  await act(async () => f.result.current.confirm(remove, 4, "Welcome"));
  f.rerender({ identity: { ...scope, userId: "other" }, active: true });
  await act(async () => resolve());
  expect(f.result.current.attempt).toBeUndefined();
  expect(f.refresh).not.toHaveBeenCalled();
  expect(
    f.client.getQueryData([
      "mobile-rundown-change-request",
      scope.userId,
      scope.orgId,
      scope.showId,
    ]).change,
  ).toMatchObject({ kind: "confirmed", refresh: "idle" });
});
it("rejects a reply for another show", async () => {
  const f = setup(vi.fn(async (c) => ({ ...reply(c), showId: "other" })));
  await act(async () => f.result.current.confirm(remove, 4, "Welcome"));
  expect(f.result.current.attempt).toMatchObject({
    kind: "failed",
    message: expect.stringMatching(/another show/),
  });
  expect(f.refresh).not.toHaveBeenCalled();
});
it("a conflict requires a fresh explicit review, not a retry with a new revision", async () => {
  const f = setup(vi.fn(async (c) => ({ ...reply(c), outcome: "conflict" })));
  await act(async () => f.result.current.confirm(remove, 4, "Welcome"));
  await act(async () => {
    f.result.current.retry();
    f.result.current.confirm(remove, 9, "New welcome");
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.dismiss());
  await act(async () => f.result.current.confirm(remove, 9, "New welcome"));
  expect(f.send).toHaveBeenCalledTimes(2);
});
