import { Outlet, createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useBlocker } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Route as ApplicationRoot } from "@/routes/__root";
import { Route as AuthRoute } from "@/routes/_auth";
import { SignOutControl } from "../SignOutControl";
import { stopSignOutReconciliation } from "@/lib/sign-out-reconciliation";
import { unlockLocalAccount } from "@/lib/local-account-exit";
const api = vi.hoisted(() => ({ restore: vi.fn(), read: vi.fn(), signOut: vi.fn(), blocker: vi.fn(() => true), session: { data: { user: { id: "me" }, session: { id: "old" } } as unknown } }));
vi.mock("@/lib/session", () => ({ getSessionWithOrg: api.restore, listUserOrgs: vi.fn(), setActiveOrg: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: api.read, signOut: api.signOut, $store: { atoms: { session: { get: () => api.session, set: (value: typeof api.session) => Object.assign(api.session, value) } } } } }));
vi.mock("@/components/layout/DesktopControllers", () => ({ DesktopControllers: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/notifications", () => ({ registerNotificationWorker: vi.fn() }));
afterEach(() => { cleanup(); stopSignOutReconciliation(); unlockLocalAccount(); vi.clearAllMocks(); });
it("reaches login on the first click despite an unsaved-page blocker and an unresponsive session service, then allows public recovery pages", async () => {
  api.session.data = { user: { id: "me" }, session: { id: "old" } };
  api.restore.mockReturnValue(new Promise(() => {})); api.read.mockReturnValue(new Promise(() => {}));
  function PrivatePage() {
    useBlocker({ shouldBlockFn: api.blocker });
    return <><p>Private fixture</p><SignOutControl userId="me" /></>;
  }
  const root = createRootRoute({ component: ApplicationRoot.options.component });
  const privateRoute = createRoute({ getParentRoute: () => root, path: "/$slug", component: PrivatePage });
  const auth = createRoute({ getParentRoute: () => root, id: "_auth", beforeLoad: async (context) => { await AuthRoute.options.beforeLoad?.(context as never); }, component: Outlet });
  const login = createRoute({ getParentRoute: () => auth, path: "login", component: () => <h1>Login fixture</h1> });
  const recovery = createRoute({ getParentRoute: () => auth, path: "forgot-password", component: () => <h1>Recovery fixture</h1> });
  const router = createRouter({ routeTree: root.addChildren([privateRoute, auth.addChildren([login, recovery])]), history: createMemoryHistory({ initialEntries: ["/demo"] }) });
  await router.load(); await act(async () => { render(<RouterProvider router={router} />); });
  fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
  expect(screen.queryByText("Private fixture")).toBeNull();
  await waitFor(() => expect(screen.getByRole("heading", { name: "Login fixture" })).toBeTruthy());
  expect(api.blocker).not.toHaveBeenCalled(); expect(api.restore).not.toHaveBeenCalled(); expect(api.signOut).not.toHaveBeenCalled();
  await act(async () => { await router.navigate({ to: "/forgot-password" }); });
  expect(screen.getByRole("heading", { name: "Recovery fixture" })).toBeTruthy();
});
