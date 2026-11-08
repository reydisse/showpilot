import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRundownReplacement } from "../../test/native-rundown-replacement-hook.js";
import { replacementCommandSchema } from "../rundown-replacement-contract";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const identity = { orgId: "org", userId: "user", showId: "show" },
  source = { kind: "template", id: "template" };
const snapshot = (scope) => ({
  ...scope,
  label: "Template",
  targetName: "Target",
  serviceDate: "2026-11-08",
  expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
  expectedRevision: 0,
  canReplace: true,
  timeZone: "UTC",
  copy: {
    serviceName: "Reviewed",
    scheduledStartTime: null,
    location: "Room",
    items: [],
  },
});
const reply = (command, outcome = "applied") => ({
  orgId: command.orgId,
  userId: command.userId,
  showId: command.showId,
  requestId: command.requestId,
  outcome,
  revision: outcome === "applied" ? 1 : null,
});
function setup() {
  const client = new QueryClient(),
    read = vi.fn(async (scope) => snapshot(scope)),
    send = vi.fn(async (command) => reply(command)),
    refresh = vi.fn(async () => {});
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    (scope) =>
      useRundownReplacement(scope, {
        active: scope.active,
        read,
        send,
        refresh,
      }),
    { wrapper, initialProps: { ...identity, active: true } },
  );
  return {
    ...hook,
    client,
    read,
    send,
    refresh,
    choose: async () => {
      act(() => hook.result.current.choose(source));
      await waitFor(() => expect(hook.result.current.draft?.base).toBeTruthy());
    },
  };
}
it("freezes a strict source and target snapshot and retains it when new source data arrives", async () => {
  const f = setup();
  await f.choose();
  f.read.mockImplementation(async (scope) => ({
    ...snapshot(scope),
    expectedRevision: 9,
    copy: { ...snapshot(scope).copy, serviceName: "Changed" },
  }));
  f.send.mockRejectedValue(new Error("Lost reply"));
  act(() => f.result.current.submit());
  await waitFor(() => expect(f.result.current.attempt.kind).toBe("failed"));
  const command = f.send.mock.calls[0][0];
  expect(replacementCommandSchema.safeParse(command).success).toBe(true);
  act(() => f.result.current.loadCurrent());
  act(() => f.result.current.choose({ kind: "show", id: "other" }));
  act(() => f.result.current.discard());
  expect(f.read).toHaveBeenCalledTimes(1);
  act(() => f.result.current.retry());
  await waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.send.mock.calls[1][0]).toEqual(command);
});
it("retains the draft when explicit source refresh fails", async () => {
  const f = setup();
  await f.choose();
  const original = f.result.current.draft;
  f.read.mockRejectedValue(new Error("Source unavailable"));
  act(() => f.result.current.loadCurrent());
  await waitFor(() =>
    expect(f.result.current.error).toBe("Source unavailable"),
  );
  expect(f.result.current.draft).toBe(original);
});
it.each(["orgId", "userId", "showId", "source"])(
  "rejects a read for another %s",
  async (field) => {
    const f = setup();
    f.read.mockImplementation(async (scope) => ({
      ...snapshot(scope),
      [field]: field === "source" ? { kind: "show", id: "wrong" } : "wrong",
    }));
    act(() => f.result.current.choose(source));
    await waitFor(() =>
      expect(f.result.current.error).toContain("selection changed"),
    );
    expect(f.result.current.draft.base).toBeNull();
  },
);
it("an eight-second stalled read exposes retry and ignores its late response", async () => {
  vi.useFakeTimers();
  const f = setup();
  let resolve;
  f.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  act(() => f.result.current.choose(source));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(f.result.current.reading).toBe(false);
  expect(f.result.current.error).toBeTruthy();
  expect(f.result.current.draft.base).toBeNull();
  await act(async () => resolve(snapshot({ ...identity, source })));
  expect(f.result.current.draft.base).toBeNull();
});
it("late reads from an old show do not populate the new show", async () => {
  const f = setup();
  let resolve;
  f.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  act(() => f.result.current.choose(source));
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
  f.rerender({ ...identity, showId: "other", active: true });
  await act(async () => resolve(snapshot({ ...identity, source })));
  expect(f.result.current.draft).toBeNull();
  expect(f.send).not.toHaveBeenCalled();
});
it("a stopped-state review is required before sending", async () => {
  const f = setup();
  f.read.mockImplementation(async (scope) => ({
    ...snapshot(scope),
    canReplace: false,
  }));
  await f.choose();
  act(() => f.result.current.submit());
  expect(f.send).not.toHaveBeenCalled();
});
it("failed refresh retries only the read side after a confirmed write", async () => {
  const f = setup();
  f.refresh.mockRejectedValueOnce(new Error("Refresh failed"));
  await f.choose();
  act(() => f.result.current.submit());
  await waitFor(() => expect(f.result.current.attempt.refresh).toBe("failed"));
  expect(f.result.current.discard()).toBe(false);
  act(() => f.result.current.refresh());
  await waitFor(() => expect(f.result.current.attempt.refresh).toBe("done"));
  expect(f.send).toHaveBeenCalledTimes(1);
});
it("save and refresh deadlines retain recovery without a second mutation", async () => {
  const f = setup();
  await f.choose();
  vi.useFakeTimers();
  f.send.mockImplementation(() => new Promise(() => {}));
  act(() => f.result.current.submit());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(f.result.current.attempt.kind).toBe("failed");
  f.send.mockImplementation(async (command) => reply(command));
  f.refresh.mockImplementation(() => new Promise(() => {}));
  act(() => f.result.current.retry());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12001);
  });
  expect(f.result.current.attempt.kind).toBe("confirmed");
  expect(f.result.current.attempt.refresh).toBe("failed");
  expect(f.send).toHaveBeenCalledTimes(2);
});
