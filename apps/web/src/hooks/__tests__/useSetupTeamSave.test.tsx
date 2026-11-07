import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSetupTeamSave } from "../useSetupTeamSave";
import type { SetupSnapshot, SetupTeamInput } from "@/lib/setup-save-contract";
const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), send: vi.fn(), finish: vi.fn() }));
vi.mock("@/lib/setup-save", () => ({ getSetupTeam: api.get, saveSetupTeam: api.save, sendSetupInvitation: api.send, finishSetupTeam: api.finish }));
const empty: SetupSnapshot = { batch: null, invitations: [], completed: false };
const team = { crew: [{ name: "Fixture", pos: "Camera" }], invites: [] };
function saved(input: Pick<SetupTeamInput, "crew" | "invites"> = team, batchId: string = crypto.randomUUID()): SetupSnapshot {
  return { batch: { batchId, actorId: "owner", crew: input.crew.map(row => ({ ...row, id: crypto.randomUUID(), memberId: "FX1234" })), invites: input.invites }, invitations: input.invites.map(() => null), completed: false };
}
async function mount() {
  const done = vi.fn(); const hook = renderHook(() => useSetupTeamSave("fixture-org", done));
  await act(async () => {}); return { ...hook, done };
}
beforeEach(() => { api.get.mockResolvedValue(empty); api.finish.mockImplementation(({ data }: { data: { batchId: string } }) => Promise.resolve({ ok: true, batchId: data.batchId })); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it("does not complete after a crew transaction failure and retries the same captured request", async () => {
  api.save.mockRejectedValueOnce(new Error("Database unavailable"));
  const f = await mount(); await act(async () => f.result.current.save(team));
  expect(api.send).not.toHaveBeenCalled(); expect(api.finish).not.toHaveBeenCalled(); expect(f.done).not.toHaveBeenCalled();
  expect(f.result.current.failure?.message).toContain("not confirmed"); expect(f.result.current.frozen).toBe(true);
  const original = api.save.mock.calls[0][0].data;
  api.save.mockResolvedValue(saved(team, original.batchId)); await act(async () => f.result.current.save());
  expect(api.save.mock.calls[1][0].data).toEqual(original); expect(f.done).toHaveBeenCalledTimes(1);
});
it("ignores a late save acknowledgement after timeout, then reloads its durable result", async () => {
  vi.useFakeTimers(); let resolve: (value: SetupSnapshot) => void = () => {};
  api.save.mockImplementation(() => new Promise<SetupSnapshot>(yes => { resolve = yes; }));
  const f = await mount(); act(() => { void f.result.current.save(team); });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(f.result.current.failure).not.toBeNull(); expect(api.save.mock.calls[0][0].signal.aborted).toBe(true);
  const result = saved(team, api.save.mock.calls[0][0].data.batchId);
  await act(async () => resolve(result)); expect(f.result.current.snapshot).toEqual(empty); expect(api.finish).not.toHaveBeenCalled();
  api.get.mockResolvedValue(result); await act(async () => f.result.current.check());
  expect(f.result.current.snapshot).toEqual(result); expect(api.save).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.finish()); expect(f.done).toHaveBeenCalledTimes(1);
});
it("retains partial invitation results and explicitly retries only the selected invitation", async () => {
  const input = { ...team, invites: [{ email: "one@example.test", role: "member" as const }, { email: "two@example.test", role: "td" as const }] };
  const f = await mount(); let state = saved(input);
  api.save.mockImplementation(({ data }: { data: SetupTeamInput }) => { state = saved(input, data.batchId); return Promise.resolve(state); });
  api.send.mockImplementation(({ data }: { data: { index: number; attemptId: string } }) => {
    state = { ...state, invitations: state.invitations.map((job, index) => index === data.index ? { state: index === 0 ? "accepted" : "failed", invitationId: `invitation-${index}`, attemptId: data.attemptId, occurredAt: Date.now() } : job) };
    return Promise.resolve(state);
  });
  await act(async () => f.result.current.save(input)); expect(api.finish).not.toHaveBeenCalled(); expect(f.done).not.toHaveBeenCalled();
  const failed = state.invitations[1];
  api.send.mockImplementation(({ data }: { data: { attemptId: string } }) => Promise.resolve({ ...state, invitations: [state.invitations[0], { ...failed, state: "accepted", attemptId: data.attemptId }] }));
  await act(async () => f.result.current.send(1));
  expect(api.send.mock.calls[2][0].data).toMatchObject({ index: 1, previousAttemptId: failed?.attemptId });
  expect(api.send.mock.calls.map(call => call[0].data.index)).toEqual([0, 1, 1]); expect(api.save).toHaveBeenCalledTimes(1);
  await act(async () => f.result.current.finish()); expect(f.done).toHaveBeenCalledTimes(1);
});
it("does not resend people when completion fails or its acknowledgement is missing", async () => {
  const f = await mount(); api.save.mockImplementation(({ data }: { data: SetupTeamInput }) => Promise.resolve(saved(team, data.batchId)));
  api.finish.mockResolvedValueOnce({ ok: false }); await act(async () => f.result.current.save(team));
  expect(f.done).not.toHaveBeenCalled(); expect(f.result.current.snapshot?.batch).not.toBeNull();
  await act(async () => f.result.current.finish()); expect(f.done).toHaveBeenCalledTimes(1); expect(api.save).toHaveBeenCalledTimes(1); expect(api.send).not.toHaveBeenCalled();
});
it("loads an existing setup without replaying any writes", async () => {
  const state = saved({ ...team, invites: [{ email: "lead@example.test", role: "member" }] }); api.get.mockResolvedValue(state);
  const f = await mount(); expect(f.result.current.snapshot).toEqual(state);
  expect(api.save).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled(); expect(api.finish).not.toHaveBeenCalled(); expect(f.done).not.toHaveBeenCalled();
});
it("bounds initial reads and preserves the error until an explicit check", async () => {
  vi.useFakeTimers(); api.get.mockImplementationOnce(() => new Promise(() => {}));
  const f = await mount(); await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(f.result.current.snapshot).toBeNull(); expect(f.result.current.failure?.occurredAt).toEqual(expect.any(Number)); expect(api.save).not.toHaveBeenCalled();
  api.get.mockResolvedValue(empty); await act(async () => f.result.current.check()); expect(f.result.current.snapshot).toEqual(empty); expect(f.result.current.failure).toBeNull();
});
it("cancels on unmount and suppresses duplicate submissions before a render", async () => {
  let resolve: (value: SetupSnapshot) => void = () => {};
  api.save.mockImplementation(() => new Promise<SetupSnapshot>(yes => { resolve = yes; }));
  const f = await mount(); act(() => { void f.result.current.save(team); void f.result.current.save(team); });
  expect(api.save).toHaveBeenCalledTimes(1); f.unmount(); expect(api.save.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => resolve(saved(team, api.save.mock.calls[0][0].data.batchId)));
  expect(api.send).not.toHaveBeenCalled(); expect(api.finish).not.toHaveBeenCalled(); expect(f.done).not.toHaveBeenCalled();
});
it("reviews a competing tab's saved batch instead of claiming the current draft was saved", async () => {
  const other = saved({ crew: [{ name: "Other owner draft", pos: "Lighting" }], invites: [] }); api.save.mockResolvedValue(other);
  const f = await mount(); await act(async () => f.result.current.save(team));
  expect(f.result.current.snapshot).toEqual(other); expect(f.result.current.failure?.message).toContain("Your draft was not applied"); expect(api.finish).not.toHaveBeenCalled();
});
it("rejects an incomplete save acknowledgement", async () => {
  api.save.mockResolvedValue(empty); const f = await mount(); await act(async () => f.result.current.save(team));
  expect(f.result.current.failure).not.toBeNull(); expect(api.send).not.toHaveBeenCalled(); expect(api.finish).not.toHaveBeenCalled();
});
