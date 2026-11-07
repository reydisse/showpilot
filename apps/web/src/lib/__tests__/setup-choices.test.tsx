vi.mock("@/lib/setup-choices", () => ({ getSetupChoices: api.get, saveSetupRole: api.role, saveSetupWorkspace: api.workspace }));
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/_auth/setup";
const api = vi.hoisted(() => ({ role: vi.fn(), workspace: vi.fn(), get: vi.fn(), scene: 2 as number | string,
  navigate: vi.fn(async () => {}), routeNavigate: vi.fn(async () => {}), result: vi.fn(), verify: vi.fn(), verified: true, requestId: undefined as string | undefined, create: vi.fn(), activate: vi.fn(), slug: vi.fn(), started: vi.fn(),
  org: null as { id: string; name: string; slug: string } | null,
}));
vi.mock("@/lib/analytics", () => ({ identifyAnalytics: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { $fetch: api.result, sendVerificationEmail: api.verify, organization: { create: api.create, setActive: api.activate } } }));
vi.mock("@/lib/onboarding", () => ({ checkOrgSlug: api.slug, getOnboardingProgress: vi.fn(), markOnboardingStarted: api.started, seedOrgTemplate: vi.fn(), getOnboardingSeed: async () => ({ status: "empty" }) }));
vi.mock("@/lib/setup-save", () => ({ getSetupTeam: async () => ({ batch: null, invitations: [], completed: false }), saveSetupTeam: vi.fn(), sendSetupInvitation: vi.fn(), finishSetupTeam: vi.fn() }));
vi.mock("@/lib/workspace/profile", () => ({ getWorkspaceProfile: vi.fn(), setWorkspaceModules: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: api.navigate }), useBlocker: () => ({ status: "idle" }), createFileRoute: () => (options: unknown) => ({ options,
  useSearch: () => ({ creationRequestId: api.requestId }), useNavigate: () => api.routeNavigate, useRouteContext: () => ({ user: { id: "owner", email: "owner@example.test", emailVerified: api.verified } }),
  useLoaderData: () => ({ initialScene: api.scene, initialWorkspace: resolveWorkspaceProfile({}), progress: { org: api.org, archetype: null, seededTemplate: null } }),
}) }));
beforeEach(() => { api.verified = true; api.requestId = undefined; api.routeNavigate.mockResolvedValue(); api.scene = 2; api.org = { id: "org", name: "Fixture", slug: "fixture" }; api.navigate.mockResolvedValue(); api.get.mockResolvedValue({ settings: {}, workspaceRevision: null, roleValue: null }); });
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
  await act(async () => release({ data: { id: "late-org", name: "Fixture venue", slug: "fixture-venue", creationRequestId: api.create.mock.calls[0][0].fetchOptions.headers["Idempotency-Key"] }, error: null }));
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
  await act(async () => release({ data: { id: "late-org", name: "Fixture venue", slug: "fixture-venue", creationRequestId: api.create.mock.calls[0][0].fetchOptions.headers["Idempotency-Key"] }, error: null }));
  expect(api.activate).not.toHaveBeenCalled(); expect(api.started).not.toHaveBeenCalled();
  if (!confirmed) {
    fireEvent.click(screen.getByRole("button", { name: "Keep setting up" }));
    expect(screen.getByRole("button", { name: /Continue setup/ })).toBeTruthy();
    api.activate.mockResolvedValue({ error: null }); api.started.mockResolvedValue({ ok: true });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Continue setup/ })));
    expect(api.create).toHaveBeenCalledOnce(); expect(api.activate).not.toHaveBeenCalled(); expect(api.started).not.toHaveBeenCalled();
  }
});

it("bounds an organization creation request that never replies and keeps its draft", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null;
  api.slug.mockResolvedValue({ available: true, suggestion: null });
  api.create.mockImplementation(() => new Promise(() => {}));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Pending fixture" } });
  await act(async () => vi.advanceTimersByTimeAsync(450));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my show/ })));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
  expect(screen.getByLabelText("Organization name")).toHaveProperty("value", "Pending fixture");
  expect(api.create.mock.calls[0][0].fetchOptions.signal.aborted).toBe(true);
  expect(api.activate).not.toHaveBeenCalled(); expect(api.started).not.toHaveBeenCalled();
});

it("checks a refresh receipt without creating or automatically advancing", async () => {
  api.scene = 1; api.org = null; api.requestId = crypto.randomUUID();
  api.result.mockResolvedValue({ data: { requestId: api.requestId, status: "saved", organization: { id: "saved-org", name: "Saved fixture", slug: "saved-fixture" } }, error: null });
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  expect(screen.getByRole("status").textContent).toContain("Saved fixture");
  expect(api.result).toHaveBeenCalledExactlyOnceWith(`/organization/creation-result?requestId=${api.requestId}`, expect.objectContaining({ method: "GET", retry: 0 }));
  expect(api.create).not.toHaveBeenCalled(); expect(api.activate).not.toHaveBeenCalled(); expect(api.routeNavigate).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Continue setup/ })));
  expect(api.routeNavigate).toHaveBeenCalledExactlyOnceWith({ search: { orgId: "saved-org" }, replace: true });
  expect(api.create).not.toHaveBeenCalled();
});

