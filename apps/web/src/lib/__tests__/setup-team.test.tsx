vi.mock("@/lib/setup-choices", () => ({ getSetupChoices: async () => ({ settings: {}, workspaceRevision: null, roleValue: null }), saveSetupRole: vi.fn(), saveSetupWorkspace: vi.fn() }));
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { afterEach, expect, it, vi } from "vitest";
import { SetupTeamForm } from "@/components/onboarding/SetupTeam";
import { Route } from "@/routes/_auth/setup";
const submitTeam = vi.fn(async () => {});
vi.mock("@/lib/analytics", () => ({ identifyAnalytics: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/onboarding", () => ({ checkOrgSlug: vi.fn(), getOnboardingProgress: vi.fn(), markOnboardingStarted: vi.fn(), seedOrgTemplate: vi.fn(), getOnboardingSeed: async () => ({ status: "saved", template: "blank", serviceDate: "2026-11-07", showId: null, items: [] }) }));
vi.mock("@/lib/setup-save", () => ({ getSetupTeam: async () => ({ batch: null, invitations: [], completed: false }), saveSetupTeam: vi.fn(), sendSetupInvitation: vi.fn(), finishSetupTeam: vi.fn() }));
vi.mock("@/lib/workspace/profile", () => ({ getWorkspaceProfile: vi.fn(), setWorkspaceModules: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(async () => {}) }), useBlocker: () => ({ status: "idle" }),
  createFileRoute: () => (options: unknown) => ({ options,
    useSearch: () => ({}), useNavigate: () => vi.fn(),
    useRouteContext: () => ({ user: { id: "fixture-owner", email: "owner@example.test", emailVerified: true } }),
    useLoaderData: () => ({ initialScene: 5, initialWorkspace: resolveWorkspaceProfile({}), progress: { org: { id: "fixture", name: "Fixture", slug: "fixture" }, archetype: "td", seededTemplate: "blank" } }),
  }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
function openTeam() { return render(<SetupTeamForm taking={false} onGoLive={submitTeam} />); }
it("keeps entered crew when returning from the saved rundown review", async () => {
  vi.useFakeTimers();
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing wizard");
  await act(async () => render(<Wizard />));
  fireEvent.change(screen.getByLabelText("Crew 1 name"), { target: { value: "Preserved crew" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" })); await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByRole("heading", { name: "Continue with your workspace" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Get your team in" })); await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByRole("textbox", { name: "Crew 1 name" })).toHaveProperty("value", "Preserved crew");
});
async function submit() { await act(async () => fireEvent.click(screen.getByRole("button", { name: "Finish setup" }))); }
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
it("preserves invalid rows and prevents submission", async () => {
  openTeam(); fill("Crew 1 name", "Camera fixture"); fill("Invitation 1 email", "not-an-email");
  await submit(); expect(submitTeam).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("2 rows need attention");
  expect(screen.getByLabelText("Crew 1 name")).toHaveProperty("value", "Camera fixture");
  expect(screen.getByLabelText("Invitation 1 email")).toHaveProperty("value", "not-an-email");
});
it("labels crew and invitation controls independently", () => {
  openTeam(); expect(screen.getByLabelText("Crew 1 name")).toHaveProperty("tagName", "INPUT");
  expect(screen.getByLabelText("Crew 1 position")).toHaveProperty("tagName", "INPUT");
  expect(screen.getByLabelText("Invitation 1 email")).toHaveProperty("type", "email");
  expect(screen.getByLabelText("Invitation 1 role")).toHaveProperty("tagName", "SELECT");
});
it("corrects and normalizes a draft, and locks fields while its parent saves", async () => {
  const view = openTeam(); fill("Crew 1 name", " Camera fixture "); await submit();
  const position = screen.getByLabelText("Crew 1 position"); expect(document.activeElement).toBe(position);
  expect(position.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(position.getAttribute("aria-describedby") ?? "")?.textContent).toContain("Enter a position");
  fill("Crew 1 position", " Camera 2 "); fill("Invitation 1 email", " Lead@Example.test ");
  expect(screen.queryByRole("alert")).toBeNull(); await submit();
  expect(submitTeam).toHaveBeenCalledExactlyOnceWith({ crew: [{ name: "Camera fixture", pos: "Camera 2" }], invites: [{ email: "lead@example.test", role: "member" }] });
  view.rerender(<SetupTeamForm taking onGoLive={submitTeam} />);
  expect(screen.getByLabelText("Crew 1 name")).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Invitation 1 role")).toHaveProperty("disabled", true);
  const button = screen.getByRole("button", { name: "Finishing setup…" }); expect(button).toHaveProperty("disabled", true);
  const form = button.closest("form"); if (!form) throw new Error("Missing form");
  fireEvent.submit(form); expect(submitTeam).toHaveBeenCalledTimes(1);
});
it("rejects a selected role without an email", async () => {
  openTeam(); fill("Invitation 1 role", "td"); await submit();
  expect(screen.getByRole("alert").textContent).toContain("1 row needs attention"); expect(submitTeam).not.toHaveBeenCalled();
});
it("blocks duplicate emails after normalization", async () => {
  openTeam(); fill("Invitation 1 email", " LEAD@example.test "); fireEvent.click(screen.getByRole("button", { name: "Add another invitation" }));
  fill("Invitation 2 email", "lead@example.test"); await submit();
  expect(screen.getByRole("alert").textContent).toContain("2 rows need attention");
  expect(screen.getAllByText("This email appears more than once. Keep one invitation.")).toHaveLength(2); expect(submitTeam).not.toHaveBeenCalled();
});
it.each([
  ["Crew 1 name", "n".repeat(201), "Crew 1 position", "Camera"],
  ["Crew 1 position", "p".repeat(101), "Crew 1 name", "Fixture"],
  ["Invitation 1 email", "person..name@example.test", null, null],
  ["Invitation 1 email", "x".repeat(245) + "@example.test", null, null],
])("checks server-compatible limits for %s", async (label, value, otherLabel, otherValue) => {
  openTeam(); if (otherLabel && otherValue) fill(otherLabel, otherValue); fill(label, value); await submit();
  expect(screen.getByRole("alert").textContent).toContain("1 row needs attention"); expect(submitTeam).not.toHaveBeenCalled();
});
it("explicitly clears invalid rows and submits an empty optional team", async () => {
  openTeam(); fill("Crew 1 name", "Incomplete"); fill("Invitation 1 role", "admin"); await submit();
  fireEvent.click(screen.getByRole("button", { name: "Clear crew row 1" })); fireEvent.click(screen.getByRole("button", { name: "Clear invitation row 1" }));
  expect(screen.queryByRole("alert")).toBeNull(); await submit(); expect(submitTeam).toHaveBeenCalledExactlyOnceWith({ crew: [], invites: [] });
});
it("supports keyboard submission with optional blank extra rows and explains completion", async () => {
  openTeam(); fireEvent.click(screen.getByRole("button", { name: "Add another crew member" })); fill("Crew 1 name", "Fixture"); fill("Crew 1 position", "A1");
  expect(screen.getByText(/does not start a show or turn on outputs/)).toBeTruthy();
  const form = screen.getByRole("button", { name: "Finish setup" }).closest("form"); if (!form) throw new Error("Missing form");
  await act(async () => fireEvent.submit(form)); expect(submitTeam).toHaveBeenCalledExactlyOnceWith({ crew: [{ name: "Fixture", pos: "A1" }], invites: [] });
});
it("hydrates the six-step header across server/browser time zones", async () => {
  const Wizard = Route.options.component; if (!Wizard) throw new Error("Missing setup component");
  const hours = vi.spyOn(Date.prototype, "getHours").mockReturnValue(9);
  const container = document.createElement("div"); document.body.appendChild(container); container.innerHTML = renderToString(<Wizard />);
  hours.mockReturnValue(20); const onRecoverableError = vi.fn(); let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, <Wizard />, { onRecoverableError }); });
    expect(onRecoverableError).not.toHaveBeenCalled(); expect(container.textContent).toContain("Step 6 of 6");
  } finally { await act(async () => root?.unmount()); container.remove(); hours.mockRestore(); }
});

it("keeps an uncertain draft locked without claiming it is still saving", () => {
  render(<SetupTeamForm taking={false} locked onGoLive={submitTeam} />);
  expect(screen.getByLabelText("Crew 1 name")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Team awaiting confirmation" })).toHaveProperty("disabled", true);
  expect(screen.queryByText("Finishing setup…")).toBeNull();
});
