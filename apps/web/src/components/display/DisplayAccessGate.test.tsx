import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ ensure: vi.fn(), mounted: vi.fn() }));
vi.mock("@/lib/display-access", () => ({ ensureDisplaySession: api.ensure }));
import { DisplayAccessGate } from "./DisplayAccessGate";
function PrivateDisplay() { useEffect(() => { api.mounted(); }, []); return <p>Private stage message</p>; }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); window.history.replaceState(null, "", "/timer/venue");
  api.ensure.mockResolvedValue({ authorized: true, expiresAt: Date.now() + 3_600_000 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("display access gate", () => {
  it("does not mount display data requests before authorization completes", async () => {
    let finish: (result: { authorized: false }) => void = () => {};
    api.ensure.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<DisplayAccessGate orgSlug="venue" surface="timer"><PrivateDisplay /></DisplayAccessGate>);
    expect(api.mounted).not.toHaveBeenCalled();
    await act(async () => { finish({ authorized: false }); });
    expect(screen.getByRole("alert").textContent).toContain("valid link");
    expect(screen.queryByText("Private stage message")).toBeNull();
  });
  it("exchanges the URL pass once and preserves the mounted display during access refresh", async () => {
    window.history.replaceState(null, "", "/timer/venue?displayPass=fixture&output=clean");
    await act(async () => { render(<DisplayAccessGate orgSlug="venue" surface="timer"><PrivateDisplay /></DisplayAccessGate>); });
    expect(api.ensure).toHaveBeenCalledWith({ data: { orgSlug: "venue", surface: "timer", token: "fixture" }, signal: expect.any(AbortSignal) });
    expect(window.location.search).toBe("?output=clean");
    expect(screen.getByText("Private stage message")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.ensure).toHaveBeenLastCalledWith({ data: { orgSlug: "venue", surface: "timer", token: undefined }, signal: expect.any(AbortSignal) });
    expect(api.mounted).toHaveBeenCalledTimes(1);
  });
  it("removes displayed content when renewed access is rejected", async () => {
    await act(async () => { render(<DisplayAccessGate orgSlug="venue" surface="timer"><PrivateDisplay /></DisplayAccessGate>); });
    api.ensure.mockResolvedValue({ authorized: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText("Private stage message")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("valid link");
  });
});


describe("display access deadlines", () => {
  it("ends an initial stalled check and ignores its late authorization after Retry", async () => {
    let finishOld: (result: { authorized: true; expiresAt: number }) => void = () => {};
    api.ensure.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    render(<DisplayAccessGate orgSlug="venue" surface="overlay"><PrivateDisplay /></DisplayAccessGate>);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("could not be checked");
    api.ensure.mockResolvedValue({ authorized: false });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(screen.getByRole("alert").textContent).toContain("valid link");
    await act(async () => { finishOld({ authorized: true, expiresAt: Date.now() + 60_000 }); });
    expect(screen.queryByText("Private stage message")).toBeNull();
    expect(api.mounted).not.toHaveBeenCalled();
  });

  it("hides private content at the actual expiry while renewal is stalled", async () => {
    api.ensure.mockResolvedValueOnce({ authorized: true, expiresAt: Date.now() + 35_000 })
      .mockImplementation(() => new Promise(() => {}));
    await act(async () => { render(<DisplayAccessGate orgSlug="venue" surface="overlay"><PrivateDisplay /></DisplayAccessGate>); });
    await act(async () => { await vi.advanceTimersByTimeAsync(34_999); });
    expect(screen.getByText("Private stage message")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByText("Private stage message")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("does not accept authorization that expired while its response was in flight", async () => {
    api.ensure.mockResolvedValue({ authorized: true, expiresAt: Date.now() - 1 });
    await act(async () => { render(<DisplayAccessGate orgSlug="venue" surface="overlay"><PrivateDisplay /></DisplayAccessGate>); });
    expect(screen.queryByText("Private stage message")).toBeNull();
    expect(api.mounted).not.toHaveBeenCalled();
  });
});


describe("display renewal isolation", () => {
  it("retains content through a timed-out renewal, recovers automatically and cancels the old expiry", async () => {
    let finishOld: (result: { authorized: false }) => void = () => {};
    const expiresAt = Date.now() + 70_000;
    api.ensure.mockResolvedValueOnce({ authorized: true, expiresAt })
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValue({ authorized: true, expiresAt: expiresAt + 600_000 });
    await act(async () => { render(<DisplayAccessGate orgSlug="venue" surface="timer"><PrivateDisplay /></DisplayAccessGate>); });
    await act(async () => { await vi.advanceTimersByTimeAsync(38_000); });
    expect(api.ensure.mock.calls[1][0].signal.aborted).toBe(true);
    expect(screen.getByText("Private stage message")).toBeTruthy();
    expect(api.mounted).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(22_000); });
    expect(api.ensure).toHaveBeenCalledTimes(3);
    await act(async () => { finishOld({ authorized: false }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(screen.getByText("Private stage message")).toBeTruthy();
    expect(api.mounted).toHaveBeenCalledTimes(1);
  });

  it("aborts old scopes and unmounted checks, without accepting their results", async () => {
    let finishOld: (result: { authorized: false }) => void = () => {};
    api.ensure.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const { rerender, unmount } = render(<DisplayAccessGate orgSlug="old" surface="overlay"><PrivateDisplay /></DisplayAccessGate>);
    const oldSignal = api.ensure.mock.calls[0][0].signal;
    await act(async () => { rerender(<DisplayAccessGate orgSlug="new" surface="overlay"><PrivateDisplay /></DisplayAccessGate>); });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { finishOld({ authorized: false }); });
    expect(screen.getByText("Private stage message")).toBeTruthy();
    api.ensure.mockImplementation(() => new Promise(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    const currentSignal = api.ensure.mock.calls.at(-1)?.[0].signal;
    unmount();
    expect(currentSignal.aborted).toBe(true);
    const calls = api.ensure.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
    expect(api.ensure).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});
