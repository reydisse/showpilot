import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { afterEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/_auth/setup";

const calls = vi.hoisted(() => ({ crew: vi.fn(), invite: vi.fn(), complete: vi.fn(), navigate: vi.fn() }));
vi.mock("@/lib/data", () => ({ addCrewMember: calls.crew }));
vi.mock("@/lib/session", () => ({ inviteMember: calls.invite }));
vi.mock("@/lib/analytics", () => ({ identifyAnalytics: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/onboarding", () => ({ completeOnboarding: calls.complete, checkOrgSlug: vi.fn(), getOnboardingProgress: vi.fn(), markOnboardingStarted: vi.fn(), saveOnboardingRole: vi.fn(), seedOrgTemplate: vi.fn() }));
vi.mock("@/lib/workspace/profile", () => ({ saveWorkspaceType: vi.fn(), getWorkspaceProfile: vi.fn(), setWorkspaceModules: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options,
    useSearch: () => ({}), useNavigate: () => calls.navigate,
    useRouteContext: () => ({ user: { id: "fixture-owner", email: "owner@example.test", emailVerified: true } }),
    useLoaderData: () => ({ initialScene: 5, initialWorkspace: resolveWorkspaceProfile({}), progress: { org: { id: "fixture", name: "Fixture", slug: "fixture" }, archetype: "td", seededTemplate: "blank" } }),
  }),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });
function openTeam() {
  const Wizard = Route.options.component;
  if (!Wizard) throw new Error("Missing setup component");
  render(<Wizard />);
}
async function submit() { await act(async () => fireEvent.click(screen.getByRole("button", { name: /GO\s*LIVE|Finish setup/ }))); }

it("keeps partial crew and invalid invitations visible and prevents every write", async () => {
  calls.complete.mockImplementation(() => new Promise(() => {}));
  openTeam();
  fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Camera fixture" } });
  fireEvent.change(screen.getByPlaceholderText("name@example.com"), { target: { value: "not-an-email" } });
  await submit();
  expect(calls.complete).not.toHaveBeenCalled();
  expect(calls.crew).not.toHaveBeenCalled();
  expect(calls.invite).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("2 rows need attention");
  expect(screen.getByPlaceholderText("Name")).toHaveProperty("value", "Camera fixture");
  expect(screen.getByPlaceholderText("name@example.com")).toHaveProperty("value", "not-an-email");
});

it("labels crew and invitation controls independently", () => {
  openTeam();
  expect(screen.getByLabelText("Crew 1 name")).toHaveProperty("tagName", "INPUT");
  expect(screen.getByLabelText("Crew 1 position")).toHaveProperty("tagName", "INPUT");
  expect(screen.getByLabelText("Invitation 1 email")).toHaveProperty("type", "email");
  expect(screen.getByLabelText("Invitation 1 role")).toHaveProperty("tagName", "SELECT");
});

it("corrects an invalid draft before submitting trimmed values exactly once", async () => {
  calls.complete.mockImplementation(() => new Promise(() => {}));
  openTeam();
  fireEvent.change(screen.getByLabelText("Crew 1 name"), { target: { value: " Camera fixture " } });
  await submit();
  const position = screen.getByLabelText("Crew 1 position");
  expect(document.activeElement).toBe(position);
  expect(position.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(position.getAttribute("aria-describedby") ?? "")?.textContent).toContain("Enter a position");
  fireEvent.change(position, { target: { value: " Camera 2 " } });
  fireEvent.change(screen.getByLabelText("Invitation 1 email"), { target: { value: " Lead@Example.test " } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("1 complete crew row and 1 complete invitation row");
  await submit();
  expect(calls.crew).toHaveBeenCalledTimes(1);
  expect(calls.crew).toHaveBeenCalledWith({ data: expect.objectContaining({ orgId: "fixture", name: "Camera fixture", role: "Camera 2" }) });
  expect(calls.invite).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "fixture", email: "lead@example.test", role: "member" } });
  expect(screen.getByLabelText("Crew 1 name")).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Invitation 1 role")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Finishing setup…" })).toHaveProperty("disabled", true);
  const form = screen.getByRole("button", { name: "Finishing setup…" }).closest("form");
  if (!form) throw new Error("Missing setup form");
  await act(async () => fireEvent.submit(form));
  expect(calls.crew).toHaveBeenCalledTimes(1);
  expect(calls.invite).toHaveBeenCalledTimes(1);
});

