import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProPresenterOutput } from "../useProPresenterOutput";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/propresenter-output", () => ({
  getProPresenterOutput: mocks.read,
  changeProPresenterOutput: mocks.write,
}));
const options: Parameters<typeof useProPresenterOutput>[0] = {
  orgId: "org",
  userId: "user",
  surface: "rundown",
  enabled: true,
};
const clients: QueryClient[] = [];
let snapshot = {
  enabled: false,
  revision: null as string | null,
  serverTime: 0,
};
function setup(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  props = options,
) {
  clients.push(client);
  return {
    client,
    ...renderHook((value) => useProPresenterOutput(value), {
      initialProps: props,
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client }, children),
    }),
  };
}
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  snapshot = { enabled: false, revision: null, serverTime: Date.now() };
  mocks.read.mockImplementation(async () => ({
    ...snapshot,
    serverTime: Date.now(),
  }));
  mocks.write.mockImplementation(
    async ({ data: { surface: _surface, ...command } }) => {
      snapshot = {
        enabled: command.enabled,
        revision: crypto.randomUUID(),
        serverTime: Date.now(),
      };
      return { ...command, outcome: "applied", snapshot };
    },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.useRealTimers();
});
it("requires a review, then sends one exact command across simultaneous surfaces", async () => {
  const a = setup();
  const b = setup(a.client, { ...options, surface: "settings" });
  await settle();
  const review = a.result.current.prepare();
  const other = b.result.current.prepare();
  expect(review).not.toBeNull();
  expect(other).not.toBeNull();
  expect(mocks.write).not.toHaveBeenCalled();
  act(() => {
    if (review) a.result.current.confirm(review);
    if (other) b.result.current.confirm(other);
  });
  await settle();
  expect(mocks.write).toHaveBeenCalledOnce();
  expect(a.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "done",
  });
  expect(b.result.current.attempt).toMatchObject({
    kind: "confirmed",
    result: { enabled: true },
  });
});
it("recovers the original request after navigation to Settings without discarding unknown output", async () => {
  mocks.write.mockRejectedValueOnce(new Error("lost"));
  const a = setup();
  await settle();
  const review = a.result.current.prepare();
  act(() => {
    if (review) a.result.current.confirm(review);
  });
  await settle();
  const original = mocks.write.mock.calls[0][0].data;
  a.unmount();
  const b = setup(a.client, { ...options, surface: "settings" });
  await settle();
  expect(b.result.current.attempt?.kind).toBe("unknown");
  expect(b.result.current.prepare()).toBeNull();
  act(() => b.result.current.dismiss());
  expect(b.result.current.attempt?.kind).toBe("unknown");
  act(() => b.result.current.recover());
  await settle();
  expect(mocks.write.mock.calls[1][0].data).toEqual({
    ...original,
    surface: "settings",
  });
});
it("invalidates a review when output revision or access changes", async () => {
  const a = setup();
  await settle();
  const review = a.result.current.prepare();
  act(() =>
    a.client.setQueryData(
      ["web-propresenter-output-state", "user", "org", "rundown"],
      { ...snapshot, revision: crypto.randomUUID() },
    ),
  );
  if (!review) throw new Error("Missing review");
  act(() => a.result.current.confirm(review));
  expect(a.result.current.matches(review)).toBe(false);
  a.rerender({ ...options, enabled: false });
  act(() => a.result.current.confirm(review));
  expect(mocks.write).not.toHaveBeenCalled();
});
it.each(["userId", "orgId"])(
  "keeps unknown commands isolated when %s changes",
  async (field) => {
    mocks.write.mockRejectedValueOnce(new Error("lost"));
    const a = setup();
    await settle();
    const review = a.result.current.prepare();
    act(() => {
      if (review) a.result.current.confirm(review);
    });
    await settle();
    a.rerender({ ...options, [field]: "other" });
    await settle();
    expect(a.result.current.attempt).toBeNull();
    a.rerender(options);
    await settle();
    expect(a.result.current.attempt?.kind).toBe("unknown");
  },
);
it("bounds the first read and the lost write even if transports ignore abort", async () => {
  mocks.read.mockImplementationOnce(() => new Promise(() => {}));
  const a = setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_001);
  });
  expect(a.result.current.state.isError).toBe(true);
  expect(a.result.current.prepare()).toBeNull();
  expect(mocks.read.mock.calls[0][0].signal.aborted).toBe(true);
  act(() => {
    void a.result.current.state.refetch();
  });
  await settle();
  mocks.write.mockImplementationOnce(() => new Promise(() => {}));
  const review = a.result.current.prepare();
  act(() => {
    if (review) a.result.current.confirm(review);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_001);
  });
  expect(a.result.current.attempt?.kind).toBe("unknown");
  expect(mocks.write.mock.calls[0][0].signal.aborted).toBe(true);
});
it("retries only the read after a saved result cannot refresh", async () => {
  const a = setup();
  await settle();
  const review = a.result.current.prepare();
  mocks.read.mockRejectedValueOnce(new Error("read lost"));
  act(() => {
    if (review) a.result.current.confirm(review);
  });
  await settle();
  expect(a.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
  expect(a.result.current.prepare()).toBeNull();
  act(() => a.result.current.refresh());
  await settle();
  expect(a.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "done",
  });
  expect(mocks.write).toHaveBeenCalledOnce();
});
it.each([
  "requestId",
  "userId",
  "orgId",
  "expectedRevision",
  "expiresAt",
  "enabled",
])("rejects an acknowledgement with mismatched %s", async (field) => {
  mocks.write.mockImplementationOnce(
    async ({ data: { surface: _surface, ...command } }) => ({
      ...command,
      [field]:
        field === "enabled"
          ? false
          : field === "expiresAt"
            ? command.expiresAt + 1
            : crypto.randomUUID(),
      outcome: "applied",
      snapshot,
    }),
  );
  const a = setup();
  await settle();
  const review = a.result.current.prepare();
  act(() => {
    if (review) a.result.current.confirm(review);
  });
  await settle();
  expect(a.result.current.attempt?.kind).toBe("unknown");
});
it.each(["conflict", "expired", "superseded"])(
  "requires review after %s without sending another write",
  async (outcome) => {
    mocks.write.mockImplementationOnce(
      async ({ data: { surface: _surface, ...command } }) => ({
        ...command,
        outcome,
        snapshot,
      }),
    );
    const a = setup();
    await settle();
    const review = a.result.current.prepare();
    act(() => {
      if (review) a.result.current.confirm(review);
    });
    await settle();
    expect(a.result.current.canStart).toBe(false);
    act(() => a.result.current.recover());
    expect(mocks.write).toHaveBeenCalledOnce();
    act(() => a.result.current.dismiss());
    expect(a.result.current.canStart).toBe(true);
  },
);
