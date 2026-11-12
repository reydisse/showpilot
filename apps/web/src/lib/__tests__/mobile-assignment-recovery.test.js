import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMobileAssignment,
  useAssignmentDrafts,
} from "../../test/native-assignment-hook.js";

const fields = {
  showId: "show",
  serviceDate: "2099-01-01",
  role: "Audio",
  department: "Production",
  crewMemberId: null,
  callTime: "",
  timeZone: "UTC",
  notes: "Original note",
};
const initial = {
  editorId: "create:show",
  mode: "create",
  showName: "Sunday",
  fields,
  base: null,
};
const snapshot = {
  id: "position",
  revision: "revision-1",
  showId: "show",
  serviceDate: "2099-01-01",
  role: "Audio",
  department: "Production",
  crewMemberId: null,
  status: "assigned",
  callTime: "",
  notes: "Original note",
  responseNote: "",
};
const edit = {
  ...initial,
  editorId: "edit:position",
  mode: "edit",
  base: snapshot,
};
let client, send, read, refresh;
function reply(command, outcome = "applied", email = null) {
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    assignmentId: "position",
    outcome,
    snapshot: command.operation.kind === "delete" ? null : snapshot,
    invitation: email
      ? {
          id: "position",
          label: "Audio",
          email,
          inAppDelivered: true,
          reason: null,
          updatedAt: 1,
        }
      : null,
  };
}
function setup(draft = initial) {
  return renderHook(
    ({ active, userId }) =>
      useMobileAssignment({ orgId: "org", userId }, draft, {
        active,
        send,
        read,
        refresh,
      }),
    {
      initialProps: { active: true, userId: "user" },
      wrapper: ({ children }) => jsx(QueryClientProvider, { client, children }),
    },
  );
}
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(async (command) => reply(command));
  read = vi.fn(async () => ({
    orgId: "org",
    userId: "user",
    timeZone: "UTC",
    snapshot,
  }));
  refresh = vi.fn(async () => {});
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
it("retains the draft and exact request after closing, with no duplicate submission", async () => {
  send.mockRejectedValueOnce(new Error("Lost reply"));
  const first = setup();
  act(() =>
    first.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, role: "Camera" },
    })),
  );
  start(first);
  start(first);
  await waitFor(() => expect(first.result.current.attempt.kind).toBe("failed"));
  first.unmount();
  const next = setup();
  expect(next.result.current.draft.fields.role).toBe("Camera");
  act(() =>
    next.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, role: "Changed" },
    })),
  );
  start(next);
  expect(send).toHaveBeenCalledTimes(1);
  act(() => next.result.current.retry());
  await settled(next);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[1][0].operation.fields.role).toBe("Camera");
});
it("review cancels the same unconfirmed request before the original draft can be edited", async () => {
  send
    .mockRejectedValueOnce(new Error("Lost reply"))
    .mockImplementationOnce(async (command) => reply(command, "conflict"));
  const view = setup();
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  act(() => view.result.current.editUnapplied());
  expect(view.result.current.locked).toBe(true);
  act(() => view.result.current.reviewOriginal());
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[1][1]).toBe(true);
  act(() => view.result.current.editUnapplied());
  expect(view.result.current.locked).toBe(false);
  start(view);
  await settled(view);
  expect(send.mock.calls[2][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
});
it("refresh failure keeps the successful receipt and refreshes without saving again", async () => {
  refresh.mockRejectedValueOnce(new Error("Read unavailable"));
  const view = setup();
  start(view);
  await waitFor(() =>
    expect(view.result.current.attempt.refresh).toBe("failed"),
  );
  act(() => {
    expect(view.result.current.finish()).toBe(false);
    view.result.current.retry();
  });
  expect(send).toHaveBeenCalledTimes(1);
  act(() => view.result.current.refresh());
  await settled(view);
  expect(send).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("uncertain invitation recovery retains the same command and cannot finish early", async () => {
  send.mockImplementationOnce(async (command) =>
    reply(command, "applied", "uncertain"),
  );
  const view = setup();
  start(view);
  await settled(view);
  act(() => {
    expect(view.result.current.finish()).toBe(false);
    view.result.current.loadCurrent();
  });
  expect(read).not.toHaveBeenCalled();
  act(() => view.result.current.retry());
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
});
it("loads current conflict details only explicitly, retaining original fields on read failure", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "conflict"));
  read
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValueOnce({
      orgId: "org",
      userId: "user",
      timeZone: "America/Toronto",
      snapshot: {
        ...snapshot,
        revision: "revision-2",
        notes: "Other manager",
        callTime: "2099-01-01T14:30:00Z",
      },
    });
  const view = setup(edit);
  start(view);
  await settled(view);
  expect(view.result.current.draft.fields.notes).toBe("Original note");
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.error).toBe("Read failed"));
  expect(view.result.current.draft.fields.notes).toBe("Original note");
  act(() => view.result.current.loadCurrent());
  await waitFor(() =>
    expect(view.result.current.draft.base.revision).toBe("revision-2"),
  );
  expect(view.result.current.draft.fields).toMatchObject({
    notes: "Other manager",
    callTime: "09:30",
    timeZone: "America/Toronto",
  });
  start(view);
  await settled(view);
  expect(send.mock.calls[1][0].operation.expectedRevision).toBe("revision-2");
});
it("does not recreate a removed assignment when loading current details", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "superseded"));
  read.mockResolvedValueOnce({
    orgId: "org",
    userId: "user",
    timeZone: "UTC",
    snapshot: null,
  });
  const view = setup(edit);
  start(view);
  await settled(view);
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.error).toContain("removed"));
  expect(view.result.current.draft).toEqual(edit);
  expect(view.result.current.locked).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
});
it("bounds ignored transports and ignores late replies after retry", async () => {
  vi.useFakeTimers();
  let late;
  send.mockImplementationOnce(
    (command) =>
      new Promise((resolve) => {
        late = () => resolve(reply(command, "conflict"));
      }),
  );
  const view = setup();
  start(view);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15001);
  });
  expect(view.result.current.attempt.kind).toBe("failed");
  act(() => view.result.current.retry());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(view.result.current.attempt.result.outcome).toBe("applied");
  await act(async () => late());
  expect(view.result.current.attempt.result.outcome).toBe("applied");
});
it("blur cancels current-detail reads and stale callbacks cannot submit", async () => {
  let resolve;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = setup(edit),
    old = view.result.current;
  act(() => old.loadCurrent());
  await act(async () => {});
  view.rerender({ active: false, userId: "user" });
  act(() => old.submit());
  await act(async () =>
    resolve({
      orgId: "org",
      userId: "user",
      timeZone: "UTC",
      snapshot: { ...snapshot, notes: "Late" },
    }),
  );
  view.rerender({ active: true, userId: "user" });
  expect(view.result.current.reading).toBe(false);
  expect(view.result.current.draft.fields.notes).toBe("Original note");
  expect(send).not.toHaveBeenCalled();
});
it("a cleared account cache is not repopulated by a late save", async () => {
  let late;
  send.mockImplementationOnce(
    (command) =>
      new Promise((resolve) => {
        late = () => resolve(reply(command));
      }),
  );
  const view = setup();
  start(view);
  await act(async () => {});
  view.unmount();
  client.clear();
  await act(async () => late());
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(refresh).not.toHaveBeenCalled();
});
it("unfinished work remains discoverable independently of the selected date and belongs to its account", () => {
  const editor = setup();
  act(() =>
    editor.result.current.setDraft((draft) => ({
      ...draft,
      fields: { ...draft.fields, role: "Retained" },
    })),
  );
  editor.unmount();
  const list = renderHook(
    ({ userId }) => useAssignmentDrafts({ orgId: "org", userId }),
    {
      initialProps: { userId: "user" },
      wrapper: ({ children }) => jsx(QueryClientProvider, { client, children }),
    },
  );
  expect(list.result.current[0].fields.role).toBe("Retained");
  list.rerender({ userId: "other" });
  expect(list.result.current).toEqual([]);
});
it("an explicit finish followed by closing removes only the settled editor", async () => {
  const view = setup();
  start(view);
  await settled(view);
  act(() => {
    expect(view.result.current.finish()).toBe(true);
    view.unmount();
  });
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  const next = setup();
  expect(next.result.current.attempt).toBeUndefined();
});
