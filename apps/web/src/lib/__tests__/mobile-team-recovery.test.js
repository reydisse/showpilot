import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMobileTeam, useTeamDrafts } from "../../test/native-team-hook.js";

const initial = {
  showId: "show",
  showName: "Sunday",
  serviceDate: "2099-01-01",
  timeZone: "UTC",
  department: "Broadcast",
  rows: [
    {
      crewMemberId: "camera",
      name: "Camera crew",
      email: "camera@example.test",
      role: "Camera",
    },
    {
      crewMemberId: "audio",
      name: "Audio crew",
      email: "audio@example.test",
      role: "Audio",
    },
  ],
};
let client, send, refresh;
function reply(command, email = "accepted", outcome = "applied") {
  const fields = command.operation.fields;
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    assignmentId: fields.crewMemberId,
    outcome,
    snapshot: {
      id: fields.crewMemberId,
      revision: "revision",
      showId: fields.showId,
      serviceDate: fields.serviceDate,
      role: fields.role,
      department: fields.department,
      crewMemberId: fields.crewMemberId,
      status: "assigned",
      callTime: "",
      notes: "",
      responseNote: "",
    },
    invitation:
      outcome === "applied"
        ? {
            id: fields.crewMemberId,
            label: fields.role,
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
      useMobileTeam({ orgId: "org", userId }, draft, { active, send, refresh }),
    {
      initialProps: { active: true, userId: "user" },
      wrapper: ({ children }) => jsx(QueryClientProvider, { client, children }),
    },
  );
}
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(async (command) => reply(command));
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
it("preserves the frozen selection after closing and retries only its unresolved row", async () => {
  send
    .mockImplementationOnce(async (command) => reply(command))
    .mockRejectedValueOnce(new Error("Lost reply"));
  const first = setup();
  start(first);
  start(first);
  await settled(first);
  expect(send).toHaveBeenCalledTimes(2);
  const original = send.mock.calls[1][0];
  first.unmount();
  const next = setup({ ...initial, rows: [] });
  expect(next.result.current.draft.rows).toHaveLength(2);
  act(() => next.result.current.setDraft((draft) => ({ ...draft, rows: [] })));
  expect(next.result.current.draft.rows).toHaveLength(2);
  act(() => next.result.current.retry());
  await settled(next);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2][0]).toEqual(original);
  expect(
    next.result.current.attempt.result.rows.every(
      (row) => row.result.outcome === "applied",
    ),
  ).toBe(true);
});
it("keeps successful rows visible while uncertain invitations retry with the same identity", async () => {
  send
    .mockImplementationOnce(async (command) => reply(command))
    .mockImplementationOnce(async (command) => reply(command, "uncertain"));
  const view = setup();
  start(view);
  await settled(view);
  expect(
    view.result.current.attempt.result.rows.map(
      (row) => row.result.invitation.email,
    ),
  ).toEqual(["accepted", "uncertain"]);
  act(() => {
    expect(view.result.current.finish()).toBe(false);
    view.result.current.editUnapplied();
    view.result.current.retry();
  });
  await settled(view);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2][0]).toEqual(send.mock.calls[1][0]);
});
it("review cancels an unconfirmed row before editing only the unapplied positions", async () => {
  send
    .mockImplementationOnce(async (command) => reply(command))
    .mockRejectedValueOnce(new Error("Unconfirmed"));
  const view = setup();
  start(view);
  await settled(view);
  send.mockImplementationOnce(async (command) =>
    reply(command, "accepted", "conflict"),
  );
  act(() => view.result.current.review());
  await settled(view);
  expect(send.mock.calls[2][1]).toBe(true);
  expect(send.mock.calls[2][0]).toEqual(send.mock.calls[1][0]);
  act(() => view.result.current.editUnapplied());
  expect(view.result.current.draft.rows.map((row) => row.crewMemberId)).toEqual(
    ["audio"],
  );
  start(view);
  await settled(view);
  expect(send.mock.calls[3][0].requestId).not.toBe(
    send.mock.calls[1][0].requestId,
  );
  expect(send.mock.calls[3][0].operation.fields.crewMemberId).toBe("audio");
  expect(
    send.mock.calls.filter(
      ([command]) => command.operation.fields.crewMemberId === "camera",
    ),
  ).toHaveLength(1);
});
it("refresh failure retains every result and refreshes without saving or sending again", async () => {
  refresh.mockRejectedValueOnce(new Error("Read failed"));
  const view = setup();
  start(view);
  await waitFor(() =>
    expect(view.result.current.attempt.refresh).toBe("failed"),
  );
  act(() => {
    expect(view.result.current.finish()).toBe(false);
    view.result.current.retry();
  });
  expect(send).toHaveBeenCalledTimes(2);
  act(() => view.result.current.refresh());
  await settled(view);
  expect(send).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("bounds each ignored row transport, preserving successful rows and ignoring late replies", async () => {
  vi.useFakeTimers();
  let late;
  send
    .mockImplementationOnce(async (command) => reply(command))
    .mockImplementationOnce(
      (command) =>
        new Promise((resolve) => {
          late = () => resolve(reply(command, "accepted", "conflict"));
        }),
    );
  const view = setup();
  start(view);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12001);
  });
  expect(view.result.current.attempt.result.rows[0].result.outcome).toBe(
    "applied",
  );
  expect(view.result.current.attempt.result.rows[1].error).toContain(
    "could not be confirmed",
  );
  act(() => view.result.current.retry());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  await act(async () => late());
  expect(view.result.current.attempt.result.rows[1].result.outcome).toBe(
    "applied",
  );
  expect(send).toHaveBeenCalledTimes(3);
});
it.each(["expired", "changed"])(
  "does not automatically resend a %s invitation",
  async (email) => {
    send.mockImplementation(async (command) => reply(command, email));
    const view = setup();
    start(view);
    await settled(view);
    act(() => {
      view.result.current.retry();
      view.result.current.review();
    });
    expect(send).toHaveBeenCalledTimes(2);
  },
);
it("rejects replies for the wrong actor or position without losing the frozen selection", async () => {
  send
    .mockImplementationOnce(async (command) => ({
      ...reply(command),
      userId: "other",
    }))
    .mockImplementationOnce(async (command) => ({
      ...reply(command),
      requestId: crypto.randomUUID(),
    }));
  const view = setup();
  start(view);
  await settled(view);
  expect(
    view.result.current.attempt.result.rows.every(
      (row) => row.result === null && row.error.includes("does not match"),
    ),
  ).toBe(true);
  act(() => view.result.current.retry());
  await settled(view);
  expect(send.mock.calls[2][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[3][0]).toEqual(send.mock.calls[1][0]);
});
it("abandoned focus callbacks cannot send or change the retained team", () => {
  const view = setup(),
    old = view.result.current;
  view.rerender({ active: false, userId: "user" });
  act(() => {
    old.submit();
    old.setDraft((draft) => ({ ...draft, rows: [] }));
  });
  expect(send).not.toHaveBeenCalled();
  expect(view.result.current.draft.rows).toHaveLength(2);
});
it("a cleared account cache is not repopulated by late row replies", async () => {
  const late = [];
  send.mockImplementation(
    (command) =>
      new Promise((resolve) => late.push(() => resolve(reply(command)))),
  );
  const view = setup();
  start(view);
  await act(async () => {});
  view.unmount();
  client.clear();
  await act(async () => late.forEach((done) => done()));
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(refresh).not.toHaveBeenCalled();
});
it("global resume keeps the team independent of dates and hides another account's drafts", () => {
  const view = setup();
  view.unmount();
  const list = renderHook(
    ({ userId }) => useTeamDrafts({ orgId: "org", userId }),
    {
      initialProps: { userId: "user" },
      wrapper: ({ children }) => jsx(QueryClientProvider, { client, children }),
    },
  );
  expect(list.result.current[0].rows).toEqual(initial.rows);
  list.rerender({ userId: "other" });
  expect(list.result.current).toEqual([]);
});
it("finishes only settled results and removes the completed team on close", async () => {
  const view = setup();
  start(view);
  await settled(view);
  act(() => {
    expect(view.result.current.discard()).toBe(false);
    expect(view.result.current.finish()).toBe(true);
    view.unmount();
  });
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});
it("validates the whole team before sending any position", () => {
  const view = setup({
    ...initial,
    rows: [...initial.rows, { ...initial.rows[0], role: "" }],
  });
  start(view);
  expect(send).not.toHaveBeenCalled();
  expect(view.result.current.error).toContain("role");
});
it("updates an already-mounted resume list when a draft is added, edited and removed", () => {
  const list = renderHook(
    () => useTeamDrafts({ orgId: "org", userId: "user" }),
    {
      wrapper: ({ children }) => jsx(QueryClientProvider, { client, children }),
    },
  );
  expect(list.result.current).toEqual([]);
  const view = setup();
  expect(list.result.current[0].department).toBe("Broadcast");
  act(() =>
    view.result.current.setDraft((draft) => ({
      ...draft,
      department: "Changed department",
    })),
  );
  expect(list.result.current[0].department).toBe("Changed department");
  act(() => {
    expect(view.result.current.discard()).toBe(true);
    view.unmount();
  });
  expect(list.result.current).toEqual([]);
});
