import { jsx } from "react/jsx-runtime";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useRundownDetails,
  useRundownDetailsDraft,
} from "../../test/native-rundown-details-hook.js";
import { rundownDetailsCommandSchema } from "../rundown-details-contract";
const snapshot = {
  id: "show",
  serviceDate: "2099-01-01",
  name: "Morning",
  location: "Main",
  updatedAt: "2026-01-01T00:00:00Z",
  scheduledStartTime: "2099-01-01T09:00:00Z",
  scheduledCallTime: null,
};
const initial = {
  orgId: "org",
  userId: "user",
  showId: "show",
  revision: 4,
  timeZone: "UTC",
  snapshot,
};
let client, read, send, refresh;
const wrapper = ({ children }) =>
  jsx(QueryClientProvider, { client, children });
const reply = (command, outcome = "applied") => ({
  orgId: command.orgId,
  userId: command.userId,
  showId: command.showId,
  requestId: command.requestId,
  outcome,
  snapshot: { ...snapshot, id: command.showId },
});
function setup() {
  return renderHook(
    (scope) =>
      useRundownDetails(scope, { active: scope.active, read, send, refresh }),
    {
      wrapper,
      initialProps: {
        active: true,
        orgId: "org",
        userId: "user",
        showId: "show",
      },
    },
  );
}
beforeEach(() => {
  client = new QueryClient();
  read = vi.fn(async (scope) => ({
    ...initial,
    ...scope,
    snapshot: { ...snapshot, id: scope.showId },
  }));
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
const failed = (view) =>
  waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
const start = (view) => act(() => view.result.current.submit());
it("retains fields, timezone and both reviewed versions across navigation and cache expiry", async () => {
  const view = setup();
  await ready(view);
  act(() => view.result.current.setFields({ name: "My draft" }));
  view.unmount();
  vi.useFakeTimers();
  await act(() => vi.advanceTimersByTimeAsync(3600000));
  vi.useRealTimers();
  const next = setup();
  await ready(next);
  expect(next.result.current.draft.fields.name).toBe("My draft");
  expect(read).toHaveBeenCalledTimes(1);
  const summary = renderHook(
    () =>
      useRundownDetailsDraft({ orgId: "org", userId: "user", showId: "show" }),
    { wrapper },
  );
  expect(summary.result.current.base).toMatchObject({
    revision: 4,
    snapshot: { updatedAt: snapshot.updatedAt },
  });
});
it("freezes the full command and retries it exactly after an uncertain reply", async () => {
  send.mockRejectedValueOnce(new Error("Reply lost"));
  const view = setup();
  await ready(view);
  act(() => view.result.current.setFields({ name: "Reviewed" }));
  start(view);
  start(view);
  await failed(view);
  act(() => {
    view.result.current.setFields({ name: "Unsafe" });
    view.result.current.loadCurrent();
  });
  expect(view.result.current.discard()).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  act(() => view.result.current.retry());
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(
    rundownDetailsCommandSchema.parse(send.mock.calls[0][0]),
  ).toMatchObject({
    name: "Reviewed",
    expectedRevision: 4,
    expectedUpdatedAt: snapshot.updatedAt,
  });
  expect(send.mock.calls[0][0]).not.toHaveProperty("active");
});
it("Review cancels the original request before editing with a new ID", async () => {
  send.mockRejectedValueOnce(new Error("Reply lost"));
  const view = setup();
  await ready(view);
  start(view);
  await failed(view);
  send.mockImplementationOnce(async (command) => reply(command, "cancelled"));
  act(() => view.result.current.review());
  await settled(view);
  expect(send.mock.calls[1][1]).toBe(true);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  act(() => view.result.current.editCancelled());
  act(() => view.result.current.setFields({ name: "Reviewed again" }));
  start(view);
  await settled(view);
  expect(send.mock.calls[2][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
});
it.each(["applied", "superseded", "conflict", "cancelled", "removed"])(
  "retains %s through refresh failure and refreshes without another write",
  async (outcome) => {
    send.mockImplementationOnce(async (command) => reply(command, outcome));
    refresh.mockRejectedValueOnce(new Error("Read failed"));
    const view = setup();
    await ready(view);
    start(view);
    await waitFor(() =>
      expect(view.result.current.attempt.refresh).toBe("failed"),
    );
    expect(view.result.current.discard()).toBe(false);
    act(() => view.result.current.retry());
    expect(send).toHaveBeenCalledTimes(1);
    act(() => view.result.current.refresh());
    await settled(view);
    expect(send).toHaveBeenCalledTimes(1);
    expect(view.result.current.attempt.result.outcome).toBe(outcome);
  },
);
it("a conflict requires explicit current details and a fresh revision before another save", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "conflict"));
  const view = setup();
  await ready(view);
  act(() => view.result.current.setFields({ name: "Keep this" }));
  start(view);
  await settled(view);
  act(() => view.result.current.editCancelled());
  start(view);
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.result.current.draft.fields.name).toBe("Keep this");
  read.mockResolvedValueOnce({
    ...initial,
    revision: 9,
    timeZone: "America/Toronto",
    snapshot: {
      ...snapshot,
      name: "Current",
      updatedAt: "2026-02-01T00:00:00Z",
    },
  });
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.draft.base.revision).toBe(9));
  expect(view.result.current.draft.fields).toMatchObject({
    name: "Current",
    startTime: "04:00",
    timeZone: "America/Toronto",
  });
  start(view);
  await settled(view);
  expect(send.mock.calls[1][0]).toMatchObject({
    expectedRevision: 9,
    expectedUpdatedAt: "2026-02-01T00:00:00Z",
  });
});
it("keeps both draft and confirmed result when a current read finds a removed show", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "conflict"));
  const view = setup();
  await ready(view);
  start(view);
  await settled(view);
  read.mockResolvedValueOnce({ ...initial, snapshot: null });
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.error).toMatch(/no longer/));
  expect(view.result.current.attempt.result.outcome).toBe("conflict");
  expect(view.result.current.draft.fields.name).toBe("Morning");
});
it.each(["read", "save", "review", "refresh"])(
  "bounds a stalled %s and retains recovery",
  async (kind) => {
    const view = setup();
    await ready(view);
    vi.useFakeTimers();
    if (kind === "read") {
      read.mockImplementationOnce(() => new Promise(() => {}));
      act(() => view.result.current.loadCurrent());
    } else if (kind === "review") {
      send.mockRejectedValueOnce(new Error("Lost"));
      start(view);
      await act(() => vi.advanceTimersByTimeAsync(1));
      send.mockImplementationOnce(() => new Promise(() => {}));
      act(() => view.result.current.review());
    } else {
      (kind === "save" ? send : refresh).mockImplementationOnce(
        () => new Promise(() => {}),
      );
      start(view);
    }
    await act(() =>
      vi.advanceTimersByTimeAsync(
        kind === "read" ? 8001 : kind === "refresh" ? 12001 : 15001,
      ),
    );
    if (kind === "read") {
      expect(view.result.current.reading).toBe(false);
      expect(view.result.current.error).toBeTruthy();
    } else if (kind === "refresh")
      expect(view.result.current.attempt).toMatchObject({
        kind: "confirmed",
        refresh: "failed",
      });
    else expect(view.result.current.attempt.kind).toBe("failed");
    expect(view.result.current.draft.fields.name).toBe("Morning");
  },
);
it("does not pause offline saves indefinitely", async () => {
  const view = setup();
  await ready(view);
  onlineManager.setOnline(false);
  send.mockRejectedValueOnce(new Error("Offline"));
  start(view);
  await failed(view);
  expect(view.result.current.attempt.message).toBe("Offline");
});
it.each(["orgId", "userId", "showId", "requestId", "snapshot"])(
  "rejects a save reply with another %s",
  async (field) => {
    send.mockImplementationOnce(async (command) => ({
      ...reply(command),
      [field]:
        field === "requestId"
          ? crypto.randomUUID()
          : field === "snapshot"
            ? { ...snapshot, id: "other" }
            : "other",
    }));
    const view = setup();
    await ready(view);
    start(view);
    await failed(view);
    expect(refresh).not.toHaveBeenCalled();
  },
);
it("isolates account and show changes and ignores late reads from a previous selection", async () => {
  let resolve;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = setup();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender({
    active: true,
    orgId: "org",
    userId: "other",
    showId: "second",
  });
  await ready(view);
  await act(async () => resolve(initial));
  expect(view.result.current.draft.base).toMatchObject({
    userId: "other",
    showId: "second",
  });
});
it("records a late save in its original scope without refreshing a different show", async () => {
  let resolve;
  send.mockImplementationOnce(
    (command) =>
      new Promise((done) => {
        resolve = () => done(reply(command));
      }),
  );
  const view = setup();
  await ready(view);
  start(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  view.rerender({
    active: true,
    orgId: "org",
    userId: "user",
    showId: "second",
  });
  await ready(view);
  await act(async () => resolve());
  expect(view.result.current.attempt).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender({ active: true, orgId: "org", userId: "user", showId: "show" });
  expect(view.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
  act(() => view.result.current.refresh());
  await settled(view);
});
