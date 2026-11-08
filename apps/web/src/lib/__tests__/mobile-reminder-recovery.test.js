import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMobileReminders } from "../../test/native-reminder-hook.js";

let client, send, refresh;
const target = { kind: "show", id: "show" },
  slot = "show:show";
function reply(command, email = "accepted") {
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    items: [
      {
        id: "assignment",
        label: "Camera · Crew",
        email,
        inAppDelivered: true,
        reason: null,
        updatedAt: 1,
      },
    ],
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  return renderHook(
    ({ userId, orgId, enabled }) =>
      useMobileReminders({ userId, orgId }, { enabled, send, refresh }),
    {
      initialProps: { userId: "user", orgId: "org", enabled: true },
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
  client.clear();
  vi.useRealTimers();
});
const start = (view) => act(() => view.result.current.start(target, "Sunday"));
const settled = (view) =>
  waitFor(() =>
    expect(view.result.current.work[slot]).toMatchObject({
      kind: "confirmed",
      refresh: "done",
    }),
  );

it("claims repeated clicks and retains the exact command across closing and retry", async () => {
  send.mockRejectedValueOnce(new Error("Lost response"));
  const first = setup();
  act(() => {
    first.result.current.start(target, "Sunday");
    first.result.current.start(target, "Sunday");
  });
  await waitFor(() =>
    expect(first.result.current.work[slot]?.kind).toBe("failed"),
  );
  expect(send).toHaveBeenCalledTimes(1);
  const original = send.mock.calls[0][0];
  first.unmount();
  const next = setup();
  start(next);
  expect(send).toHaveBeenCalledTimes(1);
  act(() => next.result.current.retry(slot));
  await settled(next);
  expect(send.mock.calls[1][0]).toEqual(original);
});
it("settles independent targets in reverse order without losing either result", async () => {
  const first = deferred(),
    second = deferred();
  send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = setup();
  start(view);
  act(() =>
    view.result.current.start(
      { kind: "assignment", id: "other" },
      "Other crew",
    ),
  );
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await act(async () => second.resolve(reply(send.mock.calls[1][0])));
  expect(view.result.current.work["assignment:other"].kind).toBe("confirmed");
  expect(view.result.current.work[slot].kind).toBe("pending");
  await act(async () => first.resolve(reply(send.mock.calls[0][0])));
  await settled(view);
  expect(view.result.current.work["assignment:other"].refresh).toBe("done");
});
it("refresh retries only reads after a confirmed delivery", async () => {
  refresh.mockRejectedValueOnce(new Error("Schedule read failed"));
  const view = setup();
  start(view);
  await waitFor(() =>
    expect(view.result.current.work[slot]).toMatchObject({
      kind: "confirmed",
      refresh: "failed",
    }),
  );
  act(() => {
    view.result.current.retry(slot);
    view.result.current.another(slot);
  });
  expect(send).toHaveBeenCalledTimes(1);
  act(() => view.result.current.refresh(slot));
  await settled(view);
  expect(send).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it.each(["failed", "uncertain", "sending", "unavailable"])(
  "retries %s with the same request and retains the previous result",
  async (email) => {
    send.mockImplementationOnce(async (command) => reply(command, email));
    const view = setup();
    start(view);
    await settled(view);
    act(() => {
      view.result.current.dismiss(slot);
      view.result.current.another(slot);
    });
    expect(send).toHaveBeenCalledTimes(1);
    const held = deferred();
    send.mockReturnValueOnce(held.promise);
    act(() => view.result.current.retry(slot));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(view.result.current.work[slot].previous.items[0].email).toBe(email);
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
    await act(async () => held.resolve(reply(send.mock.calls[1][0])));
    await settled(view);
  },
);
it.each(["expired", "changed"])(
  "requires an explicit new request after %s",
  async (email) => {
    send.mockImplementationOnce(async (command) => reply(command, email));
    const view = setup();
    start(view);
    await settled(view);
    act(() => {
      view.result.current.dismiss(slot);
      view.result.current.retry(slot);
      view.result.current.start(target, "Sunday");
    });
    expect(view.result.current.work[slot]).toBeDefined();
    expect(send).toHaveBeenCalledTimes(1);
    act(() => view.result.current.another(slot));
    await settled(view);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].requestId).not.toBe(
      send.mock.calls[0][0].requestId,
    );
  },
);
it("a late result stays with its original account and never refreshes the new screen", async () => {
  const held = deferred();
  send.mockReturnValueOnce(held.promise);
  const view = setup();
  start(view);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  view.rerender({ userId: "other", orgId: "org", enabled: true });
  await act(async () => held.resolve(reply(send.mock.calls[0][0])));
  expect(view.result.current.work).toEqual({});
  expect(refresh).not.toHaveBeenCalled();
  view.rerender({ userId: "user", orgId: "org", enabled: true });
  expect(view.result.current.work[slot]).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
  act(() => view.result.current.refresh(slot));
  await settled(view);
});
it.each(["resolve", "reject"])(
  "cache clearing prevents a late %s from restoring old work",
  async (outcome) => {
    const held = deferred();
    send.mockReturnValueOnce(held.promise);
    const view = setup();
    start(view);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => client.clear());
    await act(async () =>
      held[outcome](
        outcome === "resolve"
          ? reply(send.mock.calls[0][0])
          : new Error("Late failure"),
      ),
    );
    expect(view.result.current.work).toEqual({});
    expect(refresh).not.toHaveBeenCalled();
  },
);
it("bounds an unresponsive send and ignores its late success", async () => {
  const held = deferred();
  send.mockReturnValueOnce(held.promise);
  const view = setup();
  vi.useFakeTimers();
  await act(async () => view.result.current.start(target, "Sunday"));
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(view.result.current.work[slot]).toMatchObject({
    kind: "failed",
    message: "Reminder delivery could not be confirmed.",
  });
  expect(send.mock.calls[0][1].aborted).toBe(true);
  await act(async () => held.resolve(reply(send.mock.calls[0][0])));
  expect(view.result.current.work[slot].kind).toBe("failed");
  expect(refresh).not.toHaveBeenCalled();
});
it("bounds refresh separately and releases a focused-screen refresh when leaving", async () => {
  refresh.mockReturnValue(new Promise(() => {}));
  const view = setup();
  vi.useFakeTimers();
  await act(async () => view.result.current.start(target, "Sunday"));
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(view.result.current.work[slot]).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
  await act(async () => view.result.current.refresh(slot));
  view.rerender({ userId: "user", orgId: "org", enabled: false });
  await act(async () => {});
  expect(refresh.mock.calls[1][0].aborted).toBe(true);
  expect(view.result.current.work[slot]).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("rejects a reply for another request without claiming delivery", async () => {
  send.mockImplementationOnce(async (command) => ({
    ...reply(command),
    requestId: crypto.randomUUID(),
  }));
  const view = setup();
  start(view);
  await waitFor(() =>
    expect(view.result.current.work[slot]).toMatchObject({
      kind: "failed",
      message: "Reminder reply does not match this request.",
    }),
  );
  expect(refresh).not.toHaveBeenCalled();
});
