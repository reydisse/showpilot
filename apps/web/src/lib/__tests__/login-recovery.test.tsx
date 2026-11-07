import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ signUp: vi.fn(), signIn: vi.fn(), signup: 1 as 1 | undefined, verify: undefined as 1 | undefined, returnTo: undefined as string | undefined, hash: "" }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signUp: { email: fixture.signUp }, signIn: { email: fixture.signIn } } }));
vi.mock("@/components/auth/SignInShell", () => ({ SignInShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => fixture, useLoaderData: () => ({ design: {} }) }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
import { Route } from "@/routes/_auth/login";
const Page = Route.options.component!;
let destination = "";
const saved = { data: { user: { email: "new@example.test", emailVerified: false }, token: "fixture-session" }, error: null };
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function enter() {
  const name = screen.queryByLabelText("Full name"); if (name) fireEvent.change(name, { target: { value: "New operator" } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test-password-123!" } });
}
function submit() { fireEvent.submit(screen.getByLabelText("Password").closest("form")!); }
beforeEach(() => {
  vi.resetAllMocks(); fixture.signup = 1; fixture.verify = undefined; fixture.returnTo = undefined; destination = ""; fixture.hash = "";
  // Keep document/window events real; capture only the hard navigation boundary.
  vi.stubGlobal("window", new Proxy(window, { get(target, key) { return key === "location" ? { get hash() { return fixture.hash; }, get href() { return destination; }, set href(value) { destination = value; } } : Reflect.get(target, key, target); } }));
  fixture.signUp.mockResolvedValue(saved); fixture.signIn.mockResolvedValue(saved);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("lands confirmed signup on verification with its intended app destination", async () => {
  fixture.returnTo = "/venue/chat?room=planning"; render(<Page />); enter();
  await act(async () => submit());
  expect(destination).toBe("/verify-email?returnTo=%2Fvenue%2Fchat%3Froom%3Dplanning");
  expect(fixture.signUp).toHaveBeenCalledExactlyOnceWith({ email: "new@example.test", name: "New operator", password: "Test-password-123!", callbackURL: destination, fetchOptions: { signal: expect.any(AbortSignal), retry: 0 } });
});
it("keeps a failed signup draft, offers sign-in recovery and returns to verification", async () => {
  fixture.signUp.mockResolvedValueOnce({ error: { status: 500, message: "SMTP failed: private diagnostic" } });
  render(<Page />); enter(); await act(async () => submit());
  expect(destination).toBe(""); expect(screen.getByRole("alert").textContent).toContain("Your account may already exist");
  expect(screen.getByRole("alert").textContent).not.toContain("private diagnostic");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "Test-password-123!");
  fireEvent.click(screen.getByRole("button", { name: "Sign in to check account" }));
  expect(screen.getByLabelText("Email address")).toHaveProperty("value", "new@example.test");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  enter(); await act(async () => submit());
  expect(destination).toBe("/verify-email"); expect(fixture.signUp).toHaveBeenCalledTimes(1);
});
it("times out signup, prevents duplicate requests and ignores late success", async () => {
  vi.useFakeTimers(); const old = pending<typeof saved>(); fixture.signUp.mockReturnValueOnce(old.promise);
  render(<Page />); enter(); submit(); submit();
  expect(fixture.signUp).toHaveBeenCalledTimes(1);
  const signal = fixture.signUp.mock.calls[0][0].fetchOptions.signal;
  expect(screen.getByLabelText("Email address")).toHaveProperty("disabled", true);
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(signal.aborted).toBe(true); expect(screen.getByRole("alert").textContent).toContain("Last attempt:");
  await act(async () => old.resolve(saved)); expect(destination).toBe("");
  expect(screen.getByRole("button", { name: "Sign in to check account" })).toBeTruthy();
});
it("aborts on unmount and never navigates on its late reply", async () => {
  const old = pending<typeof saved>(); fixture.signUp.mockReturnValueOnce(old.promise);
  const view = render(<Page />); enter(); submit(); const signal = fixture.signUp.mock.calls[0][0].fetchOptions.signal;
  view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(saved)); expect(destination).toBe("");
});
it.each([{ data: null }, { data: { user: saved.data.user, token: null } }])("requires a confirmed session before navigating: %j", async value => {
  fixture.signUp.mockResolvedValueOnce(value); render(<Page />); enter(); await act(async () => submit());
  expect(destination).toBe(""); expect(screen.getByRole("alert").textContent).toContain("couldn't confirm account creation");
});
it("maps sign-in rejection to human copy and preserves the intended destination on Retry", async () => {
  fixture.signup = undefined; fixture.returnTo = "/venue/timecode?showId=abc";
  fixture.signIn.mockResolvedValueOnce({ error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "raw" } });
  render(<Page />); enter(); await act(async () => submit());
  expect(screen.getByRole("alert").textContent).toContain("The email or password is incorrect");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry sign-in" })));
  expect(destination).toBe(fixture.returnTo);
});
it("bounds sign-in, allows explicit Retry and ignores its stale result", async () => {
  vi.useFakeTimers(); fixture.signup = undefined;
  const old = pending<typeof saved>(); fixture.signIn.mockReturnValueOnce(old.promise);
  render(<Page />); enter(); submit();
  await act(() => vi.advanceTimersByTimeAsync(8_000));
  expect(screen.getByRole("alert").textContent).toContain("couldn't confirm sign-in");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry sign-in" })));
  expect(destination).toBe("/"); destination = "";
  await act(async () => old.resolve(saved)); expect(destination).toBe("");
});
it("returns an anonymous verification visitor to the verification page after sign-in", async () => {
  fixture.signup = undefined; fixture.verify = 1; fixture.returnTo = "/invite/abc";
  render(<Page />); enter(); await act(async () => submit());
  expect(destination).toBe("/verify-email?returnTo=%2Finvite%2Fabc");
});

it("restores a fragment inherited across an HTTP login redirect", async () => {
  fixture.signup = undefined; fixture.returnTo = "/venue/chat?room=planning"; fixture.hash = "#message-5";
  render(<Page />); enter(); await act(async () => submit());
  expect(destination).toBe("/venue/chat?room=planning#message-5");
});
it("keeps an explicit return fragment ahead of an unrelated login fragment", async () => {
  fixture.returnTo = "/venue/chat#original"; fixture.hash = "#unrelated";
  render(<Page />); enter(); await act(async () => submit());
  expect(destination).toBe("/verify-email?returnTo=%2Fvenue%2Fchat%23original");
});
