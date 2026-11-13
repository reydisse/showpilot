import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRundownItemEditor } from "../../test/native-rundown-item-hook.js";
const scope = {
  orgId: "org",
  userId: "operator",
  showId: "show",
  serviceDate: "2026-11-09",
};
const item = {
  id: "welcome",
  title: "Welcome",
  type: "segment",
  duration: 60000,
  assignee: "Host",
  cue: "Go",
  notes: "Original",
  hardStop: false,
  status: "upcoming",
  sortOrder: 0,
  revision: 0,
};
const defaults = {
  active: true,
  canSubmit: true,
  revision: 4,
  items: [item, { ...item, id: "next", title: "Next", sortOrder: 1 }],
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
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const view = renderHook(
    ({ identity, options }) =>
      useRundownItemEditor(identity, { ...options, send, refresh }),
    { initialProps: { identity: scope, options: defaults }, wrapper },
  );
  return { ...view, send, refresh, client };
}
it("retains all draft fields and stable new-item ID across navigation, isolating actor and show", async () => {
  const f = setup();
  await act(async () => f.result.current.open(null));
  const id = f.result.current.draft.id;
  await act(async () =>
    f.result.current.setFields({
      title: "New song",
      type: "song",
      duration: "3:45",
      notes: "Line one\nLine two",
      cue: "Fade",
      assignee: "Band",
      hardStop: true,
    }),
  );
  const saved = f.result.current.draft;
  f.unmount();
  const next = setup(undefined, undefined, f.client);
  expect(next.result.current.draft).toEqual(saved);
  next.rerender({ identity: { ...scope, showId: "other" }, options: defaults });
  expect(next.result.current.draft).toBeNull();
  next.rerender({ identity: { ...scope, userId: "other" }, options: defaults });
  expect(next.result.current.draft).toBeNull();
  next.rerender({ identity: scope, options: defaults });
  await act(async () => next.result.current.submit());
  expect(next.send.mock.calls[0][0]).toMatchObject({
    ...scope,
    action: "add-item",
    itemId: id,
    expectedRevision: 4,
    fields: { ...saved.fields, duration: 225000 },
  });
});
it("bounds a lost save response and retries the exact reviewed fields without rebasing", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementation(async (c) => reply(c));
  const f = setup(send);
  await act(async () => f.result.current.open(item));
  await act(async () => f.result.current.setFields({ title: "My revision" }));
  await act(async () => f.result.current.submit());
  const [command, signal] = send.mock.calls[0];
  await act(async () => vi.advanceTimersByTimeAsync(15001));
  expect(signal.aborted).toBe(true);
  expect(f.result.current.attempt.kind).toBe("failed");
  f.rerender({
    identity: scope,
    options: {
      ...defaults,
      revision: 99,
      items: [{ ...item, title: "Other operator" }],
    },
  });
  await act(async () => {
    f.result.current.setFields({ title: "Later" });
    f.result.current.review();
    f.result.current.submit();
    f.result.current.discard();
  });
  expect(f.result.current.draft.fields.title).toBe("My revision");
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.retry());
  expect(send.mock.calls[1][0]).toEqual(command);
  expect(f.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "done",
  });
});
it("keeps an unmounted request and its late receipt in its original account", async () => {
  let finish;
  const f = setup(
    vi.fn(
      (c) =>
        new Promise((resolve) => {
          finish = () => resolve(reply(c));
        }),
    ),
  );
  await act(async () => f.result.current.open(item));
  await act(async () => f.result.current.submit());
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
  expect(next.result.current.attempt.refresh).toBe("done");
});
it.each(["orgId", "userId", "showId", "requestId"])(
  "rejects a mismatched %s receipt",
  async (field) => {
    const f = setup(vi.fn(async (c) => ({ ...reply(c), [field]: "other" })));
    await act(async () => f.result.current.open(item));
    await act(async () => f.result.current.submit());
    expect(f.result.current.attempt.kind).toBe("failed");
    expect(f.refresh).not.toHaveBeenCalled();
  },
);
it("refresh failure retries only the refresh", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(undefined);
  const f = setup(undefined, refresh);
  await act(async () => f.result.current.open(item));
  await act(async () => f.result.current.submit());
  await act(async () => vi.advanceTimersByTimeAsync(12001));
  expect(f.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "failed",
  });
  await act(async () => f.result.current.refresh());
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.result.current.attempt.refresh).toBe("done");
});
it("requires explicit current-revision review after a conflict, preserving the fields", async () => {
  const f = setup(
    vi.fn(async (c) => ({ ...reply(c), outcome: "conflict", revision: 6 })),
  );
  await act(async () => f.result.current.open(item));
  await act(async () =>
    f.result.current.setFields({ notes: "Operator notes" }),
  );
  await act(async () => f.result.current.submit());
  const original = f.send.mock.calls[0][0];
  await act(async () => f.result.current.review());
  expect(f.result.current.attempt).toBeTruthy();
  f.rerender({
    identity: scope,
    options: {
      ...defaults,
      revision: 6,
      items: [{ ...item, title: "Current title" }],
    },
  });
  await act(async () => f.result.current.retry());
  expect(f.send).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.review());
  expect(f.result.current.attempt).toBeUndefined();
  expect(f.result.current.draft.base.item.title).toBe("Current title");
  expect(f.result.current.draft.fields.notes).toBe("Operator notes");
  await act(async () => f.result.current.submit());
  expect(f.send.mock.calls[1][0]).toMatchObject({
    expectedRevision: 6,
    fields: { notes: "Operator notes" },
  });
  expect(f.send.mock.calls[1][0].requestId).not.toBe(original.requestId);
});
it("moves the reviewed order without saving or dropping unsaved item fields", async () => {
  const f = setup();
  await act(async () => f.result.current.open(item));
  await act(async () => f.result.current.setFields({ title: "Still a draft" }));
  await act(async () => f.result.current.submit("down"));
  expect(f.send.mock.calls[0][0]).toMatchObject({
    action: "reorder",
    expectedRevision: 4,
    order: ["next", "welcome"],
  });
  expect(f.send.mock.calls[0][0]).not.toHaveProperty("fields");
  expect(f.result.current.draft.fields.title).toBe("Still a draft");
  f.rerender({
    identity: scope,
    options: { ...defaults, revision: 5, items: [defaults.items[1], item] },
  });
  await act(async () => f.result.current.review());
  expect(f.result.current.draft.fields.title).toBe("Still a draft");
  expect(f.result.current.draft.base.order).toEqual(["next", "welcome"]);
});
it("does not resurrect a removed item when reviewing a conflict", async () => {
  const f = setup();
  await act(async () => f.result.current.open(item));
  f.rerender({
    identity: scope,
    options: { ...defaults, revision: 5, items: [] },
  });
  await act(async () => f.result.current.review());
  expect(f.result.current.draft.base.revision).toBe(4);
});
it("offline keeps drafts editable but cannot submit, retry or rebase", async () => {
  const f = setup();
  await act(async () => f.result.current.open(item));
  f.rerender({
    identity: scope,
    options: { ...defaults, canSubmit: false, revision: 5 },
  });
  await act(async () => {
    f.result.current.setFields({ title: "Offline draft" });
    f.result.current.submit();
    f.result.current.review();
  });
  expect(f.result.current.draft.fields.title).toBe("Offline draft");
  expect(f.result.current.draft.base.revision).toBe(4);
  expect(f.send).not.toHaveBeenCalled();
});
it("blocks invalid duration but allows a section with zero duration", async () => {
  const f = setup();
  await act(async () => f.result.current.open(null));
  await act(async () =>
    f.result.current.setFields({ title: "Section", duration: "1:99" }),
  );
  await act(async () => f.result.current.submit());
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => f.result.current.setFields({ type: "header" }));
  await act(async () => f.result.current.submit());
  expect(f.send.mock.calls[0][0]).toMatchObject({
    fields: { duration: 0, type: "header" },
  });
});
it("blocks a changed date until explicitly reviewed and keeps the original date on retry", async () => {
  const f = setup();
  await act(async () => f.result.current.open(item));
  f.rerender({
    identity: { ...scope, serviceDate: "2026-11-10" },
    options: defaults,
  });
  await act(async () => f.result.current.submit());
  expect(f.send).not.toHaveBeenCalled();
  await act(async () => f.result.current.review());
  await act(async () => f.result.current.submit());
  expect(f.send.mock.calls[0][0].serviceDate).toBe("2026-11-10");
});
