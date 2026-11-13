import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProPresenterOutput } from "../../test/native-propresenter-output-hook.js";
const scope = { orgId: "org", userId: "operator" };
const revision = "260baf51-5f04-4544-a678-6f04270843aa";
const snapshot = () => ({
  enabled: false,
  revision: null,
  serverTime: Date.now(),
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup(
  overrides = {},
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  }),
) {
  const read = overrides.read ?? vi.fn(async () => snapshot());
  const send =
    overrides.send ??
    vi.fn(async (command) => ({
      ...command,
      outcome: "applied",
      snapshot: { enabled: command.enabled, revision, serverTime: Date.now() },
    }));
  const view = renderHook(
    ({ identity, enabled }) =>
      useProPresenterOutput(identity, { enabled, read, send }),
    {
      initialProps: { identity: scope, enabled: true },
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    },
  );
  return { ...view, client, read, send };
}
it("reviews without sending and confirms the reviewed identity only once", async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.canStart).toBe(true));
  const review = f.result.current.prepare();
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => {
    f.result.current.confirm(review);
    f.result.current.confirm(review);
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0][0]).toMatchObject({
    ...scope,
    enabled: true,
    expectedRevision: null,
  });
  expect(f.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "done",
    result: { outcome: "applied" },
  });
});
it("keeps an uncertain original request through navigation and retries only that request", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("Lost reply"))
    .mockImplementation(async (command) => ({
      ...command,
      outcome: "superseded",
      snapshot: snapshot(),
    }));
  const f = setup({ send });
  await waitFor(() => expect(f.result.current.canStart).toBe(true));
  await act(async () => f.result.current.confirm(f.result.current.prepare()));
  const original = f.result.current.attempt.command;
  expect(f.result.current.attempt.kind).toBe("failed");
  f.unmount();
  const next = setup({ send }, f.client);
  expect(next.result.current.canStart).toBe(false);
  await act(async () => next.result.current.retry());
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0]).toEqual(original);
  expect(next.result.current.attempt).toMatchObject({
    kind: "confirmed",
    result: { outcome: "superseded" },
  });
  expect(next.result.current.canStart).toBe(false);
  await act(async () => next.result.current.dismiss());
  expect(next.result.current.canStart).toBe(true);
});
it("invalidates a review after another operator changes the output revision", async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.canStart).toBe(true));
  const review = f.result.current.prepare();
  await act(async () =>
    f.client.setQueryData(
      ["mobile-propresenter-output-state", scope.userId, scope.orgId],
      { ...snapshot(), revision },
    ),
  );
  expect(f.result.current.matches(review)).toBe(false);
  await act(async () => f.result.current.confirm(review));
  expect(f.send).not.toHaveBeenCalled();
});
it.each(["userId", "orgId"])(
  "isolates retained output work when %s changes",
  async (field) => {
    const f = setup({
      send: vi.fn(async () => {
        throw new Error("Lost reply");
      }),
    });
    await waitFor(() => expect(f.result.current.canStart).toBe(true));
    const review = f.result.current.prepare();
    await act(async () => f.result.current.confirm(review));
    f.rerender({ identity: { ...scope, [field]: "other" }, enabled: true });
    expect(f.result.current.attempt).toBeUndefined();
    expect(f.result.current.matches(review)).toBe(false);
    f.rerender({ identity: scope, enabled: true });
    expect(f.result.current.attempt.kind).toBe("failed");
  },
);
it("bounds a hung state read and preserves an explicit retry", async () => {
  vi.useFakeTimers();
  const read = vi.fn(() => new Promise(() => {}));
  const f = setup({ read });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_100);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(f.result.current.state.isError).toBe(true);
  expect(read.mock.calls[0][1].aborted).toBe(true);
  expect(f.result.current.canStart).toBe(false);
  read.mockResolvedValue(snapshot());
  await act(async () => {
    await f.result.current.state.refetch();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(f.result.current.canStart).toBe(true);
});
it("does not resend a saved command when refreshing current state fails", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockRejectedValue(new Error("Read failed"));
  const f = setup({ read });
  await waitFor(() => expect(f.result.current.canStart).toBe(true));
  await act(async () => f.result.current.confirm(f.result.current.prepare()));
  expect(f.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
  read.mockResolvedValue({ ...snapshot(), enabled: true, revision });
  await act(async () => f.result.current.refresh());
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.attempt.refresh).toBe("done");
});
it("blocks a prepared review after control access is disabled", async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.canStart).toBe(true));
  const review = f.result.current.prepare();
  f.rerender({ identity: scope, enabled: false });
  await act(async () => f.result.current.confirm(review));
  expect(f.send).not.toHaveBeenCalled();
});
it("stops polling and starting commands while the screen is inactive", async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.canStart).toBe(true));
  vi.useFakeTimers();
  f.rerender({ identity: scope, enabled: false });
  const before = f.read.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(f.read).toHaveBeenCalledTimes(before);
  expect(f.result.current.canStart).toBe(false);
  await act(async () => {
    f.rerender({ identity: scope, enabled: true });
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(f.read.mock.calls.length).toBeGreaterThan(before);
});
