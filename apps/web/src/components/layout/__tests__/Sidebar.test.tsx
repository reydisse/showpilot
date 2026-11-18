import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "../Sidebar";

const state = vi.hoisted(() => ({ collapsed: false }));
vi.mock("@/components/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({ modules: [] }),
  useTerms: () => ({ eventTitle: "Show" }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ pathname: "/demo/settings" }),
  useParams: () => ({ slug: "demo" }),
  useRouteContext: () => ({ role: "member", grantedPermissions: [], accessAuthority: { canManage: false } }),
}));
vi.mock("../SidebarContext", () => ({
  useSidebar: () => ({ collapsed: state.collapsed, fullscreen: false, mobileOpen: false, isMobile: false, toggle: vi.fn() }),
}));
vi.mock("../ThemeContext", () => ({ useTheme: () => ({ theme: "dark", toggleTheme: vi.fn() }) }));
vi.mock("@/hooks/useDesktopRuntime", () => ({ useDesktopRuntime: () => false }));
vi.mock("../OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("../SidebarIdentity", () => ({ SidebarIdentity: () => null }));

afterEach(cleanup);

it.each([false, true])("shows Settings to a plain member without modules or settings permissions (collapsed=%s)", collapsed => {
  state.collapsed = collapsed;
  render(<Sidebar />);
  const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
  const settings = within(nav).getByRole("link", { name: "Settings" });
  expect(settings.getAttribute("href")).toBe("/demo/settings");
  expect(settings.getAttribute("aria-current")).toBe("page");
  const unavailable = nav.querySelector("details")!;
  expect(within(unavailable).queryByText("Settings")).toBeNull();
});
