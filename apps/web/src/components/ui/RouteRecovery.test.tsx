import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError, RouteNotFound } from "./RouteRecovery";

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function recoveryRouter({
  path = "/test",
  loader = () => {},
  component = () => <h1>Workspace recovered</h1>,
}: {
  path?: string;
  loader?: () => void;
  component?: () => React.ReactNode;
} = {}) {
  const root = createRootRoute();
  const page = createRoute({ getParentRoute: () => root, path: "/test", loader, component });
  return createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    defaultPendingMinMs: 0,
  });
}

describe("route recovery", () => {
  it("renders unknown URLs with a normal recovery link and support contact", async () => {
    const router = recoveryRouter({ path: "/missing" });
    await router.load();
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "This page is off the rundown." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Contact support" }).getAttribute("href")).toBe("mailto:support@showpilot.tech");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("reruns a failed loader on retry without exposing its internal error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = true;
    const loader = vi.fn(() => {
      if (failing) throw new Error("private database detail");
    });
    const router = recoveryRouter({ loader });
    await router.load();
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Let's get you back on cue." })).toBeTruthy();
    expect(screen.queryByText("private database detail")).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Workspace recovered" })).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery actions available if retry also fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = vi.fn(() => { throw new Error("still unavailable"); });
    const router = recoveryRouter({ loader });
    await router.load();
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe("/");
  });

  it("resets a render error as well as loader failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = true;
    function Page() {
      if (failing) throw new Error("render failure");
      return <h1>Workspace recovered</h1>;
    }
    const router = recoveryRouter({ component: Page });
    await router.load();
    render(<RouterProvider router={router} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    failing = false;
    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "Workspace recovered" })).toBeTruthy();
  });
});
