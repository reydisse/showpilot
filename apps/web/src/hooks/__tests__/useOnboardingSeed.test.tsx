import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOnboardingSeed } from "../useOnboardingSeed";
import type { OnboardingSeedSnapshot } from "@/lib/onboarding-seed-contract";
const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/onboarding", () => ({ getOnboardingSeed: api.get, seedOrgTemplate: api.save }));
const saved: OnboardingSeedSnapshot = { status: "saved", template: "sunday", serviceDate: "2026-11-07", showId: "show", items: [{ id: "one", title: "First cue", duration: 60000 }] };
async function mount() { const hook = renderHook(() => useOnboardingSeed("org")); await act(async () => {}); return hook; }
beforeEach(() => { api.get.mockResolvedValue({ status: "empty" }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it("refresh only reads, including an already saved or damaged result", async () => {
  api.get.mockResolvedValue(saved); const f = await mount(); expect(f.result.current.snapshot).toEqual(saved); expect(api.save).not.toHaveBeenCalled();
  api.get.mockResolvedValue({ status: "review", message: "Review existing data" }); await act(async () => f.result.current.check());
  expect(f.result.current.snapshot?.status).toBe("review"); expect(api.save).not.toHaveBeenCalled();
});
it("bounds initial reads and recovers through a read-only retry", async () => {
  vi.useFakeTimers(); api.get.mockImplementationOnce(() => new Promise(() => {}));
  const f = await mount(); await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(f.result.current.busy).toBe(false); expect(f.result.current.failure?.occurredAt).toEqual(expect.any(Number)); expect(api.get.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => f.result.current.retry()); expect(f.result.current.snapshot).toEqual({ status: "empty" }); expect(api.save).not.toHaveBeenCalled();
});
it("recovers a committed but lost response without replaying or accepting a late reply", async () => {
  vi.useFakeTimers(); let resolve: (value: OnboardingSeedSnapshot) => void = () => {};
  api.save.mockImplementation(() => new Promise<OnboardingSeedSnapshot>(yes => { resolve = yes; }));
  const f = await mount(); act(() => { void f.result.current.save("sunday"); });
  await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(f.result.current.failure?.message).toContain("may have finished");
  api.get.mockResolvedValue(saved); await act(async () => f.result.current.check()); expect(f.result.current.snapshot).toEqual(saved);
  await act(async () => resolve({ status: "empty" })); expect(f.result.current.snapshot).toEqual(saved); expect(api.save).toHaveBeenCalledTimes(1); expect(f.result.current.failure).toBeNull();
});
it("retries the captured date and template after midnight", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T23:59:59")); api.save.mockRejectedValueOnce(new Error("Lost"));
  const f = await mount(); await act(async () => f.result.current.save("sunday")); const input = api.save.mock.calls[0][0].data;
  vi.setSystemTime(new Date("2026-11-08T00:00:01")); api.save.mockResolvedValue(saved); await act(async () => f.result.current.retry());
  expect(api.save.mock.calls[1][0].data).toEqual(input);
});
it("suppresses synchronous double submits and ignores replies after organization change", async () => {
  let resolve: (value: OnboardingSeedSnapshot) => void = () => {};
  api.save.mockImplementation(() => new Promise<OnboardingSeedSnapshot>(yes => { resolve = yes; }));
  const f = renderHook(({ orgId }) => useOnboardingSeed(orgId), { initialProps: { orgId: "first" } }); await act(async () => {});
  act(() => { void f.result.current.save("sunday"); void f.result.current.save("youth"); }); expect(api.save).toHaveBeenCalledTimes(1);
  f.rerender({ orgId: "second" }); await act(async () => {}); expect(api.save.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => resolve(saved)); expect(f.result.current.snapshot).toEqual({ status: "empty" }); expect(f.result.current.requested).toBeNull();
});
it("allows an explicit blank request but shows a competing saved template honestly", async () => {
  api.save.mockRejectedValueOnce(new Error("Lost")); const f = await mount(); await act(async () => f.result.current.save("sunday"));
  api.save.mockResolvedValue(saved); await act(async () => f.result.current.save("blank"));
  expect(api.save.mock.calls[1][0].data.template).toBe("blank"); expect(f.result.current.snapshot).toEqual(saved); expect(f.result.current.requested?.template).toBe("blank");
});
it("rejects malformed or empty write acknowledgements", async () => {
  const f = await mount(); for (const reply of [undefined, { status: "empty" }, { ...saved, items: null }]) {
    api.save.mockResolvedValue(reply); await act(async () => f.result.current.save("sunday")); expect(f.result.current.failure).not.toBeNull(); expect(f.result.current.snapshot).toEqual({ status: "empty" });
  }
});
it("aborts the current call on unmount", async () => {
  api.get.mockImplementationOnce(() => new Promise(() => {})); const f = await mount(); f.unmount(); expect(api.get.mock.calls[0][0].signal.aborted).toBe(true);
});
