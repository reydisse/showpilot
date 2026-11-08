import { jsx } from "react/jsx-runtime";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTemplateSave } from "../../test/native-template-save-hook.js";
import { templateSaveCommandSchema } from "../template-save-contract";
let client, send, refresh;
const copy = {
  serviceName: "Reviewed service",
  scheduledStartTime: "09:30",
  items: [
    {
      id: "one",
      title: "Original item",
      type: "segment",
      duration: 1000,
      notes: "",
      assignee: "",
      cue: "",
      status: "live",
      sortOrder: 0,
      revision: 3,
      hardStop: false,
      actualStart: "2026-01-01T00:00:00Z",
    },
  ],
};
const identity = { orgId: "org", userId: "user", showId: "show", active: true };
const reply = (command, outcome = "applied") => ({
  orgId: command.orgId,
  userId: command.userId,
  showId: command.showId,
  requestId: command.requestId,
  outcome,
});
const wrapper = ({ children }) =>
  jsx(QueryClientProvider, { client, children });
const setup = () =>
  renderHook(
    (scope) =>
      useTemplateSave(scope, copy, { active: scope.active, send, refresh }),
    { wrapper, initialProps: identity },
  );
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(async (command) => reply(command));
  refresh = vi.fn(async () => {});
});
afterEach(() => {
  cleanup();
  client.clear();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});
const ready = (view) =>
  waitFor(() => expect(view.result.current.draft).not.toBeNull());
const settled = (view) =>
  waitFor(() =>
    expect(view.result.current.attempt).toMatchObject({
      kind: "confirmed",
      refresh: "done",
    }),
  );
const start = (view) =>
  act(() => {
    view.result.current.setName("My template");
    view.result.current.submit();
  });
