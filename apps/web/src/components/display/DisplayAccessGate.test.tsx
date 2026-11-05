import { act, cleanup, render, screen } from "@testing-library/react";
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
    expect(api.ensure).toHaveBeenCalledWith({ data: { orgSlug: "venue", surface: "timer", token: "fixture" } });
    expect(window.location.search).toBe("?output=clean");
    expect(screen.getByText("Private stage message")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.ensure).toHaveBeenLastCalledWith({ data: { orgSlug: "venue", surface: "timer", token: undefined } });
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
