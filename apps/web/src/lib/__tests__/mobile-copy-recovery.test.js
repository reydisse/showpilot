import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMobileCopy } from "../../test/native-copy-hook.js";

let client, send, refresh;
const selection = {
  showId: "target",
  serviceDate: "2099-01-08",
  copyFromShowId: "source",
  copyFrom: "2099-01-01",
};
function reply(command, email = "accepted", changed = false, reason = null) {
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    copied: reason ? 0 : 1,
    reason,
    items: reason
      ? []
      : [
          {
            id: "position",
            label: "Video · Camera",
            changed,
            invitation: changed
              ? null
              : {
                  id: "position",
                  label: "Video · Camera",
                  email,
                  inAppDelivered: true,
                  reason: null,
                  updatedAt: 1,
                },
          },
        ],
  };
}
function setup() {
  return renderHook(
    ({ enabled }) =>
      useMobileCopy(
        { userId: "user", orgId: "org" },
        { enabled, send, refresh },
      ),
    {
      initialProps: { enabled: true },
      wrapper: ({ children }) => jsx(QueryClientProvider, { client, children }),
    },
  );
}
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(async (command) => reply(command));
  refresh = vi.fn(async () => {});
});
afterEach(() => client.clear());
const start = (view) =>
  act(() => view.result.current.start(selection, "Previous → Next"));
const settled = (view) =>
  waitFor(() =>
    expect(view.result.current.work.target).toMatchObject({
      kind: "confirmed",
      refresh: "done",
    }),
  );
it("retains the exact copy selection across closure and retries without a new identity", async () => {
  send.mockRejectedValueOnce(new Error("Lost reply"));
  const first = setup();
  act(() => {
    first.result.current.start(selection, "Previous → Next");
    first.result.current.start(selection, "Repeat");
  });
  await waitFor(() =>
    expect(first.result.current.work.target.kind).toBe("failed"),
  );
  first.unmount();
  const next = setup();
  act(() =>
    next.result.current.start(
      { ...selection, copyFromShowId: "other" },
      "Different source",
    ),
  );
  expect(send).toHaveBeenCalledTimes(1);
  act(() => next.result.current.retry("target"));
  await settled(next);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
});
it("retrying an uncertain invitation keeps the original copy receipt and blocks dismissal", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "uncertain"));
  const view = setup();
  start(view);
  await settled(view);
  act(() => {
    view.result.current.dismiss("target");
    view.result.current.another("target");
  });
  expect(view.result.current.work.target).toBeDefined();
  expect(send).toHaveBeenCalledTimes(1);
  act(() => view.result.current.retry("target"));
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
});
it.each(["live-show", "target-not-empty", "source-empty"])(
  "%s requires an explicit new copy instead of retrying a rejected request",
  async (reason) => {
    send.mockImplementationOnce(async (command) =>
      reply(command, "accepted", false, reason),
    );
    const view = setup();
    start(view);
    await settled(view);
    act(() => view.result.current.retry("target"));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => view.result.current.another("target"));
    await settled(view);
    expect(send.mock.calls[1][0].requestId).not.toBe(
      send.mock.calls[0][0].requestId,
    );
    expect(send.mock.calls[1][0]).toMatchObject(selection);
  },
);
it("does not retry changed positions and releases their result only explicitly", async () => {
  send.mockImplementationOnce(async (command) =>
    reply(command, "accepted", true),
  );
  const view = setup();
  start(view);
  await settled(view);
  act(() => view.result.current.retry("target"));
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.result.current.work.target.result.items[0].changed).toBe(true);
  act(() => view.result.current.dismiss("target"));
  expect(view.result.current.work).toEqual({});
});
it("refresh recovery never recopies the roster or resends invitations", async () => {
  refresh.mockRejectedValueOnce(new Error("Schedule read failed"));
  const view = setup();
  start(view);
  await waitFor(() =>
    expect(view.result.current.work.target.refresh).toBe("failed"),
  );
  act(() => view.result.current.refresh("target"));
  await settled(view);
  expect(send).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("an abandoned copy confirmation cannot write after leaving Schedule", async () => {
  const view = setup(),
    confirm = view.result.current.start;
  view.rerender({ enabled: false });
  await act(async () => confirm(selection, "Abandoned selection"));
  expect(send).not.toHaveBeenCalled();
});
