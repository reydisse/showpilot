vi.mock("@/lib/setup-choices", () => ({ getSetupChoices: api.get, saveSetupRole: api.role, saveSetupWorkspace: api.workspace }));
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/_auth/setup";
const api = vi.hoisted(() => ({ role: vi.fn(), workspace: vi.fn(), get: vi.fn(), scene: 2 as number | string }));
vi.mock("@/lib/analytics", () => ({ identifyAnalytics: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/onboarding", () => ({ checkOrgSlug: vi.fn(), getOnboardingProgress: vi.fn(), markOnboardingStarted: vi.fn(), seedOrgTemplate: vi.fn(), getOnboardingSeed: async () => ({ status: "empty" }) }));
vi.mock("@/lib/setup-save", () => ({ getSetupTeam: async () => ({ batch: null, invitations: [], completed: false }), saveSetupTeam: vi.fn(), sendSetupInvitation: vi.fn(), finishSetupTeam: vi.fn() }));
vi.mock("@/lib/workspace/profile", () => ({ getWorkspaceProfile: vi.fn(), setWorkspaceModules: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => ({ options,
  useSearch: () => ({}), useNavigate: () => vi.fn(), useRouteContext: () => ({ user: { id: "owner", email: "owner@example.test", emailVerified: true } }),
  useLoaderData: () => ({ initialScene: api.scene, initialWorkspace: resolveWorkspaceProfile({}), progress: { org: { id: "org", name: "Fixture", slug: "fixture" }, archetype: null, seededTemplate: null } }),
}) }));
beforeEach(() => { api.scene = 2; api.get.mockResolvedValue({ settings: {}, workspaceRevision: null, roleValue: null }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
it("stays on the role step when the checkpoint fails", async () => {
  vi.useFakeTimers(); api.role.mockRejectedValue(new Error("Database unavailable"));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Technical Director/ })));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(api.role).toHaveBeenCalledOnce();
  expect(screen.queryByText("What's your role on the team?")).not.toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
});

it("does not change workspace or advance while its save is pending or rejected", async () => {
  vi.useFakeTimers(); api.scene = "1b"; api.workspace.mockImplementationOnce(() => new Promise(() => {}));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /School/ })));
  expect(api.workspace).toHaveBeenCalledOnce(); expect(screen.queryByText("What's your role on the team?")).toBeNull();
  expect(screen.queryByText(/Saved workspace:/)).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
  expect(screen.getByRole("button", { name: /School/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByText("What's your role on the team?")).toBeNull();
});
it("retains custom workspace fields and labels through a failed save", async () => {
  api.scene = "1b"; api.workspace.mockRejectedValue(new Error("Unavailable"));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
  fireEvent.change(screen.getByLabelText("What do you call your productions?"), { target: { value: "Tour fixture" } });
  fireEvent.change(screen.getByLabelText("Event noun"), { target: { value: "Gig" } });
  fireEvent.change(screen.getByLabelText("Item noun"), { target: { value: "Act" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue" })));
  expect(api.workspace).toHaveBeenCalledOnce(); expect(screen.getByLabelText("Event noun")).toHaveProperty("value", "Gig");
  expect(screen.getByLabelText("What do you call your productions?")).toHaveProperty("value", "Tour fixture");
});
