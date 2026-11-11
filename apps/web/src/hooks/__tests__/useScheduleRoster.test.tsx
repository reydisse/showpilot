import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScheduleRoster } from "../useScheduleRoster";
import type { getServiceAssignments } from "@/lib/schedule";
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/schedule", () => ({ getServiceAssignments: api.read }));
type Row = Awaited<ReturnType<typeof getServiceAssignments>>[number];
function row(id: string, showId = "show-a"): Row {
  return {
    id,
    orgId: "org-1",
    showId,
    serviceDate: "2099-01-01",
    crewMemberId: null,
    assignedByUserId: null,
    role: id,
    department: "Production",
    status: "assigned",
    callTime: "",
    notes: "",
    responseNote: "",
    invitedAt: null,
    respondedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    crewMember: null,
    effectiveCallTime: null,
    canRespond: false,
    responseWindow: { status: "open", closesAt: "2099-01-02T00:00:00Z" },
  };
}
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const base = { orgId: "org-1", userId: "user-1", showId: "show-a" };
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("keeps the selected confirmed roster visible when polling stalls and ignores the late reply", async () => {
  const pending = held<Row[]>(),
    initial = row("Original"),
    latest = row("Confirmed later");
  api.read.mockReturnValueOnce(pending.promise).mockResolvedValue([latest]);
  const { result } = renderHook(() =>
    useScheduleRoster({
      ...base,
      assignments: [initial, row("Other show", "show-b")],
    }),
  );
  await tick(8_000);
  expect(result.current.value).toEqual([initial]);
  expect(result.current.error?.message).toContain("Roster refresh failed");
  act(() => result.current.retry());
  await tick();
  expect(result.current.value).toEqual([latest]);
  await act(async () => pending.resolve([row("Late stale reply")]));
  expect(result.current.value).toEqual([latest]);
  expect(api.read.mock.calls[0][0].signal.aborted).toBe(true);
});
it("retires a pre-write read immediately when the loader supplies a newer roster", async () => {
  const pending = held<Row[]>(),
    old = row("Before write"),
    saved = row("Saved assignment");
  api.read.mockReturnValueOnce(pending.promise).mockResolvedValue([saved]);
  const { result, rerender } = renderHook(
    ({ assignments }) => useScheduleRoster({ ...base, assignments }),
    { initialProps: { assignments: [old] } },
  );
  await tick();
  rerender({ assignments: [saved] });
  expect(result.current.value).toEqual([saved]);
  expect(api.read.mock.calls[0][0].signal.aborted).toBe(true);
  await tick();
  await act(async () => pending.resolve([old]));
  expect(result.current.value).toEqual([saved]);
});
it("does not mix another show's or account's response into the active roster", async () => {
  const pending = held<Row[]>(),
    a = row("Show A"),
    b = row("Show B", "show-b");
  api.read.mockReturnValueOnce(pending.promise).mockResolvedValue([b]);
  const { result, rerender } = renderHook(
    (props) => useScheduleRoster({ ...props, assignments: [a, b] }),
    { initialProps: base },
  );
  await tick();
  rerender({ ...base, userId: "user-2", showId: "show-b" });
  expect(result.current.value).toEqual([b]);
  await tick();
  await act(async () => pending.resolve([a]));
  expect(result.current.value).toEqual([b]);
  expect(api.read.mock.calls[1][0].data).toEqual({
    orgId: "org-1",
    showId: "show-b",
  });
});
it("does not poll without a selected show or restart for an equivalent loader snapshot", async () => {
  const a = row("Audio");
  api.read.mockResolvedValue([a]);
  const initialProps: { showId: string | undefined; assignments: Row[] } = {
    showId: undefined,
    assignments: [a],
  };
  const { result, rerender } = renderHook(
    ({
      showId,
      assignments,
    }: {
      showId: string | undefined;
      assignments: Row[];
    }) => useScheduleRoster({ ...base, showId, assignments }),
    { initialProps },
  );
  await tick(60_000);
  expect(api.read).not.toHaveBeenCalled();
  expect(result.current.value).toEqual([]);
  rerender({ showId: "show-a", assignments: [a] });
  await tick();
  expect(api.read).toHaveBeenCalledTimes(1);
  rerender({ showId: "show-a", assignments: [{ ...a }] });
  await tick();
  expect(api.read).toHaveBeenCalledTimes(1);
});
