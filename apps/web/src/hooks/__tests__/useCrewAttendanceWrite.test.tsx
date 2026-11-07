import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCrewAttendanceWrite } from "../useCrewAttendanceWrite";
import { changeCrewAttendance } from "@/lib/crew-attendance";
import { crewAttendanceWriteSchema, type CrewAttendanceResult, type CrewAttendanceWrite } from "@/lib/crew-attendance-writes";
vi.mock("@/lib/crew-attendance", () => ({ changeCrewAttendance: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
const operation = { isOnline: true, members: [{ id: "crew-a", expectedRevision: "a".repeat(64) }] };
function transport() {
  const requests: { input: CrewAttendanceWrite; signal: AbortSignal | undefined; resolve: (result: CrewAttendanceResult) => void }[] = [];
  vi.mocked(changeCrewAttendance).mockImplementation(options => new Promise(resolve => requests.push({ input: crewAttendanceWriteSchema.parse(options && "data" in options ? options.data : undefined), signal: options?.signal, resolve })));
  const ack = (index: number, outcome: "applied" | "conflict" = "applied") => requests[index].resolve({ requestId: requests[index].input.requestId, outcome, changedCount: outcome === "applied" ? 1 : 0 });
  return { requests, ack };
}
it("bounds lost acknowledgements, retains the exact request and ignores an old reply", async () => {
  vi.useFakeTimers(); const wire = transport(); const { result } = renderHook(() => useCrewAttendanceWrite("org-a"));
  let pending = Promise.resolve<unknown>(null);
  act(() => { pending = result.current.run(operation); });
  expect(await result.current.run({ ...operation, isOnline: false })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); expect(await pending).toBeNull(); });
  expect(wire.requests[0].signal?.aborted).toBe(true);
  expect(result.current.state).toMatchObject({ kind: "uncertain", failure: { occurredAt: Date.now() } });
  await act(async () => wire.ack(0)); expect(result.current.state.kind).toBe("uncertain");
  act(() => { pending = result.current.run(); });
  expect(wire.requests[1].input).toEqual(wire.requests[0].input);
  await act(async () => { wire.ack(1); await pending; }); expect(result.current.state.kind).toBe("idle");
});
it("requires conflict review before creating a new request", async () => {
  const wire = transport(); const { result } = renderHook(() => useCrewAttendanceWrite("org-a"));
  let pending = Promise.resolve<unknown>(null); act(() => { pending = result.current.run(operation); });
  await act(async () => { wire.ack(0, "conflict"); await pending; });
  expect(result.current.state.kind).toBe("conflict"); expect(await result.current.run()).toBeNull(); expect(await result.current.run(operation)).toBeNull();
  act(() => result.current.clearConflict()); act(() => { pending = result.current.run(operation); });
  expect(wire.requests[1].input.requestId).not.toBe(wire.requests[0].input.requestId);
  await act(async () => { wire.ack(1); await pending; });
});
it("cancels old organization work and ignores late acknowledgement after switching", async () => {
  const wire = transport(); const { result, rerender, unmount } = renderHook(({ orgId }) => useCrewAttendanceWrite(orgId), { initialProps: { orgId: "org-a" } });
  act(() => { void result.current.run(operation); }); rerender({ orgId: "org-b" });
  expect(wire.requests[0].signal?.aborted).toBe(true); expect(result.current.state.kind).toBe("idle");
  await act(async () => wire.ack(0)); expect(result.current.state.kind).toBe("idle");
  act(() => { void result.current.run(operation); }); expect(wire.requests[1].input.orgId).toBe("org-b");
  unmount(); expect(wire.requests[1].signal?.aborted).toBe(true);
});
it("rejects an acknowledgement for another request", async () => {
  const wire = transport(); const { result } = renderHook(() => useCrewAttendanceWrite("org-a"));
  let pending = Promise.resolve<unknown>(null); act(() => { pending = result.current.run(operation); });
  await act(async () => { wire.requests[0].resolve({ requestId: crypto.randomUUID(), outcome: "applied", changedCount: 1 }); await pending; });
  expect(result.current.state.kind).toBe("uncertain");
});
