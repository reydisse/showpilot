import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/_auth/login";

const auth = vi.hoisted(() => ({ signUp: vi.fn(), signIn: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signUp: { email: auth.signUp }, signIn: { email: auth.signIn } } }));
vi.mock("@/components/auth/SignInShell", () => ({ SignInShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => ({ signup: 1 }), useLoaderData: () => ({ design: {} }) }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function attemptSignup() {
  const Login = Route.options.component;
  if (!Login) throw new Error("Missing login component");
  render(<Login />);
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Existing member" } });
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "existing@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Draft-password-123!" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create account" })));
}

it.each(["USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"])("offers sign-in after %s and retains the email", async code => {
  auth.signUp.mockResolvedValue({ error: { code, message: "Use another email" } });
  await attemptSignup();
  expect(screen.getByRole("alert").textContent).toContain("Sign in to create another organization");
  fireEvent.click(screen.getByRole("button", { name: "Sign in to create an organization" }));
  expect(screen.getByLabelText("Email address")).toHaveProperty("value", "existing@example.test");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Password")).toHaveProperty("autocomplete", "current-password");
  expect(screen.queryByLabelText("Full name")).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in" })).toHaveProperty("disabled", false);
});

it("keeps a failed signup draft and does not mistake another failure for an existing account", async () => {
  auth.signUp.mockRejectedValue(new Error("Connection failed. Try again."));
  await attemptSignup();
  expect(screen.getByRole("alert").textContent).toBe("Connection failed. Try again.");
  expect(screen.getByLabelText("Full name")).toHaveProperty("value", "Existing member");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "Draft-password-123!");
  expect(screen.queryByRole("button", { name: "Sign in to create an organization" })).toBeNull();
  expect(screen.getByRole("button", { name: "Create account" })).toHaveProperty("disabled", false);
});

it("allows only the specific local setup and account-deletion return paths", () => {
  const validate = Route.options.validateSearch;
  if (typeof validate !== "function") throw new Error("Missing login search validator");
  expect(validate({ returnTo: "/setup?mode=new" })).toMatchObject({ returnTo: "/setup?mode=new" });
  expect(validate({ returnTo: "/delete-account?token=abc123" })).toMatchObject({ returnTo: "/delete-account?token=abc123" });
  for (const returnTo of ["https://other.test", "//other.test", "/setup?mode=new&redirect=https://other.test", "/setup?mode=new/other"]) {
    expect(validate({ returnTo })).toMatchObject({ returnTo: undefined });
  }
});
