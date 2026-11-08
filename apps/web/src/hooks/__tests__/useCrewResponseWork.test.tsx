import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useCrewResponseWork,
  type CrewPortalAssignment,
} from "../useCrewResponseWork";
import type {
  CrewResponseCommand,
  CrewResponseResult,
} from "@/lib/crew-response-contract";
import type { ReactNode } from "react";
const token = "a".repeat(43);
const selected: CrewPortalAssignment = {
  id: "assignment",
  revision: "revision",
  showId: "show",
  serviceDate: "2099-01-01",
  role: "Audio",
  status: "assigned",
  notes: "Bring headset",
  responseNote: "",
  callTime: "",
  invitedAt: null,
  respondedAt: null,
  responseVersion: "[1]",
  serviceName: "Sunday",
  scheduledStartTime: null,
  effectiveCallTime: null,
  location: "Main",
  responseWindow: { status: "open", closesAt: "2099-01-02T00:00:00.000Z" },
};
const reply = (
  command: CrewResponseCommand,
  outcome: CrewResponseResult["outcome"] = "applied",
): CrewResponseResult => ({
  requestId: command.requestId,
  assignmentId: command.assignmentId,
  outcome,
});
let client: QueryClient;
let send = vi.fn(
  async (
    command: CrewResponseCommand,
    _review: boolean,
    _signal: AbortSignal,
  ): Promise<unknown> => reply(command),
);
let refresh = vi.fn(async (_signal: AbortSignal) => {});
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const setup = () =>
  renderHook(({ link }) => useCrewResponseWork(link, { send, refresh }), {
    initialProps: { link: token },
    wrapper,
  });
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(
    async (
      command: CrewResponseCommand,
      _review: boolean,
      _signal: AbortSignal,
    ): Promise<unknown> => reply(command),
  );
  refresh = vi.fn(async (_signal: AbortSignal) => {});
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
const settled = (view: ReturnType<typeof setup>) =>
  waitFor(() =>
    expect(view.result.current.entries.assignment.attempt).toMatchObject({
      kind: "confirmed",
      refresh: "done",
    }),
  );
