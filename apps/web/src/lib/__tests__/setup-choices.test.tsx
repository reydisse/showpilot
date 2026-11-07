vi.mock("@/lib/setup-choices", () => ({ getSetupChoices: api.get, saveSetupRole: api.role, saveSetupWorkspace: api.workspace }));
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/_auth/setup";
const api = vi.hoisted(() => ({ role: vi.fn(), workspace: vi.fn(), get: vi.fn(), scene: 2 as number | string,
  navigate: vi.fn(async () => {}), create: vi.fn(), activate: vi.fn(), slug: vi.fn(), started: vi.fn(),
  org: null as { id: string; name: string; slug: string } | null,
}));
vi.mock("@/lib/analytics", () => ({ identifyAnalytics: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { organization: { create: api.create, setActive: api.activate } } }));
vi.mock("@/lib/onboarding", () => ({ checkOrgSlug: api.slug, getOnboardingProgress: vi.fn(), markOnboardingStarted: api.started, seedOrgTemplate: vi.fn(), getOnboardingSeed: async () => ({ status: "empty" }) }));
vi.mock("@/lib/setup-save", () => ({ getSetupTeam: async () => ({ batch: null, invitations: [], completed: false }), saveSetupTeam: vi.fn(), sendSetupInvitation: vi.fn(), finishSetupTeam: vi.fn() }));
vi.mock("@/lib/workspace/profile", () => ({ getWorkspaceProfile: vi.fn(), setWorkspaceModules: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: api.navigate }), useBlocker: () => ({ status: "idle" }), createFileRoute: () => (options: unknown) => ({ options,
  useSearch: () => ({}), useNavigate: () => vi.fn(), useRouteContext: () => ({ user: { id: "owner", email: "owner@example.test", emailVerified: true } }),
  useLoaderData: () => ({ initialScene: api.scene, initialWorkspace: resolveWorkspaceProfile({}), progress: { org: api.org, archetype: null, seededTemplate: null } }),
}) }));
beforeEach(() => { api.scene = 2; api.org = { id: "org", name: "Fixture", slug: "fixture" }; api.navigate.mockResolvedValue(); api.get.mockResolvedValue({ settings: {}, workspaceRevision: null, roleValue: null }); });
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

it("lets an operator go back from role selection without writing another choice", async () => {
  vi.useFakeTimers();
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByText("What are you running?")).toBeTruthy();
  expect(api.role).not.toHaveBeenCalled(); expect(api.workspace).not.toHaveBeenCalled();
});

it("does not advance after Back when a role acknowledgement arrives late", async () => {
  vi.useFakeTimers(); let release: (value: unknown) => void = () => {};
  api.role.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Technical Director/ })));
  const command = api.role.mock.calls[0][0].data;
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  await act(async () => release({ settings: {}, workspaceRevision: null, roleValue: JSON.stringify({ archetype: command.archetype, requestId: command.requestId }) }));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByRole("heading", { name: "What are you running?" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /Pick your first/ })).toBeNull();
  expect(api.navigate).not.toHaveBeenCalled();
});

it("keeps custom drafts when going back to the saved organization and returning", async () => {
  vi.useFakeTimers(); api.scene = "1b";
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.click(screen.getByRole("button", { name: /Custom/ }));
  fireEvent.change(screen.getByLabelText("Event noun"), { target: { value: "Gig" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" })); await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByRole("heading", { name: "Your organization is saved" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue with this organization" })); await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByRole("textbox", { name: "Event noun" })).toHaveProperty("value", "Gig");
  expect(api.workspace).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
});

it("lets the operator cancel exit, then leave without completing or writing setup", async () => {
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.click(screen.getByRole("button", { name: "Exit setup" }));
  expect(screen.getByRole("dialog").textContent).toContain("Requests already sent may still finish");
  fireEvent.click(screen.getByRole("button", { name: "Keep setting up" }));
  expect(api.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Exit setup" }));
  await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Exit setup" })));
  expect(api.navigate).toHaveBeenCalledExactlyOnceWith({ href: "/fixture/show" });
  expect(api.role).not.toHaveBeenCalled(); expect(api.workspace).not.toHaveBeenCalled(); expect(api.started).not.toHaveBeenCalled();
});

it("never activates or resumes a late organization creation after leaving setup", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.slug.mockResolvedValue({ available: true, suggestion: null });
  let release: (value: unknown) => void = () => {};
  api.create.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  let view: ReturnType<typeof render>;
  await act(async () => { view = render(<Wizard />); });
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Fixture venue" } });
  await act(async () => vi.advanceTimersByTimeAsync(450));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my show/ })));
  expect(api.create).toHaveBeenCalledOnce();
  expect(api.create.mock.calls[0][0].keepCurrentActiveOrganization).toBe(true);
  view!.unmount(); expect(api.create.mock.calls[0][0].fetchOptions.signal.aborted).toBe(true);
  await act(async () => release({ data: { id: "late-org", name: "Fixture venue", slug: "fixture-venue" }, error: null }));
  expect(api.activate).not.toHaveBeenCalled(); expect(api.started).not.toHaveBeenCalled(); expect(api.navigate).not.toHaveBeenCalled();
});

it.each([false, true])("keeps a created organization without activating it while exit is pending (confirmed=%s)", async confirmed => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.slug.mockResolvedValue({ available: true, suggestion: null });
  api.navigate.mockImplementation(() => new Promise(() => {}));
  let release: (value: unknown) => void = () => {};
  api.create.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Fixture venue" } });
  await act(async () => vi.advanceTimersByTimeAsync(450));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my show/ })));
  fireEvent.click(screen.getByRole("button", { name: "Exit setup" }));
  if (confirmed) fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Exit setup" }));
  await act(async () => release({ data: { id: "late-org", name: "Fixture venue", slug: "fixture-venue" }, error: null }));
  expect(api.activate).not.toHaveBeenCalled(); expect(api.started).not.toHaveBeenCalled();
  if (!confirmed) {
    fireEvent.click(screen.getByRole("button", { name: "Keep setting up" }));
    expect(screen.getByRole("button", { name: /Continue setup/ })).toBeTruthy();
    api.activate.mockResolvedValue({ error: null }); api.started.mockResolvedValue({ ok: true });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Continue setup/ })));
    expect(api.create).toHaveBeenCalledOnce(); expect(api.activate).toHaveBeenCalledOnce(); expect(api.started).toHaveBeenCalledOnce();
  }
});
