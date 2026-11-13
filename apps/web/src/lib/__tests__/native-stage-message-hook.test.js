import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStageMessage } from "../../test/native-stage-message-hook.js";
const scope = {
  orgId: "org",
  userId: "operator",
  showId: "show",
  serviceDate: "2026-11-09",
};
const defaults = {
  active: true,
  ready: true,
  revision: 4,
  message: "Current message",
};
const reply = (c) => ({ ...c, outcome: "applied", revision: 5 });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup(
  send = vi.fn(async (c) => reply(c)),
  refresh = vi.fn(async () => {}),
  client = new QueryClient(),
) {
  const view = renderHook(
    ({ identity, options }) =>
      useStageMessage(identity, { ...options, send, refresh }),
    {
      initialProps: { identity: scope, options: defaults },
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    },
  );
  return { ...view, client, send, refresh };
}
it("keeps unsent text and priority when another operator changes the stage message", async () => {
  const f = setup();
  expect(f.result.current.draft.text).toBe("Current message");
  await act(async () =>
    f.result.current.setFields({ text: "My draft", priority: true }),
  );
  f.rerender({
    identity: scope,
    options: { ...defaults, revision: 5, message: "Remote replacement" },
  });
  expect(f.result.current.draft).toMatchObject({
    text: "My draft",
    priority: true,
  });
  expect(f.send).not.toHaveBeenCalled();
});
it("retains drafts across navigation and isolates account, org and show", async () => {
  const f = setup();
  await act(async () =>
    f.result.current.setFields({ text: "Retained", priority: true }),
  );
  f.unmount();
  const next = setup(undefined, undefined, f.client);
  expect(next.result.current.draft.text).toBe("Retained");
  for (const field of ["orgId", "userId", "showId"]) {
    next.rerender({
      identity: { ...scope, [field]: "other" },
      options: { ...defaults, message: "Different show" },
    });
    expect(next.result.current.draft.text).toBe("Different show");
  }
  next.rerender({ identity: scope, options: defaults });
  expect(next.result.current.draft).toMatchObject({
    text: "Retained",
    priority: true,
  });
});
it("reviewing sends nothing and confirmation sends only the reviewed text and revision", async () => {
  const f = setup();
  await act(async () =>
    f.result.current.setFields({
      text: "  Stand by\nCamera two  ",
      priority: true,
    }),
  );
  const review = f.result.current.prepare("send");
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => {
    f.result.current.confirm(review);
    f.result.current.confirm(review);
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0][0]).toMatchObject({
    ...scope,
    expectedRevision: 4,
    action: "stage-message",
    message: "!!PRIORITY!!Stand by\nCamera two",
  });
});
it.each(["revision", "serviceDate", "userId", "showId", "orgId", "message"])(
  "invalidates a review when %s changes",
  async (field) => {
    const f = setup();
    const review = f.result.current.prepare("clear");
    const identity = ["serviceDate", "userId", "showId", "orgId"].includes(
      field,
    )
      ? { ...scope, [field]: field === "serviceDate" ? "2026-11-10" : "other" }
      : scope;
    const options =
      field === "revision"
        ? { ...defaults, revision: 5 }
        : field === "message"
          ? { ...defaults, message: "Different" }
          : defaults;
    f.rerender({ identity, options });
    await act(async () => f.result.current.confirm(review));
    expect(f.send).not.toHaveBeenCalled();
  },
);
it("clear keeps the unsent draft and uses its own reviewed request", async () => {
  const f = setup();
  await act(async () =>
    f.result.current.setFields({ text: "Keep this", priority: true }),
  );
  const review = f.result.current.prepare("clear");
  await act(async () => f.result.current.confirm(review));
  expect(f.send.mock.calls[0][0]).toMatchObject({
    action: "stage-clear",
    expectedRevision: 4,
  });
  expect(f.result.current.draft).toMatchObject({
    text: "Keep this",
    priority: true,
  });
});
it("replacing the draft requires a current review and never changes the displayed message", async () => {
  const f = setup();
  await act(async () =>
    f.result.current.setFields({
      text: "Keep until confirmed",
      priority: true,
    }),
  );
  const review = f.result.current.prepare("replace-draft");
  expect(f.result.current.draft.text).toBe("Keep until confirmed");
  await act(async () => f.result.current.confirm(review));
  expect(f.result.current.draft).toMatchObject({
    text: "Current message",
    priority: false,
  });
  expect(f.send).not.toHaveBeenCalled();
});
it("bounds an unknown send and retries its original message, account, date and revision", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementation(async (c) => reply(c));
  const f = setup(send);
  await act(async () =>
    f.result.current.confirm(f.result.current.prepare("send")),
  );
  const [command, signal] = send.mock.calls[0];
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(signal.aborted).toBe(true);
  expect(f.result.current.attempt.kind).toBe("failed");
  f.rerender({
    identity: { ...scope, serviceDate: "2026-11-10" },
    options: { ...defaults, message: "New current message", revision: 99 },
  });
  await act(async () => {
    f.result.current.setFields({ text: "Cannot overwrite" });
    f.result.current.dismiss();
  });
  expect(f.result.current.prepare("clear")).toBeNull();
  expect(f.result.current.draft.text).toBe("Current message");
  await act(async () => f.result.current.retry());
  expect(send.mock.calls[1][0]).toEqual(command);
});
it("late receipt after navigation remains with the original account without refreshing another", async () => {
  let finish;
  const f = setup(
    vi.fn(
      (c) =>
        new Promise((resolve) => {
          finish = () => resolve(reply(c));
        }),
    ),
  );
  await act(async () =>
    f.result.current.confirm(f.result.current.prepare("send")),
  );
  f.unmount();
  await act(async () => finish());
  expect(f.refresh).not.toHaveBeenCalled();
  const next = setup(undefined, undefined, f.client);
  expect(next.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
  await act(async () => next.result.current.refresh());
  expect(next.send).not.toHaveBeenCalled();
});
it("refresh retries do not repeat an accepted clear", async () => {
  const f = setup(
    undefined,
    vi
      .fn()
      .mockRejectedValueOnce(new Error("Read failed"))
      .mockResolvedValue(undefined),
  );
  await act(async () =>
    f.result.current.confirm(f.result.current.prepare("clear")),
  );
  expect(f.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
  await act(async () => f.result.current.refresh());
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.attempt.refresh).toBe("done");
});
it.each(["orgId", "userId", "showId", "requestId"])(
  "rejects a reply for a different %s",
  async (field) => {
    const f = setup(vi.fn(async (c) => ({ ...reply(c), [field]: "other" })));
    await act(async () =>
      f.result.current.confirm(f.result.current.prepare("send")),
    );
    expect(f.result.current.attempt.kind).toBe("failed");
    expect(f.refresh).not.toHaveBeenCalled();
  },
);
it("offline and lost access cannot confirm, but offline typing keeps the draft", async () => {
  const f = setup();
  const review = f.result.current.prepare("send");
  f.rerender({ identity: scope, options: { ...defaults, ready: false } });
  await act(async () => {
    f.result.current.confirm(review);
    f.result.current.setFields({ text: "Offline draft" });
  });
  expect(f.send).not.toHaveBeenCalled();
  expect(f.result.current.draft.text).toBe("Offline draft");
  f.rerender({ identity: scope, options: { ...defaults, active: false } });
  await act(async () => f.result.current.confirm(review));
  expect(f.send).not.toHaveBeenCalled();
});
it("a conflict keeps the draft and requires a new review with a fresh request", async () => {
  const f = setup(vi.fn(async (c) => ({ ...reply(c), outcome: "conflict" })));
  await act(async () =>
    f.result.current.confirm(f.result.current.prepare("send")),
  );
  await act(async () => f.result.current.retry());
  expect(f.send).toHaveBeenCalledTimes(1);
  f.rerender({
    identity: scope,
    options: { ...defaults, revision: 6, message: "Other operator" },
  });
  expect(f.result.current.prepare("send")).toBeNull();
  await act(async () => f.result.current.dismiss());
  await act(async () =>
    f.result.current.confirm(f.result.current.prepare("send")),
  );
  expect(f.send.mock.calls[1][0]).toMatchObject({
    message: "Current message",
    expectedRevision: 6,
  });
  expect(f.send.mock.calls[1][0].requestId).not.toBe(
    f.send.mock.calls[0][0].requestId,
  );
});

it("keeps an overlong incoming message intact but requires shortening before send", async () => {
  const f = setup();
  f.rerender({
    identity: scope,
    options: { ...defaults, message: "x".repeat(2000), revision: 5 },
  });
  await act(async () =>
    f.result.current.confirm(f.result.current.prepare("replace-draft")),
  );
  expect(f.result.current.draft.text).toHaveLength(2000);
  expect(f.result.current.prepare("send")).toBeNull();
  await act(async () =>
    f.result.current.setFields({ text: "Shortened draft" }),
  );
  expect(f.result.current.prepare("send")).toMatchObject({
    kind: "send",
    fields: { text: "Shortened draft" },
  });
});
