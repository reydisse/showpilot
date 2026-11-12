import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePersonalResponses } from "../../test/native-personal-responses.js";
const selection = {
  assignmentId: "assignment",
  expectedRevision: "revision",
  reviewedVersion: "[1]",
  label: "Audio · Sunday (2099-01-01)",
};
let client, send, refresh;
const result = (command, outcome = "applied") => ({
  orgId: command.orgId,
  userId: command.userId,
  requestId: command.requestId,
  assignmentId: command.assignmentId,
  outcome,
});
const wrapper = ({ children }) =>
  jsx(QueryClientProvider, { client, children });
const setup = () =>
  renderHook(
    ({ userId, orgId, enabled }) =>
      usePersonalResponses({ userId, orgId }, { enabled, send, refresh }),
    { initialProps: { userId: "user", orgId: "org", enabled: true }, wrapper },
  );
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(async (command) => result(command));
  refresh = vi.fn(async () => {});
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
const settled = (view) =>
  waitFor(() =>
    expect(view.result.current.work.assignment).toMatchObject({
      kind: "confirmed",
      refresh: "done",
    }),
  );
it("retains decline notes across navigation and blocks accepting over a draft", async () => {
  const view = setup();
  act(() => {
    view.result.current.decline(selection);
    view.result.current.setReason("assignment", "Family trip");
    view.result.current.accept(selection);
  });
  expect(send).not.toHaveBeenCalled();
  view.unmount();
  const reopened = setup();
  expect(reopened.result.current.drafts[0].reason).toBe("Family trip");
  act(() => reopened.result.current.submitDecline("assignment"));
  await settled(reopened);
  expect(send.mock.calls[0][0]).toMatchObject({
    assignmentId: selection.assignmentId,
    expectedRevision: selection.expectedRevision,
    response: "declined",
    reason: "Family trip",
  });
});
it("keeps an unknown response frozen and retries its exact request", async () => {
  send.mockRejectedValueOnce(new Error("Lost reply"));
  const view = setup();
  act(() => {
    view.result.current.decline(selection);
    view.result.current.setReason("assignment", "Away");
    view.result.current.submitDecline("assignment");
  });
  await waitFor(() =>
    expect(view.result.current.work.assignment.kind).toBe("failed"),
  );
  act(() => {
    view.result.current.accept(selection);
    view.result.current.setReason("assignment", "Changed");
    view.result.current.discard("assignment");
    view.result.current.finish("assignment");
  });
  expect(view.result.current.drafts[0].reason).toBe("Away");
  expect(send).toHaveBeenCalledTimes(1);
  act(() => view.result.current.retry("assignment"));
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
});
it("separates a confirmed response from a failed refresh", async () => {
  refresh.mockRejectedValueOnce(new Error("Read failed"));
  const view = setup();
  act(() => view.result.current.accept(selection));
  await waitFor(() =>
    expect(view.result.current.work.assignment).toMatchObject({
      kind: "confirmed",
      refresh: "failed",
    }),
  );
  act(() => {
    view.result.current.retry("assignment");
    view.result.current.finish("assignment");
  });
  expect(send).toHaveBeenCalledTimes(1);
  act(() => view.result.current.refresh("assignment"));
  await settled(view);
  expect(send).toHaveBeenCalledTimes(1);
  act(() => view.result.current.finish("assignment"));
  expect(view.result.current.work.assignment).toBeUndefined();
});
it("reviews before editing a cancelled response and uses a fresh identity", async () => {
  send.mockRejectedValueOnce(new Error("Lost"));
  send.mockImplementationOnce(async (command) => result(command, "cancelled"));
  const view = setup();
  act(() => {
    view.result.current.decline(selection);
    view.result.current.setReason("assignment", "Original");
    view.result.current.submitDecline("assignment");
  });
  await waitFor(() =>
    expect(view.result.current.work.assignment.kind).toBe("failed"),
  );
  act(() => view.result.current.review("assignment"));
  await settled(view);
  expect(send.mock.calls[1][1]).toBe(true);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  act(() => {
    view.result.current.editCancelled("assignment");
    view.result.current.setReason("assignment", "Reviewed");
    view.result.current.submitDecline("assignment");
  });
  await settled(view);
  expect(send.mock.calls[2][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
  expect(send.mock.calls[2][0].reason).toBe("Reviewed");
});
it("keeps the original note and version after conflict until current details are explicitly adopted", async () => {
  send.mockImplementationOnce(async (command) => result(command, "conflict"));
  const view = setup();
  act(() => {
    view.result.current.decline(selection);
    view.result.current.setReason("assignment", "My note");
    view.result.current.submitDecline("assignment");
  });
  await settled(view);
  act(() => view.result.current.submitDecline("assignment"));
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.result.current.drafts[0].expectedRevision).toBe("revision");
  act(() =>
    view.result.current.reviewLatest({
      ...selection,
      expectedRevision: "new",
      reviewedVersion: "[2]",
      label: "Camera",
    }),
  );
  expect(view.result.current.drafts[0]).toMatchObject({
    reason: "My note",
    expectedRevision: "new",
    label: "Camera",
  });
  act(() => view.result.current.submitDecline("assignment"));
  await settled(view);
  expect(send.mock.calls[1][0].expectedRevision).toBe("new");
});
it.each(["assignmentId", "userId", "orgId", "requestId"])(
  "does not trust a reply with another %s",
  async (field) => {
    send.mockImplementationOnce(async (command) => ({
      ...result(command),
      [field]:
        field === "requestId"
          ? "134af13c-0c71-425c-94b7-6143f8fdb064"
          : "other",
    }));
    const view = setup();
    act(() => view.result.current.accept(selection));
    await waitFor(() =>
      expect(view.result.current.work.assignment.kind).toBe("failed"),
    );
    expect(refresh).not.toHaveBeenCalled();
  },
);
it("bounds a hanging response at 15 seconds and refresh at 12 seconds", async () => {
  vi.useFakeTimers();
  send.mockImplementationOnce(() => new Promise(() => {}));
  const view = setup();
  act(() => view.result.current.accept(selection));
  await act(() => vi.advanceTimersByTimeAsync(15001));
  expect(view.result.current.work.assignment.kind).toBe("failed");
  refresh.mockImplementationOnce(() => new Promise(() => {}));
  act(() => view.result.current.retry("assignment"));
  await act(() => vi.advanceTimersByTimeAsync(12001));
  expect(view.result.current.work.assignment).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
});
it("isolates accounts and prevents late completion refreshing a different owner", async () => {
  let complete;
  send.mockImplementationOnce(
    (command) =>
      new Promise((resolve) => {
        complete = () => resolve(result(command));
      }),
  );
  const view = setup();
  act(() => view.result.current.accept(selection));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  view.rerender({ userId: "other", orgId: "org", enabled: true });
  await act(async () => complete());
  expect(view.result.current.work.assignment).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender({ userId: "user", orgId: "org", enabled: true });
  expect(view.result.current.work.assignment).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
});
it("retains unsent notes beyond the default query garbage-collection window", async () => {
  vi.useFakeTimers();
  const view = setup();
  act(() => {
    view.result.current.decline(selection);
    view.result.current.setReason("assignment", "Keep");
  });
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
  const reopened = setup();
  expect(reopened.result.current.drafts[0].reason).toBe("Keep");
});
