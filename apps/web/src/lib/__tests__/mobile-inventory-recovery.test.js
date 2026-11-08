import { jsx as _jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMobileInventory } from "../../test/native-inventory-hook.js";
const rpc = vi.hoisted(() => ({ mutate: vi.fn(), review: vi.fn() }));
let client;
function reply(data, outcome = "applied") {
  return {
    requestId: data.requestId,
    id: data.operation.kind === "create" ? data.requestId : data.operation.id,
    outcome,
    item: null,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(onChanged = vi.fn(async (_signal) => {})) {
  const wrapper = ({ children }) =>
    _jsx(QueryClientProvider, { client: client, children: children });
  return {
    ...renderHook(
      ({ userId, orgId }) =>
        useMobileInventory(
          { userId, orgId },
          onChanged,
          (data, review, signal) =>
            (review ? rpc.review : rpc.mutate)({ data, signal }),
          true,
        ),
      { wrapper, initialProps: { userId: "user", orgId: "org" } },
    ),
    onChanged,
  };
}
beforeEach(() => {
  client = new QueryClient();
  rpc.mutate.mockReset().mockImplementation(async ({ data }) => reply(data));
  rpc.review
    .mockReset()
    .mockImplementation(async ({ data }) => reply(data, "cancelled"));
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});
function draft(view) {
  act(() =>
    view.result.current.setDraft((value) => ({
      ...value,
      name: "Weekly show",
      description: "Retain this",
    })),
  );
}
it("retains the draft across dialog closure and isolates accounts and organizations", () => {
  const first = setup();
  draft(first);
  first.unmount();
  const second = setup();
  expect(second.result.current.draft.name).toBe("Weekly show");
  second.rerender({ userId: "another", orgId: "org" });
  expect(second.result.current.draft.name).toBe("");
  second.rerender({ userId: "user", orgId: "another" });
  expect(second.result.current.draft.name).toBe("");
  second.rerender({ userId: "user", orgId: "org" });
  expect(second.result.current.draft.description).toBe("Retain this");
});
it("claims repeated clicks synchronously and preserves the exact request on retry", async () => {
  rpc.mutate.mockRejectedValueOnce(new Error("Reply lost"));
  const view = setup();
  draft(view);
  act(() => {
    view.result.current.create();
    view.result.current.create();
  });
  await waitFor(() =>
    expect(view.result.current.attempt?.kind).toBe("unconfirmed"),
  );
  expect(rpc.mutate).toHaveBeenCalledTimes(1);
  const original = rpc.mutate.mock.calls[0][0].data;
  act(() =>
    view.result.current.setDraft((value) => ({
      ...value,
      name: "Replacement",
    })),
  );
  expect(view.result.current.draft.name).toBe("Weekly show");
  act(() => view.result.current.retry());
  await waitFor(() => expect(view.result.current.attempt).toBeNull());
  expect(rpc.mutate.mock.calls[1][0].data).toEqual(original);
  expect(view.result.current.draft.name).toBe("");
});
it("refresh failure retries only the read and does not repeat a confirmed write", async () => {
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValue(undefined);
  const view = setup(refresh);
  draft(view);
  act(() => view.result.current.create());
  await waitFor(() =>
    expect(view.result.current.attempt).toMatchObject({
      kind: "settled",
      refresh: "failed",
      message: "Read failed",
    }),
  );
  expect(view.result.current.draft.name).toBe("Weekly show");
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.attempt).toBeNull());
  expect(rpc.mutate).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("late success retains its result after closure without refreshing another screen", async () => {
  const held = deferred();
  rpc.mutate.mockReturnValue(held.promise);
  const first = setup();
  draft(first);
  act(() => first.result.current.create());
  await waitFor(() => expect(rpc.mutate).toHaveBeenCalledTimes(1));
  const command = rpc.mutate.mock.calls[0][0].data;
  first.unmount();
  await act(async () => held.resolve(reply(command)));
  expect(first.onChanged).not.toHaveBeenCalled();
  const second = setup();
  expect(second.result.current.attempt?.kind).toBe("settled");
  act(() => second.result.current.refresh());
  await waitFor(() => expect(second.result.current.attempt).toBeNull());
  expect(rpc.mutate).toHaveBeenCalledTimes(1);
});
it("cache clearing prevents a late reply from recreating old account work", async () => {
  const held = deferred();
  rpc.mutate.mockReturnValue(held.promise);
  const view = setup();
  draft(view);
  act(() => view.result.current.create());
  await waitFor(() => expect(rpc.mutate).toHaveBeenCalledTimes(1));
  const command = rpc.mutate.mock.calls[0][0].data;
  act(() => client.clear());
  await act(async () => held.resolve(reply(command)));
  expect(view.result.current.attempt).toBeNull();
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(
    client.getQueryData(["mobile-show-inventory", "user", "org"]),
  ).toMatchObject({
    draft: { name: "" },
    attempt: null,
  });
});
it("account switching ignores late refresh callbacks", async () => {
  const held = deferred();
  rpc.mutate.mockReturnValue(held.promise);
  const view = setup();
  draft(view);
  act(() => view.result.current.create());
  await waitFor(() => expect(rpc.mutate).toHaveBeenCalledTimes(1));
  const command = rpc.mutate.mock.calls[0][0].data;
  view.rerender({ userId: "another", orgId: "org" });
  await act(async () => held.resolve(reply(command)));
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(view.result.current.attempt).toBeNull();
});
it("review cancels the original request before allowing a different submission", async () => {
  rpc.mutate.mockRejectedValueOnce(new Error("Offline"));
  const view = setup();
  draft(view);
  act(() => view.result.current.create());
  await waitFor(() =>
    expect(view.result.current.attempt?.kind).toBe("unconfirmed"),
  );
  const original = rpc.mutate.mock.calls[0][0].data;
  act(() => view.result.current.review());
  await waitFor(() => expect(view.result.current.attempt).toBeNull());
  expect(rpc.review.mock.calls[0][0].data).toEqual(original);
  expect(view.result.current.draft.name).toBe("Weekly show");
  act(() => view.result.current.create());
  await waitFor(() => expect(rpc.mutate).toHaveBeenCalledTimes(2));
  expect(rpc.mutate.mock.calls[1][0].data.requestId).not.toBe(
    original.requestId,
  );
});
it.each(["conflict", "removed"])(
  "%s requires refreshing before an explicit new attempt and preserves the draft",
  async (outcome) => {
    rpc.mutate.mockImplementation(async ({ data }) => reply(data, outcome));
    const view = setup();
    draft(view);
    act(() => view.result.current.create());
    await waitFor(() =>
      expect(view.result.current.attempt?.kind).toBe("settled"),
    );
    expect(view.onChanged).not.toHaveBeenCalled();
    act(() => view.result.current.create());
    expect(rpc.mutate).toHaveBeenCalledTimes(1);
    act(() => view.result.current.refresh());
    await waitFor(() => expect(view.result.current.attempt).toBeNull());
    expect(view.result.current.draft.name).toBe("Weekly show");
  },
);
it("archive captures the displayed version and preserves an unrelated creation draft", async () => {
  const view = setup();
  draft(view);
  act(() =>
    view.result.current.archive(
      {
        id: "saved",
        name: "Saved show",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      true,
    ),
  );
  await waitFor(() => expect(view.result.current.attempt).toBeNull());
  expect(rpc.mutate.mock.calls[0][0].data.operation).toEqual({
    kind: "archive",
    id: "saved",
    archived: true,
    expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(view.result.current.draft.name).toBe("Weekly show");
});
it("times out an unresponsive mutation and ignores its late reply", async () => {
  const held = deferred();
  rpc.mutate.mockReturnValue(held.promise);
  const view = setup();
  draft(view);
  vi.useFakeTimers();
  await act(async () => view.result.current.create());
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(view.result.current.attempt).toMatchObject({
    kind: "unconfirmed",
    message: "This inventory change could not be confirmed.",
  });
  const command = rpc.mutate.mock.calls[0][0].data;
  expect(rpc.mutate.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => held.resolve(reply(command)));
  expect(view.result.current.attempt?.kind).toBe("unconfirmed");
  expect(view.onChanged).not.toHaveBeenCalled();
});
it("times out refresh independently and releases it when the dialog closes", async () => {
  const held = deferred();
  const refresh = vi.fn(() => held.promise);
  const view = setup(refresh);
  draft(view);
  vi.useFakeTimers();
  await act(async () => view.result.current.create());
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(view.result.current.attempt).toMatchObject({
    kind: "settled",
    refresh: "failed",
  });
  await act(async () => view.result.current.refresh());
  view.unmount();
  await act(async () => {});
  vi.useRealTimers();
  const next = setup();
  expect(next.result.current.attempt).toMatchObject({
    kind: "settled",
    refresh: "idle",
  });
  expect(rpc.mutate).toHaveBeenCalledTimes(1);
});
