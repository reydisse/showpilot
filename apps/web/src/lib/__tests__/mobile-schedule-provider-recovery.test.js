import { jsx } from "react/jsx-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useScheduleProvider,
  useScheduleProviderDraft,
} from "../../test/native-schedule-provider-hook.js";
import { scheduleProviderCommandSchema } from "../schedule-provider-contract";
const initial = {
  orgId: "org",
  userId: "user",
  revision: null,
  config: { provider: "native", url: "", label: "" },
};
let client, read, send, refresh;
const wrapper = ({ children }) =>
  jsx(QueryClientProvider, { client, children });
const reply = (command, outcome = "applied") => ({
  orgId: command.orgId,
  userId: command.userId,
  requestId: command.requestId,
  outcome,
  snapshot: {
    orgId: command.orgId,
    userId: command.userId,
    revision: command.requestId,
    config: command.config,
  },
});
function setup() {
  return renderHook(
    ({ active, orgId, userId }) =>
      useScheduleProvider({ orgId, userId }, { active, read, send, refresh }),
    { wrapper, initialProps: { active: true, orgId: "org", userId: "user" } },
  );
}
beforeEach(() => {
  client = new QueryClient();
  read = vi.fn(async (scope) => ({ ...initial, ...scope }));
  send = vi.fn(async (command) => reply(command));
  refresh = vi.fn(async () => {});
});
afterEach(() => {
  cleanup();
  client.clear();
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
const edit = (view) =>
  act(() =>
    view.result.current.setFields({
      provider: "other",
      url: "https://planner.test/team",
      label: "Our planner",
    }),
  );
it("retains draft and reviewed version across close, remount and cache timeout", async () => {
  const view = setup();
  await ready(view);
  edit(view);
  view.unmount();
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6 * 60000);
  });
  vi.useRealTimers();
  const reopened = setup();
  await ready(reopened);
  expect(reopened.result.current.draft.fields.label).toBe("Our planner");
  expect(read).toHaveBeenCalledTimes(1);
  const summary = renderHook(
    () => useScheduleProviderDraft({ orgId: "org", userId: "user" }),
    { wrapper },
  );
  expect(summary.result.current.fields.provider).toBe("other");
});
it("locks an unknown outcome and retries the exact command with the server contract", async () => {
  send.mockRejectedValueOnce(new Error("Reply lost"));
  const view = setup();
  await ready(view);
  edit(view);
  act(() => {
    view.result.current.submit();
    view.result.current.submit();
  });
  await waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
  act(() => {
    view.result.current.setFields({ label: "Unsafe replacement" });
    view.result.current.loadCurrent();
  });
  expect(view.result.current.discard()).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  act(() => view.result.current.retry());
  await settled(view);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(
    scheduleProviderCommandSchema.parse(send.mock.calls[0][0]),
  ).toMatchObject({ expectedRevision: null, config: { label: "Our planner" } });
});
it("separates a confirmed result from a failed refresh and retries only the read", async () => {
  refresh.mockRejectedValueOnce(new Error("Read failed"));
  const view = setup();
  await ready(view);
  edit(view);
  act(() => view.result.current.submit());
  await waitFor(() =>
    expect(view.result.current.attempt.refresh).toBe("failed"),
  );
  expect(view.result.current.attempt.result.outcome).toBe("applied");
  act(() => {
    view.result.current.retry();
    view.result.current.loadCurrent();
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  act(() => view.result.current.refresh());
  await settled(view);
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps conflict fields until an explicit fresh read and uses a new request", async () => {
  send.mockImplementationOnce(async (command) => reply(command, "conflict"));
  const view = setup();
  await ready(view);
  edit(view);
  act(() => view.result.current.submit());
  await settled(view);
  expect(view.result.current.draft.base.revision).toBeNull();
  read.mockResolvedValueOnce({ ...initial, revision: "newer" });
  act(() => view.result.current.loadCurrent());
  await waitFor(() =>
    expect(view.result.current.draft.base.revision).toBe("newer"),
  );
  expect(view.result.current.attempt).toBeUndefined();
  edit(view);
  act(() => view.result.current.submit());
  await settled(view);
  expect(send.mock.calls[1][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
  expect(send.mock.calls[1][0].expectedRevision).toBe("newer");
});
it("bounds an initial read and requires an explicit retry", async () => {
  vi.useFakeTimers();
  read.mockImplementationOnce(() => new Promise(() => {}));
  const view = setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(view.result.current.error).toContain("timed out");
  expect(view.result.current.reading).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    view.result.current.loadCurrent();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(view.result.current.draft.base).toEqual(initial);
});
it("bounds command and refresh independently and ignores late mutation replies", async () => {
  vi.useFakeTimers();
  let release;
  send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const view = setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  edit(view);
  await act(async () => {
    view.result.current.submit();
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(view.result.current.attempt.kind).toBe("failed");
  await act(async () => release(reply(send.mock.calls[0][0])));
  expect(view.result.current.attempt.kind).toBe("failed");
  refresh.mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => {
    view.result.current.retry();
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(view.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
});
it("retains an old account's result without refreshing the new account", async () => {
  let release;
  send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const view = setup();
  await ready(view);
  edit(view);
  act(() => view.result.current.submit());
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  view.rerender({ active: true, orgId: "other", userId: "other" });
  await ready(view);
  await act(async () => release(reply(send.mock.calls[0][0])));
  expect(refresh).not.toHaveBeenCalled();
  expect(view.result.current.attempt).toBeUndefined();
  expect(view.result.current.draft.base.orgId).toBe("other");
  view.rerender({ active: true, orgId: "org", userId: "user" });
  expect(view.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
});
it("ignores stale reads after focus loss and preserves the original draft on reload failure", async () => {
  const view = setup();
  await ready(view);
  edit(view);
  let release;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  view.rerender({ active: false, orgId: "org", userId: "user" });
  await act(async () => release({ ...initial, revision: "stale" }));
  view.rerender({ active: true, orgId: "org", userId: "user" });
  expect(view.result.current.draft.fields.label).toBe("Our planner");
  expect(view.result.current.draft.base.revision).toBeNull();
  read.mockRejectedValueOnce(new Error("Reload failed"));
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.error).toBe("Reload failed"));
  expect(view.result.current.draft.fields.label).toBe("Our planner");
});
it.each(["requestId", "userId", "snapshot"])(
  "rejects a reply with mismatched %s",
  async (field) => {
    send.mockImplementationOnce(async (command) => ({
      ...reply(command),
      [field]: field === "snapshot" ? { ...initial, userId: "wrong" } : "wrong",
    }));
    const view = setup();
    await ready(view);
    act(() => view.result.current.submit());
    await waitFor(() =>
      expect(view.result.current.attempt.kind).toBe("failed"),
    );
    expect(refresh).not.toHaveBeenCalled();
  },
);
it("does not submit invalid URLs or leak hidden fields into a native source", async () => {
  const view = setup();
  await ready(view);
  edit(view);
  act(() => view.result.current.setFields({ url: "http://insecure.test" }));
  act(() => view.result.current.submit());
  expect(send).not.toHaveBeenCalled();
  expect(view.result.current.error).toContain("HTTPS");
  act(() => view.result.current.setFields({ provider: "native" }));
  act(() => view.result.current.submit());
  await settled(view);
  expect(send.mock.calls[0][0].config).toEqual(initial.config);
});
it("discards only unsent drafts or refreshed known results", async () => {
  const view = setup();
  await ready(view);
  edit(view);
  let discarded;
  act(() => {
    discarded = view.result.current.discard();
  });
  expect(discarded).toBe(true);
  expect(
    client.getQueryData(["mobile-provider-draft", "user", "org"]),
  ).toBeNull();
});

it("selects only account identity when the sheet passes additional component props", async () => {
  const view = renderHook(
    () =>
      useScheduleProvider(
        { orgId: "org", userId: "user", onClose: () => {} },
        { active: true, read, send, refresh },
      ),
    { wrapper },
  );
  await ready(view);
  edit(view);
  act(() => view.result.current.submit());
  await settled(view);
  expect(read.mock.calls[0][0]).toEqual({ orgId: "org", userId: "user" });
  expect(send.mock.calls[0][0]).not.toHaveProperty("onClose");
});
