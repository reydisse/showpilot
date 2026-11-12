import { jsx } from "react/jsx-runtime";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useCrewProfile,
  useCrewDrafts,
} from "../../test/native-crew-profile-hook.js";
import {
  crewDraftFromSnapshot,
  newCrewDraft,
  prepareCrewPhoto,
} from "../../../../mobile/src/lib/crew-recovery.ts";
const snapshot = {
  id: "crew",
  memberId: "CAM42",
  name: "Original",
  role: "Camera Operator",
  email: "",
  photoUrl: "",
  profileRevision: 3,
};
const initial = crewDraftFromSnapshot("update", snapshot);
let client, send, read, refresh;
function reply(command, outcome = "applied") {
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    kind: command.kind,
    outcome,
    id:
      command.kind === "create"
        ? outcome === "cancelled"
          ? null
          : "created-crew"
        : command.id,
  };
}
const wrapper = ({ children }) =>
  jsx(QueryClientProvider, { client, children });
function setup(draft = initial) {
  return renderHook(
    ({ active, userId, orgId }) =>
      useCrewProfile({ orgId, userId }, draft, {
        active,
        send,
        read,
        refresh,
      }),
    { initialProps: { active: true, userId: "user", orgId: "org" }, wrapper },
  );
}
function forKind(kind) {
  return kind === "create"
    ? { ...newCrewDraft(), fields: initial.fields }
    : crewDraftFromSnapshot(kind, snapshot);
}
beforeEach(() => {
  client = new QueryClient();
  send = vi.fn(async (command) => reply(command));
  refresh = vi.fn(async () => {});
  read = vi.fn(async () => ({
    orgId: "org",
    userId: "user",
    id: "crew",
    snapshot,
  }));
});
afterEach(() => {
  cleanup();
  client.clear();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});
const start = (view) => act(() => view.result.current.submit());
const failed = (view) =>
  waitFor(() => expect(view.result.current.attempt.kind).toBe("failed"));
const settled = (view) =>
  waitFor(() =>
    expect(view.result.current.attempt).toMatchObject({
      kind: "confirmed",
      refresh: "done",
    }),
  );
