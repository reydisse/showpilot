import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useShowManagement,
  useShowManagementDrafts,
} from "../../test/native-show-management-hook.js";
import { showDraftFromSnapshot } from "../../../../mobile/src/lib/show-management-recovery.ts";
const snapshot = {
  id: "show",
  serviceDate: "2099-01-01",
  name: "Original",
  location: "Main",
  updatedAt: "2026-01-01T00:00:00Z",
  scheduledStartTime: "2099-01-01T15:00:00Z",
  scheduledCallTime: null,
};
const initial = showDraftFromSnapshot("edit", snapshot, "America/Toronto");
let client, send, read, refresh;
function reply(command, outcome = "applied") {
  const identity = {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    showId: command.showId,
    kind: command.kind,
  };
  return {
    ...identity,
    result:
      command.kind === "delete"
        ? { ok: true }
        : {
            requestId: command.requestId,
            showId: command.showId,
            outcome,
            snapshot,
          },
  };
}
const wrapper = ({ children }) =>
  jsx(QueryClientProvider, { client, children });
function setup(draft = initial) {
  return renderHook(
    ({ active, userId, orgId }) =>
      useShowManagement({ orgId, userId }, draft, {
        active,
        send,
        read,
        refresh,
      }),
    {
      initialProps: { active: true, userId: "user", orgId: "org" },
      wrapper,
    },
  );
}
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(async (command) => reply(command));
  refresh = vi.fn(async () => {});
  read = vi.fn(async () => ({
    orgId: "org",
    userId: "user",
    showId: "show",
    timeZone: "America/Toronto",
    snapshot,
  }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
const start = (view) => act(() => view.result.current.submit());
const settled = (view) =>
  waitFor(() =>
    expect(view.result.current.attempt).toMatchObject({
      kind: "confirmed",
      refresh: "done",
    }),
  );
it("retains edit fields and frozen version after close and retries the exact command", async () => {
  send.mockRejectedValueOnce(new Error("Reply lost"));
  const view = setup();
  act(() =>
    view.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, name: "Edited title" },
    })),
  );
  start(view);
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  view.unmount();
  const next = setup();
  expect(next.result.current.draft.fields.name).toBe("Edited title");
  act(() =>
    next.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, name: "Unsafe replacement" },
    })),
  );
  start(next);
  expect(send).toHaveBeenCalledTimes(1);
  act(() => next.result.current.retry());
  await settled(next);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[0][0]).toMatchObject({
    name: "Edited title",
    expectedUpdatedAt: snapshot.updatedAt,
    timeZone: "America/Toronto",
  });
});
it("shares the show slot so an unresolved delete cannot become an edit", async () => {
  send.mockRejectedValueOnce(new Error("Cleanup unconfirmed"));
  const view = setup({ ...initial, mode: "delete" });
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  view.unmount();
  const next = setup();
  expect(next.result.current.draft.mode).toBe("delete");
  act(() => next.result.current.reviewOriginal());
  start(next);
  expect(send).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  act(() => next.result.current.loadCurrent());
  expect(read).not.toHaveBeenCalled();
  expect(next.result.current.discard()).toBe(false);
  expect(next.result.current.finish()).toBe(false);
  act(() => next.result.current.retry());
  await settled(next);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
});
it("a different action does not overwrite an existing unsent draft", () => {
  const view = setup();
  act(() =>
    view.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, name: "Keep this" },
    })),
  );
  view.unmount();
  const next = setup({ ...initial, mode: "delete" });
  expect(next.result.current.draft).toMatchObject({
    mode: "edit",
    fields: { name: "Keep this" },
  });
});
it.each(["edit", "delete"])(
  "bounds a stuck %s request and keeps recovery available",
  async (mode) => {
    vi.useFakeTimers();
    send.mockImplementation(() => new Promise(() => {}));
    const view = setup({ ...initial, mode });
    start(view);
    await act(() => vi.advanceTimersByTimeAsync(15001));
    expect(view.result.current.attempt.kind).toBe("failed");
    expect(send.mock.calls[0][2].aborted).toBe(true);
    expect(view.result.current.finish()).toBe(false);
  },
);
it.each(["edit", "delete"])(
  "preserves a confirmed %s through refresh failure without resending",
  async (mode) => {
    refresh.mockRejectedValueOnce(new Error("Read failed"));
    const view = setup({ ...initial, mode });
    start(view);
    await waitFor(() =>
      expect(view.result.current.attempt.refresh).toBe("failed"),
    );
    expect(view.result.current.finish()).toBe(false);
    act(() => view.result.current.retry());
    expect(send).toHaveBeenCalledTimes(1);
    act(() => view.result.current.refresh());
    await settled(view);
    expect(send).toHaveBeenCalledTimes(1);
    act(() => {
      expect(view.result.current.finish()).toBe(true);
      view.unmount();
    });
    expect(
      client.getQueryData([
        "mobile-show-management-draft",
        "user",
        "org",
        "show",
      ]),
    ).toBeUndefined();
  },
);
it("review cancels an unapplied edit before allowing a new request", async () => {
  send.mockRejectedValueOnce(new Error("Unconfirmed"));
  const view = setup();
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  act(() => view.result.current.editUnapplied());
  expect(view.result.current.locked).toBe(true);
  send.mockImplementationOnce(async (command) => reply(command, "cancelled"));
  act(() => view.result.current.reviewOriginal());
  await settled(view);
  expect(send.mock.calls[1][1]).toBe(true);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  act(() => view.result.current.editUnapplied());
  act(() =>
    view.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, location: "Chapel" },
    })),
  );
  start(view);
  await settled(view);
  expect(send.mock.calls[2][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
  expect(send.mock.calls[2][0]).toMatchObject({
    location: "Chapel",
    expectedUpdatedAt: snapshot.updatedAt,
  });
});
it("conflict keeps the draft until an explicit current read adopts the new version and venue times", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "conflict"));
  const view = setup();
  act(() =>
    view.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, name: "Unapplied" },
    })),
  );
  start(view);
  await settled(view);
  expect(read).not.toHaveBeenCalled();
  expect(view.result.current.draft.fields.name).toBe("Unapplied");
  const current = {
    ...snapshot,
    name: "Another operator",
    updatedAt: "2026-02-01T00:00:00Z",
    scheduledStartTime: "2099-01-01T22:00:00Z",
  };
  read.mockResolvedValueOnce({
    orgId: "org",
    userId: "user",
    showId: "show",
    timeZone: "America/Toronto",
    snapshot: current,
  });
  act(() => view.result.current.loadCurrent());
  await waitFor(() =>
    expect(view.result.current.draft.base.updatedAt).toBe(current.updatedAt),
  );
  expect(view.result.current.draft.fields).toMatchObject({
    name: "Another operator",
    startTime: "17:00",
  });
  start(view);
  await settled(view);
  expect(send.mock.calls[1][0].expectedUpdatedAt).toBe(current.updatedAt);
});
it("a rejected deletion requires loading a current version before another delete", async () => {
  send.mockImplementationOnce(async (command) => ({
    ...reply(command),
    result: { ok: false, message: "Show changed" },
  }));
  const view = setup({ ...initial, mode: "delete" });
  start(view);
  await settled(view);
  act(() => view.result.current.retry());
  start(view);
  expect(send).toHaveBeenCalledTimes(1);
  const current = { ...snapshot, updatedAt: "2026-02-01T00:00:00Z" };
  read.mockResolvedValueOnce({
    orgId: "org",
    userId: "user",
    showId: "show",
    timeZone: "UTC",
    snapshot: current,
  });
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.attempt).toBeUndefined());
  start(view);
  await settled(view);
  expect(send.mock.calls[1][0]).toMatchObject({
    kind: "delete",
    expectedUpdatedAt: current.updatedAt,
  });
  expect(send.mock.calls[1][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
});
it("bounds current reads and preserves fields when they time out or the show is missing", async () => {
  vi.useFakeTimers();
  read.mockImplementationOnce(() => new Promise(() => {}));
  const view = setup();
  act(() => view.result.current.loadCurrent());
  expect(view.result.current.discard()).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(8001));
  expect(view.result.current.reading).toBe(false);
  expect(view.result.current.draft).toEqual(initial);
  vi.useRealTimers();
  read.mockResolvedValueOnce({
    orgId: "org",
    userId: "user",
    showId: "show",
    timeZone: "UTC",
    snapshot: null,
  });
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.error).toMatch(/removed/));
  expect(view.result.current.draft).toEqual(initial);
});
it("ignores a late current read after focus changes", async () => {
  let resolve;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = setup();
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender({ active: false, userId: "user", orgId: "org" });
  await act(async () =>
    resolve({
      orgId: "org",
      userId: "user",
      showId: "show",
      timeZone: "UTC",
      snapshot: { ...snapshot, name: "Late" },
    }),
  );
  expect(view.result.current.draft.fields.name).toBe("Original");
});
it("does not accept a mismatched show reply", async () => {
  send.mockImplementationOnce(async (command) => ({
    ...reply(command),
    showId: "other-show",
  }));
  const view = setup();
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  expect(refresh).not.toHaveBeenCalled();
});
it("isolates account changes and exposes retained drafts only to their original scope", async () => {
  let resolve;
  send.mockImplementationOnce(
    (command) =>
      new Promise((done) => {
        resolve = () => done(reply(command));
      }),
  );
  const list = renderHook(
    () => useShowManagementDrafts({ orgId: "org", userId: "user" }),
    { wrapper },
  );
  const other = renderHook(
    () => useShowManagementDrafts({ orgId: "org", userId: "other" }),
    { wrapper },
  );
  const view = setup();
  start(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(list.result.current).toHaveLength(1);
  expect(other.result.current).toHaveLength(0);
  view.rerender({ active: true, userId: "other", orgId: "org" });
  await act(async () => resolve());
  expect(view.result.current.attempt).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
});