it("ignores a late creation reply, then retries exactly the same command and identity", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.slug.mockResolvedValue({ available: true, suggestion: null });
  let release: (value: unknown) => void = () => {};
  api.create.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Retry fixture" } });
  await act(async () => vi.advanceTimersByTimeAsync(450));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my show/ })));
  const first = api.create.mock.calls[0][0];
  expect(api.routeNavigate).toHaveBeenCalledExactlyOnceWith({ search: { mode: "new", creationRequestId: first.fetchOptions.headers["Idempotency-Key"] }, replace: true });
  expect(first.fetchOptions.headers["X-ShowPilot-Setup"]).toBe("1");
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  const saved = { data: { id: "saved-org", name: "Retry fixture", slug: "retry-fixture", creationRequestId: first.fetchOptions.headers["Idempotency-Key"] }, error: null };
  await act(async () => release(saved));
  expect(screen.queryByRole("button", { name: /Continue setup/ })).toBeNull();
  expect(screen.getByLabelText("Organization name")).toHaveProperty("readOnly", true);
  expect(api.routeNavigate).toHaveBeenCalledTimes(1);
  api.create.mockResolvedValueOnce(saved);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Retry creation/ })));
  const second = api.create.mock.calls[1][0];
  expect(second.name).toBe(first.name); expect(second.slug).toBe(first.slug);
  expect(second.fetchOptions.headers).toEqual(first.fetchOptions.headers);
  expect(api.routeNavigate).toHaveBeenLastCalledWith({ search: { orgId: "saved-org" }, replace: true });
  expect(api.activate).not.toHaveBeenCalled();
});

it("bounds receipt reads and address checks and offers explicit retries", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.requestId = crypto.randomUUID();
  api.result.mockImplementationOnce(() => new Promise(() => {}));
  api.slug.mockImplementationOnce(() => new Promise(() => {}));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(api.result.mock.calls[0][1].signal.aborted).toBe(true);
  api.result.mockResolvedValue({ data: { requestId: api.requestId, status: "empty" }, error: null });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check saved workspace" })));
  expect(screen.getByRole("status").textContent).toContain("An earlier request may still finish");
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Address fixture" } });
  await act(async () => vi.advanceTimersByTimeAsync(10_450));
  expect(screen.getByRole("alert").textContent).toContain("Could not check this workspace address");
  expect(api.slug.mock.calls[0][0].signal.aborted).toBe(true);
  api.slug.mockResolvedValue({ available: true, suggestion: null });
  fireEvent.click(screen.getByRole("button", { name: "Retry address check" }));
  await act(async () => vi.advanceTimersByTimeAsync(450));
  expect(screen.getByRole("button", { name: /Build my show/ })).toHaveProperty("disabled", false);
  expect(api.create).not.toHaveBeenCalled();
});

it("does not send creation if preserving the recovery URL stalls", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.slug.mockResolvedValue({ available: true, suggestion: null });
  let release: () => void = () => {};
  api.routeNavigate.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Navigation fixture" } });
  await act(async () => vi.advanceTimersByTimeAsync(450));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my show/ })));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
  await act(async () => release());
  expect(api.create).not.toHaveBeenCalled();
});

it("bounds verification resend without reporting an unsent email as sent", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.verified = false;
  api.verify.mockImplementationOnce(() => new Promise(() => {}));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resend verification email" })));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
  expect(api.verify.mock.calls[0][0].fetchOptions.signal.aborted).toBe(true);
  expect(screen.queryByText("Email sent — check your inbox")).toBeNull();
  api.verify.mockResolvedValue({ error: null });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resend verification email" })));
  expect(screen.getByRole("button", { name: "Email sent — check your inbox" })).toHaveProperty("disabled", true);
  expect(api.create).not.toHaveBeenCalled();
});

it("requires an acknowledgement of this creation identity before advancing", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.slug.mockResolvedValue({ available: true, suggestion: null });
  api.create.mockResolvedValue({ data: { id: "legacy-org", name: "Legacy", slug: "legacy-fixture" }, error: null });
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Legacy fixture" } });
  await act(async () => vi.advanceTimersByTimeAsync(450));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my show/ })));
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
  expect(screen.getByRole("alert").textContent).not.toContain("invalid_type");
  expect(api.routeNavigate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: /Continue setup/ })).toBeNull();
});

it("does not begin creation when Exit opens while the recovery URL is being saved", async () => {
  vi.useFakeTimers(); api.scene = 1; api.org = null; api.slug.mockResolvedValue({ available: true, suggestion: null });
  let release: () => void = () => {};
  api.routeNavigate.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Exit before send" } });
  await act(async () => vi.advanceTimersByTimeAsync(450));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my show/ })));
  fireEvent.click(screen.getByRole("button", { name: "Exit setup" }));
  await act(async () => release());
  expect(api.create).not.toHaveBeenCalled();
});