it("does not silently discard an invitation whose role was selected before its email", async () => {
  openTeam();
  fireEvent.change(screen.getByLabelText("Invitation 1 role"), { target: { value: "td" } });
  await submit();
  expect(screen.getByRole("alert").textContent).toContain("1 row needs attention");
  expect(screen.getByLabelText("Invitation 1 email").getAttribute("aria-invalid")).toBe("true");
  expect(calls.complete).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Invitation 1 role")).toHaveProperty("value", "td");
});

it("blocks duplicate invitation addresses regardless of casing or surrounding spaces", async () => {
  openTeam();
  fireEvent.change(screen.getByLabelText("Invitation 1 email"), { target: { value: " LEAD@example.test " } });
  fireEvent.click(screen.getByRole("button", { name: "Add another invitation" }));
  fireEvent.change(screen.getByLabelText("Invitation 2 email"), { target: { value: "lead@example.test" } });
  await submit();
  expect(screen.getByRole("alert").textContent).toContain("2 rows need attention");
  expect(screen.getAllByText("This email appears more than once. Keep one invitation.")).toHaveLength(2);
  expect(calls.invite).not.toHaveBeenCalled();
  expect(calls.complete).not.toHaveBeenCalled();
});

it.each([
  ["Crew 1 name", "n".repeat(201), "Crew 1 position", "Camera"],
  ["Crew 1 position", "p".repeat(101), "Crew 1 name", "Fixture"],
  ["Invitation 1 email", "person..name@example.test", null, null],
  ["Invitation 1 email", "x".repeat(245) + "@example.test", null, null],
])("checks server-compatible limits for %s", async (label, value, otherLabel, otherValue) => {
  openTeam();
  if (otherLabel) fireEvent.change(screen.getByLabelText(otherLabel), { target: { value: otherValue } });
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await submit();
  expect(screen.getByRole("alert").textContent).toContain("1 row needs attention");
  expect(screen.getByLabelText(label).getAttribute("aria-invalid")).toBe("true");
  expect(calls.complete).not.toHaveBeenCalled();
  expect(calls.crew).not.toHaveBeenCalled();
  expect(calls.invite).not.toHaveBeenCalled();
});

it("lets the operator explicitly clear invalid rows and finish with an empty optional team", async () => {
  calls.complete.mockImplementation(() => new Promise(() => {}));
  openTeam();
  fireEvent.change(screen.getByLabelText("Crew 1 name"), { target: { value: "Incomplete" } });
  fireEvent.change(screen.getByLabelText("Invitation 1 role"), { target: { value: "admin" } });
  await submit();
  fireEvent.click(screen.getByRole("button", { name: "Clear crew row 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear invitation row 1" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Invitation 1 role")).toHaveProperty("value", "member");
  await submit();
  expect(calls.crew).not.toHaveBeenCalled();
  expect(calls.invite).not.toHaveBeenCalled();
  expect(calls.complete).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "fixture" } });
});

it("submits a valid keyboard form, leaves untouched extra rows optional and explains the action", async () => {
  calls.complete.mockImplementation(() => new Promise(() => {}));
  openTeam();
  fireEvent.click(screen.getByRole("button", { name: "Add another crew member" }));
  fireEvent.change(screen.getByLabelText("Crew 1 name"), { target: { value: "Fixture" } });
  fireEvent.change(screen.getByLabelText("Crew 1 position"), { target: { value: "A1" } });
  expect(screen.getByText(/Step 6 of 6/)).toBeTruthy();
  expect(screen.getByText(/does not start a show or turn on outputs/)).toBeTruthy();
  const form = screen.getByRole("button", { name: "Finish setup" }).closest("form");
  if (!form) throw new Error("Missing keyboard form");
  await act(async () => fireEvent.submit(form));
  expect(calls.crew).toHaveBeenCalledTimes(1);
  expect(calls.invite).not.toHaveBeenCalled();
});


it("hydrates the setup header without a mismatch when server and browser hours differ", async () => {
  const Wizard = Route.options.component;
  if (!Wizard) throw new Error("Missing setup component");
  const hours = vi.spyOn(Date.prototype, "getHours").mockReturnValue(9);
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.innerHTML = renderToString(<Wizard />);
  hours.mockReturnValue(20);
  const onRecoverableError = vi.fn();
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, <Wizard />, { onRecoverableError }); });
    expect(onRecoverableError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    hours.mockRestore();
  }
});
