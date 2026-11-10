import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProPresenterCommands } from "../useProPresenterCommands";
const mocks = vi.hoisted(() => ({ slide: vi.fn(), output: vi.fn() }));
vi.mock("@/lib/rundown", () => ({ sendProPresenterCommand: mocks.slide, setProPresenterStageDisplay: mocks.output }));
const options = { orgId: "org", scope: "org:show:target", canControlSlides: true, canChangeOutput: true };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.slide.mockResolvedValue({ ok: true }); mocks.output.mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("requires acknowledgement and synchronously prevents duplicate or overlapping actions", async () => {
  let finish!: (value: { ok: boolean }) => void;
  mocks.slide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useProPresenterCommands(options));
  let first!: Promise<void>;
  act(() => { first = result.current.run({ kind: "slide", command: "next" }); void result.current.run({ kind: "slide", command: "next" }); void result.current.run({ kind: "output", enabled: true }); });
  expect(mocks.slide).toHaveBeenCalledOnce(); expect(mocks.output).not.toHaveBeenCalled();
  expect(result.current.notice).toBeNull(); expect(result.current.pending).toEqual({ kind: "slide", command: "next" });
  expect(mocks.slide).toHaveBeenCalledWith({ data: { orgId: "org", command: "next" }, signal: expect.any(AbortSignal) });
  await act(async () => { finish({ ok: true }); await first; });
  expect(result.current.pending).toBeNull(); expect(result.current.notice).toBe("Next slide confirmed.");
});

it.each([{ ok: false, error: "Device rejected" }, {}, undefined])("treats a missing or negative acknowledgement as unconfirmed: %j", async acknowledgement => {
  mocks.slide.mockResolvedValueOnce(acknowledgement);
  const { result } = renderHook(() => useProPresenterCommands(options));
  await act(async () => result.current.run({ kind: "slide", command: "clear" }));
  expect(result.current.notice).toBeNull(); expect(result.current.failure?.message).toContain("Clear slide was not confirmed");
  expect(result.current.failure?.occurredAt).toBe(Date.now());
  await act(async () => result.current.run({ kind: "slide", command: "clear" }));
  expect(mocks.slide).toHaveBeenCalledOnce();
  act(() => result.current.acknowledgeReview());
  expect(mocks.slide).toHaveBeenCalledOnce(); expect(result.current.failure).toBeNull();
  await act(async () => result.current.run({ kind: "slide", command: "previous" }));
  expect(mocks.slide).toHaveBeenCalledTimes(2); expect(result.current.notice).toBe("Previous slide confirmed.");
});

it("times out a stalled action, aborts the request and never treats a late acknowledgement as success", async () => {
  let finish!: (value: { ok: boolean }) => void;
  mocks.slide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useProPresenterCommands(options));
  let first!: Promise<void>;
  act(() => { first = result.current.run({ kind: "slide", command: "next" }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); await first; });
  expect(mocks.slide.mock.calls[0][0].signal.aborted).toBe(true);
  expect(result.current.pending).toBeNull(); expect(result.current.failure?.message).toContain("Confirmation timed out");
  const failure = result.current.failure;
  await act(async () => { finish({ ok: true }); await vi.advanceTimersByTimeAsync(60_000); });
  expect(mocks.slide).toHaveBeenCalledOnce(); expect(result.current.notice).toBeNull(); expect(result.current.failure).toEqual(failure);
});

it("reports a lost kiosk response and never toggles it again during review", async () => {
  mocks.output.mockRejectedValueOnce(new TypeError("Transport internals must not appear in operator copy"));
  const { result } = renderHook(() => useProPresenterCommands(options));
  await act(async () => result.current.run({ kind: "output", enabled: true }));
  expect(mocks.output).toHaveBeenCalledWith({ data: { orgId: "org", enabled: true }, signal: expect.any(AbortSignal) });
  expect(result.current.failure?.message).toContain("Kiosk output change was not confirmed");
  expect(result.current.failure?.message).not.toContain("Transport internals");
  act(() => result.current.acknowledgeReview());
  expect(mocks.output).toHaveBeenCalledOnce();
  await act(async () => result.current.run({ kind: "output", enabled: false }));
  expect(result.current.notice).toBe("Kiosk output change confirmed.");
});

it("aborts an old scope and ignores its completion while a new operation is pending", async () => {
  let oldFinish!: (value: { ok: boolean }) => void;
  let newFinish!: (value: { ok: boolean }) => void;
  mocks.slide.mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { newFinish = resolve; }));
  const { result, rerender, unmount } = renderHook(props => useProPresenterCommands(props), { initialProps: options });
  act(() => { void result.current.run({ kind: "slide", command: "next" }); });
  const oldSignal = mocks.slide.mock.calls[0][0].signal;
  rerender({ ...options, orgId: "other", scope: "other:show:target" });
  expect(oldSignal.aborted).toBe(true); expect(result.current.pending).toBeNull();
  act(() => { void result.current.run({ kind: "slide", command: "previous" }); });
  await act(async () => oldFinish({ ok: true }));
  expect(result.current.pending).toEqual({ kind: "slide", command: "previous" }); expect(result.current.notice).toBeNull();
  const newSignal = mocks.slide.mock.calls[1][0].signal;
  unmount(); expect(newSignal.aborted).toBe(true);
  await act(async () => newFinish({ ok: true }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.slide).toHaveBeenCalledTimes(2);
});

it("does not send when live access is unavailable", async () => {
  const { result } = renderHook(() => useProPresenterCommands({ ...options, canControlSlides: false, canChangeOutput: false }));
  await act(async () => { await result.current.run({ kind: "slide", command: "next" }); await result.current.run({ kind: "output", enabled: true }); });
  expect(mocks.slide).not.toHaveBeenCalled(); expect(mocks.output).not.toHaveBeenCalled();
  expect(result.current.pending).toBeNull(); expect(result.current.notice).toBeNull();
});
