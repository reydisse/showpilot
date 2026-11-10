import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ session: vi.fn(), orgs: vi.fn(), active: vi.fn(), context: vi.fn(), userSession: vi.fn(), profile: vi.fn() }));
vi.mock("../session", () => ({ getSessionWithOrg: fixture.session, listUserOrgs: fixture.orgs, setActiveOrg: fixture.active, getOrgRouteContext: fixture.context, getSession: fixture.userSession }));
vi.mock("../workspace/profile", () => ({ getWorkspaceProfile: fixture.profile }));
vi.mock("@/components/layout/RundownHandoffNotice", () => ({ RundownHandoffNotice: () => null }));
vi.mock("@/components/workspace/WorkspaceProvider", () => ({ WorkspaceProvider: () => null, WorkspaceRouteGate: () => null }));
vi.mock("@/components/layout/AppShell", () => ({ AppShell: () => null }));
vi.mock("@/components/layout/ThemeContext", () => ({ ThemeProvider: () => null }));
vi.mock("@/components/layout/AccessGrantSyncController", () => ({ AccessGrantSyncController: () => null }));
vi.mock("@/components/timecode/TimecodeContext", () => ({ TimecodeProvider: () => null }));
import { Route as AuthRoute } from "@/routes/_auth";
import { Route as OrgRoute } from "@/routes/$slug";
function enterAuth(path: string) {
  const url = new URL(path, "https://app.showpilot.tech");
  return Reflect.apply(AuthRoute.options.beforeLoad!, undefined, [{ location: { pathname: url.pathname, searchStr: url.search }, abortController: new AbortController(), preload: false }]);
}
function enterOrg(path: string) {
  return Reflect.apply(OrgRoute.options.beforeLoad!, undefined, [{ params: { slug: "venue" }, location: { href: path }, abortController: new AbortController(), preload: false }]);
}
beforeEach(() => {
  vi.resetAllMocks();
  fixture.session.mockResolvedValue({ user: { id: "operator" }, session: { activeOrganizationId: "org" }, org: { slug: "venue" } });
});
it("honors a signed-in app destination before the ordinary org redirect", async () => {
  await expect(enterAuth("/login?returnTo=%2Fvenue%2Fchat%3Froom%3Dplanning")).rejects.toMatchObject({ options: { href: "/venue/chat?room=planning" } });
  expect(fixture.active).not.toHaveBeenCalled();
});
it("keeps verification ahead of its final destination for signed-in recovery", async () => {
  await expect(enterAuth("/login?verify=1&returnTo=%2Finvite%2Fabc")).rejects.toMatchObject({ options: { href: "/verify-email?returnTo=%2Finvite%2Fabc" } });
});
it("cannot redirect an authenticated user to an external URL", async () => {
  await expect(enterAuth("/login?returnTo=https%3A%2F%2Fother.test")).rejects.toMatchObject({ options: { to: "/$slug", params: { slug: "venue" } } });
});
it("lets a signed-in user reach reset and email status without switching organizations", async () => {
  for (const path of ["/reset-password?token=abc", "/forgot-password", "/verify-email"]) {
    expect(await enterAuth(path)).toEqual({ user: { id: "operator" } });
  }
  expect(fixture.orgs).not.toHaveBeenCalled(); expect(fixture.active).not.toHaveBeenCalled();
});
it("carries an anonymous workspace deep link through login, including query and hash", async () => {
  fixture.context.mockResolvedValue(null); fixture.userSession.mockResolvedValue(null);
  await expect(enterOrg("/venue/chat?room=planning#message-5")).rejects.toMatchObject({ options: { to: "/login", search: { returnTo: "/venue/chat?room=planning#message-5" } } });
});
it("does not send a signed-in nonmember into a login redirect loop", async () => {
  fixture.context.mockResolvedValue(null); fixture.userSession.mockResolvedValue({ user: { id: "other" } });
  await expect(enterOrg("/venue/chat")).rejects.toThrow("workspace is unavailable or your account does not have access");
  expect(fixture.active).not.toHaveBeenCalled(); expect(fixture.profile).not.toHaveBeenCalled();
});