it("retains separate notes when switching assignments and reopening the page", () => {
  const view = setup();
  act(() => {
    view.result.current.decline(selected);
    view.result.current.setReason(selected.id, "Away");
    view.result.current.decline({ ...selected, id: "second", role: "Camera" });
    view.result.current.setReason("second", "Other note");
  });
  view.unmount();
  const reopened = setup();
  expect(reopened.result.current.entries.assignment.reason).toBe("Away");
  expect(reopened.result.current.entries.second.reason).toBe("Other note");
  expect(send).not.toHaveBeenCalled();
});
it("Back keeps the note until explicit discard", () => {
  const view = setup();
  act(() => {
    view.result.current.decline(selected);
    view.result.current.setReason(selected.id, "Away");
    view.result.current.back(selected.id);
  });
  expect(view.result.current.entries.assignment).toMatchObject({
    reason: "Away",
    declining: false,
  });
  act(() => view.result.current.discard(selected.id));
  expect(view.result.current.entries.assignment).toBeUndefined();
});
it("freezes an unknown response and retries the same identity and note", async () => {
  send.mockRejectedValueOnce(new Error("Lost reply"));
  const view = setup();
  act(() => {
    view.result.current.decline(selected);
    view.result.current.setReason(selected.id, "Original");
    view.result.current.submit(selected, "declined");
  });
  await waitFor(() =>
    expect(view.result.current.entries.assignment.attempt?.kind).toBe(
      "unknown",
    ),
  );
  act(() => {
    view.result.current.setReason(selected.id, "Changed");
    view.result.current.submit({ ...selected, revision: "new" }, "confirmed");
    view.result.current.discard(selected.id);
  });
  expect(view.result.current.entries.assignment.reason).toBe("Original");
  expect(send).toHaveBeenCalledTimes(1);
  act(() => view.result.current.retry(selected.id));
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
});
it("keeps a confirmed response separate from refresh failure", async () => {
  refresh.mockRejectedValueOnce(new Error("Read failed"));
  const view = setup();
  act(() => view.result.current.submit(selected, "confirmed"));
  await waitFor(() =>
    expect(view.result.current.entries.assignment.attempt).toMatchObject({
      kind: "confirmed",
      refresh: "failed",
    }),
  );
  act(() => {
    view.result.current.retry(selected.id);
    view.result.current.discard(selected.id);
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.result.current.entries.assignment).toBeDefined();
  act(() => view.result.current.refresh(selected.id));
  await settled(view);
  act(() => view.result.current.discard(selected.id));
  expect(view.result.current.entries.assignment).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});
it("reviews before editing a cancelled response with a fresh request", async () => {
  send.mockRejectedValueOnce(new Error("Lost"));
  send.mockImplementationOnce(async (command) => reply(command, "cancelled"));
  const view = setup();
  act(() => {
    view.result.current.decline(selected);
    view.result.current.setReason(selected.id, "Away");
    view.result.current.submit(selected, "declined");
  });
  await waitFor(() =>
    expect(view.result.current.entries.assignment.attempt?.kind).toBe(
      "unknown",
    ),
  );
  act(() => view.result.current.review(selected.id));
  await settled(view);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[1][1]).toBe(true);
  act(() => {
    view.result.current.editCancelled(selected.id);
    view.result.current.setReason(selected.id, "Reviewed");
    view.result.current.submit(selected, "declined");
  });
  await settled(view);
  expect(send.mock.calls[2][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
  expect(send.mock.calls[2][0].reason).toBe("Reviewed");
});
it("preserves a conflicting note until explicit current-version adoption", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "conflict"));
  const view = setup();
  act(() => {
    view.result.current.decline(selected);
    view.result.current.setReason(selected.id, "My note");
    view.result.current.submit(selected, "declined");
  });
  await settled(view);
  act(() =>
    view.result.current.submit({ ...selected, revision: "new" }, "declined"),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.result.current.entries.assignment.selection.revision).toBe(
    "revision",
  );
  act(() =>
    view.result.current.useCurrent({
      ...selected,
      revision: "new",
      role: "Camera",
    }),
  );
  expect(view.result.current.entries.assignment).toMatchObject({
    reason: "My note",
    selection: { revision: "new", role: "Camera" },
  });
});
it.each(["requestId", "assignmentId"] as const)(
  "does not accept a reply for a different %s",
  async (field) => {
    send.mockImplementationOnce(async (command) => ({
      ...reply(command),
      [field]: field === "requestId" ? crypto.randomUUID() : "other",
    }));
    const view = setup();
    act(() => view.result.current.submit(selected, "confirmed"));
    await waitFor(() =>
      expect(view.result.current.entries.assignment.attempt?.kind).toBe(
        "unknown",
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  },
);
it("bounds response and refresh operations even when transports ignore abort", async () => {
  vi.useFakeTimers();
  send.mockImplementationOnce(() => new Promise(() => {}));
  const view = setup();
  act(() => view.result.current.submit(selected, "confirmed"));
  await act(() => vi.advanceTimersByTimeAsync(15001));
  expect(view.result.current.entries.assignment.attempt?.kind).toBe("unknown");
  refresh.mockImplementationOnce(() => new Promise(() => {}));
  act(() => view.result.current.retry(selected.id));
  await act(() => vi.advanceTimersByTimeAsync(12001));
  expect(view.result.current.entries.assignment.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
});
it("keeps late replies in their original link scope without refreshing another link", async () => {
  let complete: (() => void) | undefined;
  send.mockImplementationOnce(
    (command) =>
      new Promise((resolve) => {
        complete = () => resolve(reply(command));
      }),
  );
  const view = setup();
  act(() => view.result.current.submit(selected, "confirmed"));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  view.rerender({ link: "b".repeat(43) });
  await act(async () => {
    if (!complete) throw new Error("Missing pending request");
    complete();
  });
  expect(view.result.current.entries.assignment).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender({ link: token });
  expect(view.result.current.entries.assignment.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
});
it("allows independent assignments while keeping each request fixed", async () => {
  send.mockRejectedValueOnce(new Error("Lost"));
  const view = setup();
  act(() => view.result.current.submit(selected, "confirmed"));
  await waitFor(() =>
    expect(view.result.current.entries.assignment.attempt?.kind).toBe(
      "unknown",
    ),
  );
  act(() =>
    view.result.current.submit({ ...selected, id: "second" }, "declined"),
  );
  await waitFor(() =>
    expect(view.result.current.entries.second.attempt?.kind).toBe("confirmed"),
  );
  expect(view.result.current.entries.assignment.attempt?.kind).toBe("unknown");
});

it("reports invalid submission without sending or losing the note", () => {
  const view = setup();
  act(() => {
    view.result.current.decline(selected);
    view.result.current.setReason(selected.id, "a".repeat(501));
  });
  act(() => view.result.current.submit(selected, "declined"));
  expect(send).not.toHaveBeenCalled();
  expect(view.result.current.entries.assignment.validationError).toContain(
    "500 characters",
  );
  expect(view.result.current.entries.assignment.reason).toHaveLength(501);
  act(() => view.result.current.setReason(selected.id, "Away"));
  expect(
    view.result.current.entries.assignment.validationError,
  ).toBeUndefined();
});
