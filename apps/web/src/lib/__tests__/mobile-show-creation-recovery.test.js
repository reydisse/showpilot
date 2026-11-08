import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useShowCreation,
  useShowCreationDrafts,
} from "../../test/native-show-creation-hook.js";

const initial = {
  serviceDate: "2099-01-01",
  timeZone: "America/Toronto",
  name: "Morning",
  location: "Main",
  startTime: "09:30",
  callTime: "08:00",
  source: {
    kind: "show",
    id: "source",
    name: "Previous show",
    serviceDate: "2098-12-25",
  },
};
let client, send, refresh;
function reply(command, kind = "created") {
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    result:
      kind === "created"
        ? {
            kind,
            result: {
              ok: true,
              showId: command.requestId,
              serviceDate: command.serviceDate,
            },
          }
        : { kind },
  };
}
const wrapper = ({ children }) =>
  jsx(QueryClientProvider, { client, children });
function setup() {
  return renderHook(
    ({ active, userId, orgId }) =>
      useShowCreation({ orgId, userId }, initial, { active, send, refresh }),
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

it("retains fields and source across navigation and retries only the original creation", async () => {
  send.mockRejectedValueOnce(new Error("Reply lost"));
  const first = setup();
  act(() =>
    first.result.current.setDraft((draft) => ({
      ...draft,
      name: "Evening",
      startTime: "19:00",
    })),
  );
  start(first);
  start(first);
  await waitFor(() => expect(first.result.current.attempt.kind).toBe("failed"));
  first.unmount();
  const next = setup();
  expect(next.result.current.draft).toMatchObject({
    name: "Evening",
    startTime: "19:00",
    source: initial.source,
  });
  act(() =>
    next.result.current.setDraft((draft) => ({
      ...draft,
      source: { kind: "blank" },
    })),
  );
  start(next);
  expect(send).toHaveBeenCalledTimes(1);
  act(() => next.result.current.retry());
  await settled(next);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[0][0]).toMatchObject({
    copyFromShowId: "source",
    copyFrom: "2098-12-25",
    timeZone: "America/Toronto",
    name: "Evening",
  });
  act(() => next.result.current.retry());
  start(next);
  expect(send).toHaveBeenCalledTimes(2);
});
it("a stuck transport exits pending at 15 seconds even when it ignores abort", async () => {
  vi.useFakeTimers();
  send.mockImplementation(() => new Promise(() => {}));
  const view = setup();
  start(view);
  await act(() => vi.advanceTimersByTimeAsync(15001));
  expect(view.result.current.attempt.kind).toBe("failed");
  expect(send.mock.calls[0][2].aborted).toBe(true);
  expect(view.result.current.discard()).toBe(false);
  expect(view.result.current.finish()).toBe(false);
});
it("keeps a successful creation when refresh fails and never sends again for Refresh only", async () => {
  refresh.mockRejectedValueOnce(new Error("Read failed"));
  const view = setup();
  start(view);
  await waitFor(() =>
    expect(view.result.current.attempt.refresh).toBe("failed"),
  );
  expect(view.result.current.attempt.result.result.kind).toBe("created");
  expect(view.result.current.finish()).toBe(false);
  act(() => view.result.current.refresh());
  await settled(view);
  expect(send).toHaveBeenCalledTimes(1);
  let finished;
  act(() => {
    finished = view.result.current.finish();
    view.unmount();
  });
  expect(finished).toBe(true);
  expect(
    client.getQueryData(["mobile-show-creation-request", "user", "org"]),
  ).toBeUndefined();
});
it("bounds refresh at 12 seconds without losing the confirmed result", async () => {
  vi.useFakeTimers();
  refresh.mockImplementation(() => new Promise(() => {}));
  const view = setup();
  start(view);
  await act(() => vi.advanceTimersByTimeAsync(12001));
  expect(view.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
    result: { result: { kind: "created" } },
  });
});
it("review before editing cancels the unapplied request and assigns a fresh request only on resubmission", async () => {
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
      name: "Changed safely",
    })),
  );
  start(view);
  await settled(view);
  expect(send.mock.calls[2][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
  expect(send.mock.calls[2][0].name).toBe("Changed safely");
});
it.each(["created", "removed"])(
  "reviewed %s creation cannot be edited or recreated",
  async (kind) => {
    send.mockRejectedValueOnce(new Error("Lost reply"));
    const view = setup();
    start(view);
    await waitFor(() =>
      expect(view.result.current.attempt.kind).toBe("failed"),
    );
    send.mockImplementationOnce(async (command) => reply(command, kind));
    act(() => view.result.current.reviewOriginal());
    await settled(view);
    act(() => view.result.current.editUnapplied());
    start(view);
    act(() => view.result.current.retry());
    expect(view.result.current.locked).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  },
);
it("keeps an in-flight result after close without refreshing an inactive screen", async () => {
  let resolve;
  send.mockImplementationOnce(
    (command) =>
      new Promise((done) => {
        resolve = () => done(reply(command));
      }),
  );
  const view = setup();
  start(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => resolve());
  expect(refresh).not.toHaveBeenCalled();
  const next = setup();
  expect(next.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
  act(() => next.result.current.refresh());
  await settled(next);
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["userId", "orgId"])(
  "isolates drafts and late replies when %s changes",
  async (key) => {
    let resolve;
    send.mockImplementationOnce(
      (command) =>
        new Promise((done) => {
          resolve = () => done(reply(command));
        }),
    );
    const view = setup();
    start(view);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const staleSubmit = view.result.current.submit;
    view.rerender({
      active: true,
      userId: "user",
      orgId: "org",
      [key]: "other",
    });
    act(() => staleSubmit());
    await act(async () => resolve());
    expect(view.result.current.attempt).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it("does not accept a reply for another show or date", async () => {
  send.mockImplementationOnce(async (command) => ({
    ...reply(command),
    result: {
      kind: "created",
      result: {
        ok: true,
        showId: "different",
        serviceDate: command.serviceDate,
      },
    },
  }));
  const view = setup();
  start(view);
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  expect(refresh).not.toHaveBeenCalled();
});
it("global resume subscribers follow edits and respect account scope", () => {
  const list = renderHook(
    () => useShowCreationDrafts({ userId: "user", orgId: "org" }),
    { wrapper },
  );
  const other = renderHook(
    () => useShowCreationDrafts({ userId: "other", orgId: "org" }),
    { wrapper },
  );
  const view = setup();
  act(() =>
    view.result.current.setDraft((draft) => ({
      ...draft,
      name: "Retained title",
    })),
  );
  expect(list.result.current[0].name).toBe("Retained title");
  expect(other.result.current).toEqual([]);
  act(() => {
    view.result.current.discard();
    view.unmount();
  });
  expect(list.result.current).toEqual([]);
});
it("refuses invalid dates and times without sending and disables stale inactive callbacks", () => {
  const view = setup();
  act(() =>
    view.result.current.setDraft((draft) => ({
      ...draft,
      serviceDate: "2099-02-30",
      callTime: "25:00",
    })),
  );
  start(view);
  expect(send).not.toHaveBeenCalled();
  const update = view.result.current.setDraft;
  view.rerender({ active: false, userId: "user", orgId: "org" });
  act(() => update(() => initial));
  start(view);
  expect(view.result.current.draft.serviceDate).toBe("2099-02-30");
  expect(send).not.toHaveBeenCalled();
});
