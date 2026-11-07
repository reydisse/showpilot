import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const fixture = vi.hoisted(() => ({
  user: { email: "unverified@example.test", emailVerified: false },
  linkError: undefined as string | undefined,
  returnTo: undefined as string | undefined,
  getSession: vi.fn(), sendVerificationEmail: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => ({ error: fixture.linkError, returnTo: fixture.returnTo }), useRouteContext: () => ({ user: fixture.user }) }),
  Link: ({ to, search, children }: { to: string; search?: { verify?: number; returnTo?: string }; children: ReactNode }) => {
    const query = new URLSearchParams();
    if (search?.verify) query.set("verify", String(search.verify));
    if (search?.returnTo) query.set("returnTo", search.returnTo);
    return <a href={to + (query.size ? `?${query}` : "")}>{children}</a>;
  },
}));
vi.mock("../auth-client", () => ({ authClient: { getSession: fixture.getSession, sendVerificationEmail: fixture.sendVerificationEmail } }));
import { Route } from "@/routes/_auth/verify-email";
const Page = Route.options.component!;
const unverified = () => ({ data: { user: { email: fixture.user.email, emailVerified: false } }, error: null });
const verified = () => ({ data: { user: { email: fixture.user.email, emailVerified: true } }, error: null });
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); fixture.user.emailVerified = false; fixture.linkError = undefined; fixture.returnTo = undefined;
  fixture.getSession.mockResolvedValue(unverified());
  fixture.sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("does not claim verification merely because the URL has no error", async () => {
  render(<Page />);
  expect(screen.queryByRole("heading", { name: "Email verified" })).toBeNull();
  await screen.findByRole("heading", { name: "Check your inbox" });
  expect(fixture.getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true }, fetchOptions: { signal: expect.any(AbortSignal) } });
  expect(screen.queryByRole("link", { name: "Continue" })).toBeNull();
});

it("requires fresh verification before offering Continue, even with stale route data", async () => {
  fixture.user.emailVerified = true;
  render(<Page />);
  await screen.findByRole("heading", { name: "Check your inbox" });
  fixture.getSession.mockResolvedValueOnce(verified());
  fireEvent.click(screen.getByRole("button", { name: "I've verified my email" }));
  expect(screen.queryByRole("heading", { name: "Email verified" })).toBeNull();
  await screen.findByRole("heading", { name: "Email verified" });
  expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe("/setup");
  expect(fixture.getSession).toHaveBeenCalledTimes(2);
});

it("requires sign-in for an anonymous visitor without exposing a stale identity", async () => {
  fixture.getSession.mockResolvedValueOnce({ data: null, error: null });
  render(<Page />);
  await screen.findByRole("heading", { name: "Sign in to check verification" });
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login?verify=1");
  expect(screen.queryByText(fixture.user.email, { exact: false })).toBeNull();
  expect(screen.queryByRole("button", { name: "Resend verification email" })).toBeNull();
});

it("keeps invalid-link context without treating it as the account's verification status", async () => {
  fixture.linkError = "TOKEN_EXPIRED";
  render(<Page />);
  await screen.findByRole("heading", { name: "Verification link failed" });
  expect(screen.getByRole("alert").textContent).toContain("invalid or has expired");
  fixture.getSession.mockResolvedValueOnce(verified());
  fireEvent.click(screen.getByRole("button", { name: "I've verified my email" }));
  await screen.findByRole("heading", { name: "Email verified" });
});

it("keeps failed checks visible and retryable without trusting stale successful data", async () => {
  fixture.getSession.mockResolvedValueOnce({ ...verified(), error: { message: "unavailable" } });
  render(<Page />);
  await screen.findByRole("heading", { name: "Verification status unavailable" });
  expect(screen.getByRole("alert").textContent).toContain("Last attempt:");
  fireEvent.click(screen.getByRole("button", { name: "Retry verification check" }));
  await screen.findByRole("heading", { name: "Check your inbox" });
});

it("times out a check, aborts it and ignores its late reply after Retry", async () => {
  vi.useFakeTimers();
  const old = pending<ReturnType<typeof unverified>>(); fixture.getSession.mockReturnValueOnce(old.promise);
  render(<Page />);
  const signal = fixture.getSession.mock.calls[0][0].fetchOptions.signal;
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole("heading", { name: "Verification status unavailable" })).toBeTruthy();
  fixture.getSession.mockResolvedValueOnce(verified());
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry verification check" })); });
  expect(screen.getByRole("heading", { name: "Email verified" })).toBeTruthy();
  await act(async () => old.resolve(unverified()));
  expect(screen.getByRole("heading", { name: "Email verified" })).toBeTruthy();
});

it("reports resend failure, retries explicitly and never confuses delivery with verification", async () => {
  fixture.sendVerificationEmail.mockResolvedValueOnce({ data: null, error: { message: "rate limited" } });
  render(<Page />); await screen.findByRole("heading", { name: "Check your inbox" });
  fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
  await screen.findByRole("button", { name: "Retry sending verification email" });
  expect(screen.getByRole("alert").textContent).toContain("Last attempt:");
  fireEvent.click(screen.getByRole("button", { name: "Retry sending verification email" }));
  await screen.findByText("Verification email sent. Check your inbox.");
  expect(screen.queryByRole("heading", { name: "Email verified" })).toBeNull();
  expect(fixture.sendVerificationEmail).toHaveBeenCalledWith({ email: fixture.user.email, callbackURL: "/verify-email", fetchOptions: { signal: expect.any(AbortSignal) } });
});

it("bounds a hung resend and cannot turn its late reply into confirmed delivery", async () => {
  vi.useFakeTimers();
  const old = pending<{ data: { status: boolean }; error: null }>(); fixture.sendVerificationEmail.mockReturnValueOnce(old.promise);
  render(<Page />); await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
  const signal = fixture.sendVerificationEmail.mock.calls[0][0].fetchOptions.signal;
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "Retry sending verification email" })).toBeTruthy();
  await act(async () => old.resolve({ data: { status: true }, error: null }));
  expect(screen.queryByText("Verification email sent. Check your inbox.")).toBeNull();
});

it("aborts the active status request when leaving the page", () => {
  fixture.getSession.mockReturnValueOnce(new Promise(() => {}));
  const page = render(<Page />);
  const signal = fixture.getSession.mock.calls[0][0].fetchOptions.signal;
  page.unmount(); expect(signal.aborted).toBe(true);
});

it("carries a deep link through anonymous recovery, resend and verified Continue", async () => {
  fixture.returnTo = "/venue/chat?room=planning";
  fixture.getSession.mockResolvedValueOnce({ data: null, error: null });
  const page = render(<Page />);
  await screen.findByRole("link", { name: "Sign in" });
  expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login?verify=1&returnTo=%2Fvenue%2Fchat%3Froom%3Dplanning");
  page.unmount(); render(<Page />);
  await screen.findByRole("heading", { name: "Check your inbox" });
  fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
  await screen.findByText("Verification email sent. Check your inbox.");
  expect(fixture.sendVerificationEmail.mock.calls[0][0].callbackURL).toBe("/verify-email?returnTo=%2Fvenue%2Fchat%3Froom%3Dplanning");
  fixture.getSession.mockResolvedValueOnce(verified());
  fireEvent.click(screen.getByRole("button", { name: "I've verified my email" }));
  await screen.findByRole("link", { name: "Continue" });
  expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe(fixture.returnTo);
});