it("retains the reviewed copy across navigation and query expiry", async () => {
  const view = setup();
  await ready(view);
  act(() => view.result.current.setName("Retained"));
  view.unmount();
  vi.useFakeTimers();
  await act(() => vi.advanceTimersByTimeAsync(3600000));
  vi.useRealTimers();
  const next = setup();
  await ready(next);
  expect(next.result.current.draft.name).toBe("Retained");
  expect(next.result.current.draft.copy.items[0]).toMatchObject({
    title: "Original item",
    status: "upcoming",
    actualStart: null,
    actualEnd: null,
  });
});
it("sends a strict command without unrelated scope props and retries identical content", async () => {
  send.mockRejectedValueOnce(new Error("lost"));
  const view = setup();
  await ready(view);
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  const original = send.mock.calls[0][0];
  expect(templateSaveCommandSchema.safeParse(original).success).toBe(true);
  act(() => {
    view.result.current.setName("Different");
    view.result.current.replaceCopy();
    view.result.current.clear();
    view.result.current.retry();
  });
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(original);
  expect(view.result.current.draft.name).toBe("My template");
});
it.each(["applied", "cancelled", "conflict", "removed"])(
  "refreshes only after a confirmed %s response",
  async (outcome) => {
    send.mockImplementation(async (command) => reply(command, outcome));
    refresh.mockRejectedValueOnce(new Error("Refresh failed"));
    const view = setup();
    await ready(view);
    start(view);
    await waitFor(() =>
      expect(view.result.current.attempt).toMatchObject({
        kind: "confirmed",
        refresh: "failed",
      }),
    );
    act(() => view.result.current.retry());
    expect(send).toHaveBeenCalledTimes(1);
    act(() => view.result.current.refresh());
    await settled(view);
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it.each(["orgId", "userId", "showId", "requestId"])(
  "rejects a mismatched %s acknowledgement",
  async (field) => {
    send.mockImplementation(async (command) => ({
      ...reply(command),
      [field]: field === "requestId" ? crypto.randomUUID() : "different",
    }));
    const view = setup();
    await ready(view);
    start(view);
    await waitFor(() =>
      expect(view.result.current.attempt.kind).toBe("failed"),
    );
    expect(refresh).not.toHaveBeenCalled();
  },
);
it("bounds an uncertain save and retains it for review", async () => {
  vi.useFakeTimers();
  send.mockImplementation(() => new Promise(() => {}));
  const view = setup();
  await act(async () => {});
  start(view);
  await act(() => vi.advanceTimersByTimeAsync(15001));
  expect(view.result.current.attempt.kind).toBe("failed");
  expect(view.result.current.draft.name).toBe("My template");
  expect(view.result.current.locked).toBe(true);
});
it("bounds refresh separately from a confirmed save", async () => {
  vi.useFakeTimers();
  refresh.mockImplementation(() => new Promise(() => {}));
  const view = setup();
  await act(async () => {});
  start(view);
  await act(() => vi.advanceTimersByTimeAsync(12001));
  expect(view.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps a late result in its original show without refreshing a newly selected show", async () => {
  let resolve;
  send.mockImplementation(
    (command) =>
      new Promise((done) => {
        resolve = () => done(reply(command));
      }),
  );
  const view = setup();
  await ready(view);
  start(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  view.rerender({ ...identity, showId: "other" });
  await act(async () => resolve());
  expect(view.result.current.attempt).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender(identity);
  await waitFor(() =>
    expect(view.result.current.attempt).toMatchObject({
      kind: "confirmed",
      refresh: "idle",
    }),
  );
  act(() => view.result.current.refresh());
  await settled(view);
});
it("does not pause indefinitely when the device is offline", async () => {
  onlineManager.setOnline(false);
  send.mockRejectedValue(new Error("offline"));
  const view = setup();
  await ready(view);
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  expect(send).toHaveBeenCalledTimes(1);
});
it("rejects malformed source copies visibly without freezing an unreviewable command", async () => {
  const bad = { ...copy, items: [{ ...copy.items[0], type: "unsupported" }] };
  const view = renderHook(
    (source) =>
      useTemplateSave(identity, source, { active: true, send, refresh }),
    { wrapper, initialProps: bad },
  );
  await waitFor(() =>
    expect(view.result.current.error).toContain("invalid details"),
  );
  expect(view.result.current.draft).toBeNull();
  act(() => view.result.current.submit());
  expect(send).not.toHaveBeenCalled();
  view.rerender(copy);
  act(() => view.result.current.capture());
  await ready(view);
  expect(view.result.current.error).toBeUndefined();
  start(view);
  await settled(view);
});
it("preserves the reviewed draft when a newly offered source is invalid", async () => {
  const view = renderHook(
    (source) =>
      useTemplateSave(identity, source, { active: true, send, refresh }),
    { wrapper, initialProps: copy },
  );
  await ready(view);
  act(() => view.result.current.setName("Keep this"));
  const before = view.result.current.draft;
  view.rerender({ ...copy, items: [copy.items[0], copy.items[0]] });
  act(() => view.result.current.replaceCopy());
  expect(view.result.current.error).toContain("invalid details");
  expect(view.result.current.draft).toEqual(before);
  start(view);
  await settled(view);
});
it("surfaces invalid submission fields without sending or losing the draft", async () => {
  const view = setup();
  await ready(view);
  act(() => view.result.current.setName(" "));
  act(() => view.result.current.submit());
  expect(view.result.current.error).toContain("Check the template name");
  expect(send).not.toHaveBeenCalled();
  expect(view.result.current.attempt).toBeUndefined();
});
it("rejects an oversized UTF-8 command before freezing it, preserving the draft for replacement", async () => {
  const large = {
    ...copy,
    items: Array.from({ length: 100 }, (_, index) => ({
      ...copy.items[0],
      id: `item-${index}`,
      notes: "🎵".repeat(9999),
    })),
  };
  const view = renderHook(
    () => useTemplateSave(identity, large, { active: true, send, refresh }),
    { wrapper },
  );
  await ready(view);
  start(view);
  expect(view.result.current.error).toContain("too large to send");
  expect(view.result.current.attempt).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(view.result.current.draft.name).toBe("My template");
});
