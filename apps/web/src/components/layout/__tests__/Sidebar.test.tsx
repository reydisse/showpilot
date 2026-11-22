import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "../Sidebar";

const state = vi.hoisted(() => ({ collapsed: false }));
vi.mock("@/components/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({ modules: [] }),
  useTerms: () => ({ eventTitle: "Show" }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, search: _search, ...props }: { to: string; params?: { slug: string }; children: ReactNode; search?: unknown }) => (
    <a href={params ? to.replace("$slug", params.slug) : to} {...props}>{children}</a>
  ),
  CatchBoundary: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({}),
  useLocation: () => ({ pathname: "/demo/settings" }),
  useParams: () => ({ slug: "demo" }),
  useRouteContext: () => ({
    org: { id: "org-1", name: "Demo" },
    user: { id: "user-1", name: "Demo Member", email: "member@example.com", emailVerified: true },
    role: "member",
    grantedPermissions: [],
    accessAuthority: { canManage: false },
  }),
}));
vi.mock("../SidebarContext", () => ({
  useSidebar: () => ({ collapsed: state.collapsed, fullscreen: false, mobileOpen: false, isMobile: false, toggle: vi.fn() }),
}));
vi.mock("../ThemeContext", () => ({ useTheme: () => ({ theme: "dark", toggleTheme: vi.fn() }) }));
vi.mock("@/hooks/useDesktopRuntime", () => ({ useDesktopRuntime: () => false }));
vi.mock("../OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/hooks/useAccountNotificationCount", () => ({
  useAccountNotificationCount: () => ({ state: { kind: "ready", snapshot: { unread: 0 } } }),
}));
vi.mock("../DeviceNotificationsControl", () => ({ DeviceNotificationsControl: () => null }));

afterEach(cleanup);

it.each([false, true])("shows Settings only in the account menu (collapsed=%s)", async collapsed => {
  state.collapsed = collapsed;
  render(<Sidebar />);
  const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
  expect(within(nav).queryByRole("link", { name: "Settings", hidden: true })).toBeNull();

  fireEvent.click(screen.getByTitle("Account menu"));
  const account = await screen.findByRole("dialog");
  expect(within(account).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/demo/settings");
});