it.each(["create", "update", "delete"])(
  "retains native crew %s and retries the exact request after closing",
  async (kind) => {
    send.mockRejectedValueOnce(new Error("Reply lost"));
    const view = setup(forKind(kind));
    act(() => view.result.current.setFields({ name: "Edited name" }));
    start(view);
    start(view);
    await failed(view);
    view.unmount();
    const next = setup(forKind(kind));
    expect(next.result.current.draft.fields.name).toBe("Edited name");
    act(() => next.result.current.setFields({ name: "Unsafe replacement" }));
    start(next);
    expect(next.result.current.discard()).toBe(false);
    act(() => next.result.current.loadCurrent());
    expect(read).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    act(() => next.result.current.retry());
    await settled(next);
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
    if (kind !== "delete")
      expect(send.mock.calls[0][0].name).toBe("Edited name");
    if (kind !== "create")
      expect(send.mock.calls[0][0].expectedRevision).toBe(3);
  },
);
it("shares edit and delete slots without replacing an unsent draft", () => {
  const view = setup();
  act(() => view.result.current.setFields({ name: "Keep this" }));
  view.unmount();
  const next = setup(forKind("delete"));
  expect(next.result.current.draft).toMatchObject({
    kind: "update",
    fields: { name: "Keep this" },
  });
});
it("keeps different crew drafts separate and exposes only the current account's drafts", async () => {
  const list = renderHook(
    () => useCrewDrafts({ orgId: "org", userId: "user" }),
    { wrapper },
  );
  const other = renderHook(
    () => useCrewDrafts({ orgId: "org", userId: "other" }),
    { wrapper },
  );
  setup();
  setup(crewDraftFromSnapshot("delete", { ...snapshot, id: "second" }));
  setup(newCrewDraft());
  await waitFor(() => expect(list.result.current).toHaveLength(3));
  expect(other.result.current).toHaveLength(0);
  expect(list.result.current.map((d) => d.slot).sort()).toEqual([
    "crew",
    "new",
    "second",
  ]);
});
it.each(["create", "update", "delete"])(
  "review cancels an unapplied %s before editing with a new request ID",
  async (kind) => {
    send.mockRejectedValueOnce(new Error("Unconfirmed"));
    const view = setup(forKind(kind));
    start(view);
    await failed(view);
    act(() => view.result.current.editCancelled());
    expect(view.result.current.locked).toBe(true);
    send.mockImplementationOnce(async (command) => reply(command, "cancelled"));
    act(() => view.result.current.review());
    await settled(view);
    expect(send.mock.calls[1][1]).toBe(true);
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
    act(() => view.result.current.editCancelled());
    act(() => view.result.current.setFields({ name: "Reviewed name" }));
    start(view);
    await settled(view);
    expect(send.mock.calls[2][0].requestId).not.toBe(
      send.mock.calls[0][0].requestId,
    );
    if (kind !== "delete")
      expect(send.mock.calls[2][0].name).toBe("Reviewed name");
  },
);
it.each(["create", "update", "delete"])(
  "preserves a confirmed %s after refresh failure without resending",
  async (kind) => {
    refresh.mockRejectedValueOnce(new Error("Read failed"));
    const view = setup(forKind(kind));
    start(view);
    await waitFor(() =>
      expect(view.result.current.attempt.refresh).toBe("failed"),
    );
    expect(view.result.current.discard()).toBe(false);
    act(() => view.result.current.retry());
    act(() => view.result.current.review());
    expect(send).toHaveBeenCalledTimes(1);
    act(() => view.result.current.refresh());
    await settled(view);
    expect(send).toHaveBeenCalledTimes(1);
    act(() => {
      expect(view.result.current.discard()).toBe(true);
      view.unmount();
    });
    expect(
      client.getQueryData([
        "mobile-crew-draft",
        "user",
        "org",
        forKind(kind).slot,
      ]),
    ).toBeNull();
    const next = setup(forKind(kind));
    expect(next.result.current.attempt).toBeUndefined();
  },
);
it.each(["create", "update", "delete"])(
  "bounds stuck %s requests and a stuck review at 15 seconds",
  async (kind) => {
    vi.useFakeTimers();
    send.mockImplementation(() => new Promise(() => {}));
    const view = setup(forKind(kind));
    start(view);
    await act(() => vi.advanceTimersByTimeAsync(15001));
    expect(view.result.current.attempt.kind).toBe("failed");
    expect(send.mock.calls[0][2].aborted).toBe(true);
    act(() => view.result.current.review());
    await act(() => vi.advanceTimersByTimeAsync(15001));
    expect(view.result.current.attempt.kind).toBe("failed");
    expect(send.mock.calls[1][2].aborted).toBe(true);
    expect(view.result.current.discard()).toBe(false);
  },
);
it("bounds a stuck roster refresh and retains the saved result", async () => {
  vi.useFakeTimers();
  refresh.mockImplementationOnce(() => new Promise(() => {}));
  const view = setup();
  start(view);
  await act(() => vi.advanceTimersByTimeAsync(12001));
  expect(view.result.current.attempt).toMatchObject({
    kind: "confirmed",
    result: { outcome: "applied" },
    refresh: "failed",
  });
  expect(refresh.mock.calls[0][0].aborted).toBe(true);
  act(() => view.result.current.refresh());
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(view.result.current.attempt.refresh).toBe("done");
  expect(send).toHaveBeenCalledTimes(1);
});
it("reports offline failure without pausing the request indefinitely", async () => {
  onlineManager.setOnline(false);
  send.mockRejectedValueOnce(new Error("Offline"));
  const view = setup();
  start(view);
  await failed(view);
  expect(view.result.current.attempt.command).toMatchObject({
    kind: "update",
    id: "crew",
  });
  expect(view.result.current.attempt.message).toBe("Offline");
});
it("loads a current revision only when requested and preserves an unresolved request", async () => {
  send.mockRejectedValueOnce(new Error("Profile changed"));
  const view = setup();
  act(() => view.result.current.setFields({ name: "My draft" }));
  start(view);
  await failed(view);
  act(() => view.result.current.loadCurrent());
  expect(read).not.toHaveBeenCalled();
  send.mockImplementationOnce(async (command) => reply(command, "cancelled"));
  act(() => view.result.current.review());
  await settled(view);
  expect(view.result.current.draft.fields.name).toBe("My draft");
  const current = { ...snapshot, name: "Another operator", profileRevision: 7 };
  read.mockResolvedValueOnce({
    orgId: "org",
    userId: "user",
    id: "crew",
    snapshot: current,
  });
  act(() => view.result.current.loadCurrent());
  await waitFor(() =>
    expect(view.result.current.draft.base.profileRevision).toBe(7),
  );
  expect(view.result.current.draft.fields.name).toBe("Another operator");
  start(view);
  await settled(view);
  expect(send.mock.calls[2][0].expectedRevision).toBe(7);
  expect(send.mock.calls[2][0].requestId).not.toBe(
    send.mock.calls[0][0].requestId,
  );
});
it("bounds current reads and keeps the draft if the crew member is gone", async () => {
  vi.useFakeTimers();
  read.mockImplementationOnce(() => new Promise(() => {}));
  const view = setup();
  act(() => view.result.current.loadCurrent());
  expect(view.result.current.discard()).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(8001));
  expect(view.result.current.reading).toBe(false);
  expect(view.result.current.error).toBeTruthy();
  expect(view.result.current.draft).toEqual(initial);
  vi.useRealTimers();
  read.mockResolvedValueOnce({
    orgId: "org",
    userId: "user",
    id: "crew",
    snapshot: null,
  });
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(view.result.current.error).toMatch(/no longer/));
  expect(view.result.current.draft).toEqual(initial);
});
it("does not load a deleted profile after confirmed removal", async () => {
  const view = setup(forKind("delete"));
  start(view);
  await settled(view);
  act(() => view.result.current.loadCurrent());
  expect(read).not.toHaveBeenCalled();
});
it.each(["orgId", "userId", "requestId", "id", "kind"])(
  "does not accept a reply with another %s",
  async (field) => {
    send.mockImplementationOnce(async (command) => ({
      ...reply(command),
      [field]:
        field === "kind"
          ? "delete"
          : field === "requestId"
            ? crypto.randomUUID()
            : "other",
    }));
    const view = setup();
    start(view);
    await failed(view);
    expect(refresh).not.toHaveBeenCalled();
    expect(view.result.current.discard()).toBe(false);
  },
);
it.each(["orgId", "userId", "id", "snapshot"])(
  "rejects a current-profile read with another %s",
  async (field) => {
    read.mockResolvedValueOnce({
      orgId: "org",
      userId: "user",
      id: "crew",
      snapshot,
      [field]: field === "snapshot" ? { ...snapshot, id: "other" } : "other",
    });
    const view = setup();
    act(() => view.result.current.loadCurrent());
    await waitFor(() => expect(view.result.current.error).toMatch(/changed/));
    expect(view.result.current.draft).toEqual(initial);
  },
);
it("ignores a late current read after focus changes", async () => {
  let resolve;
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = setup();
  act(() => view.result.current.loadCurrent());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender({ active: false, userId: "user", orgId: "org" });
  await act(async () =>
    resolve({
      orgId: "org",
      userId: "user",
      id: "crew",
      snapshot: { ...snapshot, name: "Late" },
    }),
  );
  expect(view.result.current.draft.fields.name).toBe("Original");
});
it("records a late result only in the original account and refreshes on explicit resume", async () => {
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
  view.rerender({ active: true, userId: "other", orgId: "org" });
  await act(async () => resolve());
  expect(view.result.current.attempt).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender({ active: true, userId: "user", orgId: "org" });
  expect(view.result.current.attempt).toMatchObject({
    kind: "confirmed",
    refresh: "idle",
  });
  act(() => view.result.current.refresh());
  await settled(view);
  expect(send).toHaveBeenCalledTimes(1);
});
it("retains a closed unsent draft past normal cache collection", async () => {
  vi.useFakeTimers();
  const view = setup();
  act(() => view.result.current.setFields({ name: "Retained" }));
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(3600000));
  const next = setup();
  expect(next.result.current.draft.fields.name).toBe("Retained");
});
it("bounds native photo preparation that never settles", async () => {
  vi.useFakeTimers();
  const result = expect(
    prepareCrewPhoto(() => new Promise(() => {})),
  ).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
