import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const fixture = vi.hoisted(() => ({ token: "valid-token", check: vi.fn(), resetPassword: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => ({ token: fixture.token }) }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("../auth-client", () => ({ authClient: { resetPassword: fixture.resetPassword } }));
vi.mock("../password-reset", () => ({ checkPasswordResetLink: fixture.check }));
import { Route } from "@/routes/_auth/reset-password";
const Page = Route.options.component!;
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const saved = { data: { status: true }, error: null };
const password = "New-test-password-74!";
async function submit() {
  if (!screen.queryByLabelText("New Password")) await screen.findByLabelText("New Password");
  fireEvent.change(screen.getByLabelText("New Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
}
beforeEach(() => { vi.resetAllMocks(); fixture.token = "valid-token"; fixture.check.mockResolvedValue({ valid: true }); fixture.resetPassword.mockResolvedValue(saved); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("does not offer a usable password form before validating the link", async () => {
  fixture.check.mockResolvedValue({ valid: false });
  render(<Page />);
  expect(screen.queryByLabelText("New Password")).toBeNull();
  await screen.findByRole("heading", { name: "Reset link unavailable" });
  expect(screen.queryByLabelText("New Password")).toBeNull();
  expect(fixture.resetPassword).not.toHaveBeenCalled();
});
it("rejects missing links without a request", () => {
  fixture.token = ""; render(<Page />);
  expect(screen.getByRole("link", { name: "Request a new reset link" }).getAttribute("href")).toBe("/forgot-password");
  expect(fixture.check).not.toHaveBeenCalled();
});
it("preserves confirmed success until the user chooses Sign in now", async () => {
  vi.useFakeTimers(); render(<Page />); await act(async () => {});
  await submit(); await act(async () => {});
  expect(screen.getByRole("link", { name: "Sign in now" }).getAttribute("href")).toBe("/login");
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.getByRole("heading", { name: "Password reset!" })).toBeTruthy();
  expect(screen.queryByLabelText("New Password")).toBeNull();
  expect(fixture.resetPassword).toHaveBeenCalledExactlyOnceWith({ token: fixture.token, newPassword: password, fetchOptions: { signal: expect.any(AbortSignal), retry: 0 } });
});
it("bounds preflight, supports read-only Retry, and ignores late valid responses", async () => {
  vi.useFakeTimers(); const old = pending<{ valid: boolean }>(); fixture.check.mockReturnValueOnce(old.promise);
  render(<Page />); const signal = fixture.check.mock.calls[0][0].signal;
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(signal.aborted).toBe(true); expect(screen.getByRole("alert").textContent).toContain("Last attempt:");
  fixture.check.mockResolvedValueOnce({ valid: false });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry link check" })));
  await act(async () => old.resolve({ valid: true }));
  expect(screen.getByRole("heading", { name: "Reset link unavailable" })).toBeTruthy();
  expect(fixture.resetPassword).not.toHaveBeenCalled();
});
it("keeps a rejected preflight distinct from an invalid token", async () => {
  fixture.check.mockRejectedValueOnce(new Error("D1 unavailable")); render(<Page />);
  await screen.findByRole("heading", { name: "Reset link check unavailable" });
  fireEvent.click(screen.getByRole("button", { name: "Retry link check" }));
  await screen.findByLabelText("New Password");
});
it("does not send mismatched passwords and preserves fields on a definite rate limit", async () => {
  render(<Page />); await screen.findByLabelText("New Password");
  fireEvent.change(screen.getByLabelText("New Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "different-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  expect(screen.getByRole("alert").textContent).toContain("Passwords do not match");
  expect(fixture.resetPassword).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: password } });
  fixture.resetPassword.mockResolvedValueOnce({ error: { status: 429 } });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText(/Too many attempts/);
  expect((screen.getByLabelText("New Password") as HTMLInputElement).value).toBe(password);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Password reset!" });
});
it("rejects a token that expires or is consumed after preflight", async () => {
  fixture.resetPassword.mockResolvedValueOnce({ error: { code: "INVALID_TOKEN", status: 400 } });
  render(<Page />); await submit();
  await screen.findByRole("heading", { name: "Reset link unavailable" });
  expect(screen.queryByLabelText("New Password")).toBeNull();
});
it.each([null, { data: { status: false }, error: null }, { error: { status: 500 } }])("never claims success without a positive acknowledgement: %j", async result => {
  fixture.resetPassword.mockResolvedValueOnce(result); render(<Page />); await submit();
  await screen.findByRole("heading", { name: "Reset not confirmed" });
  expect(screen.getByRole("link", { name: "Try signing in" }).getAttribute("href")).toBe("/login");
  expect(screen.queryByLabelText("New Password")).toBeNull();
});
it("times out a write once, prevents duplicate submits and ignores its late acknowledgement", async () => {
  vi.useFakeTimers(); const old = pending<typeof saved>(); fixture.resetPassword.mockReturnValueOnce(old.promise);
  render(<Page />); await act(async () => {}); await submit();
  const form = screen.getByLabelText("New Password").closest("form")!;
  fireEvent.submit(form); expect(fixture.resetPassword).toHaveBeenCalledTimes(1);
  const signal = fixture.resetPassword.mock.calls[0][0].fetchOptions.signal;
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole("heading", { name: "Reset not confirmed" })).toBeTruthy();
  await act(async () => old.resolve(saved));
  expect(screen.queryByRole("heading", { name: "Password reset!" })).toBeNull();
  expect(fixture.resetPassword).toHaveBeenCalledTimes(1);
});
it("discards the old form and cancels in-flight work when links change or the page unmounts", async () => {
  const old = pending<{ valid: boolean }>(); fixture.check.mockReturnValueOnce(old.promise);
  const view = render(<Page />); const signal = fixture.check.mock.calls[0][0].signal;
  fixture.token = "new-link"; view.rerender(<Page />);
  expect(signal.aborted).toBe(true); await screen.findByLabelText("New Password");
  await act(async () => old.resolve({ valid: false }));
  expect(screen.getByLabelText("New Password")).toBeTruthy();
  fixture.resetPassword.mockReturnValueOnce(new Promise(() => {})); await submit();
  const saving = fixture.resetPassword.mock.calls[0][0].fetchOptions.signal;
  view.unmount(); expect(saving.aborted).toBe(true);
});
