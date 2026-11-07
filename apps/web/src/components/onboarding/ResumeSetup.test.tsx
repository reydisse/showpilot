import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResumeSetup } from "./ResumeSetup";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/onboarding", () => ({ getOnboardingProgress: read }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ search, children }: { search: { orgId: string }; children: React.ReactNode }) => <a href={`/setup?orgId=${search.orgId}`}>{children}</a> }));
const progress = { authenticated: true, org: { id: "org" }, isOwner: true, started: true, completed: false };
beforeEach(() => { read.mockResolvedValue(progress); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it("links the owner to the exact unfinished workspace", async () => {
  await act(async () => render(<ResumeSetup orgId="org" />));
  expect(screen.getByRole("link", { name: "Resume setup" }).getAttribute("href")).toBe("/setup?orgId=org");
  expect(read.mock.calls[0][0].data).toEqual({ mode: "resume", orgId: "org" });
});
it.each([{ completed: true }, { started: false }, { isOwner: false }])("does not offer setup for %j", async change => {
  read.mockResolvedValue({ ...progress, ...change }); await act(async () => render(<ResumeSetup orgId="org" />));
  expect(screen.queryByRole("link")).toBeNull(); expect(screen.queryByRole("status")).toBeNull();
});
it("bounds a stalled read and recovers with an explicit read-only retry", async () => {
  vi.useFakeTimers(); read.mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => render(<ResumeSetup orgId="org" />)); await act(async () => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.getByRole("alert").textContent).toContain("Last attempt:");
  expect(read.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check setup progress" })));
  expect(screen.getByRole("link", { name: "Resume setup" })).toBeTruthy(); expect(read).toHaveBeenCalledTimes(2);
});
it.each([{ authenticated: false }, { org: { id: "another" } }])("does not treat unconfirmed scope as a completed setup: %j", async change => {
  read.mockResolvedValue({ ...progress, ...change }); await act(async () => render(<ResumeSetup orgId="org" />));
  expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.queryByRole("link")).toBeNull();
});
