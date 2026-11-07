import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Route as InviteRoute } from "@/routes/invite/$invitationId";
import { InvitationResponseCard } from "@/components/invitations/InvitationResponseCard";
import type { InvitationView } from "../invitation-view";
const api = vi.hoisted(() => ({ session: vi.fn(), details: vi.fn(), accept: vi.fn(), reject: vi.fn(), active: vi.fn(), signout: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: api.session, getInvitationDetails: api.details, acceptInvitation: api.accept, rejectInvitation: api.reject, setActiveOrg: api.active }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: api.signout } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
async function open() {
  api.session.mockResolvedValue({ user: { id: "invitee", email: "invitee@example.test", emailVerified: true } });
  api.details.mockResolvedValue({ status: "pending", email: "invitee@example.test", invitation: { id: "fixture-invite", expiresAt: Date.now() + 3600_000, role: "member", organization: { id: "org", name: "Fixture workspace", slug: "fixture" } } });
  const root = createRootRoute();
  Object.assign(InviteRoute.options, { getParentRoute: () => root, id: "/invite/$invitationId", path: "/invite/$invitationId" });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home fixture</p> });
  const router = createRouter({ routeTree: root.addChildren([InviteRoute, index]), history: createMemoryHistory({ initialEntries: ["/invite/fixture-invite"] }) });
  await router.load(); await act(async () => render(<RouterProvider router={router} />));
  return router;
}
it("Decline sends a rejection and stays on the invite until the result is confirmed", async () => {
  api.reject.mockReturnValue(new Promise(() => {}));
  const router = await open();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Decline" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Decline invitation" })));
  expect(api.reject).toHaveBeenCalled();
  expect(router.state.location.pathname).toBe("/invite/fixture-invite");
});
it("shows a rejected decline with recovery instead of silently navigating home", async () => {
  api.reject.mockRejectedValue(new Error("Fixture connection failed"));
  const router = await open();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Decline" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Decline invitation" })));
  expect(router.state.location.pathname).toBe("/invite/fixture-invite");
  expect(screen.getByRole("alert").textContent).toContain("Fixture connection failed");
});

function pending() {
  return { status: "pending", email: "invitee@example.test", invitation: { id: "fixture-invite", expiresAt: Date.now() + 3600_000, role: "member", organization: { id: "org", name: "Fixture workspace", slug: "fixture" } } } satisfies InvitationView;
}
function card(initial: InvitationView = pending()) {
  const navigate = vi.fn().mockResolvedValue(undefined);
  api.details.mockResolvedValue(initial);
  return { ...render(<InvitationResponseCard initial={initial} invitationId="fixture-invite" navigate={navigate} />), navigate };
}
async function click(name: string) { await act(async () => fireEvent.click(screen.getByRole("button", { name }))); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("cancels Decline without sending a response", async () => {
  card(); await click("Decline"); await click("Cancel");
  expect(api.reject).not.toHaveBeenCalled(); expect(api.accept).not.toHaveBeenCalled();
});
it("bounds an uncertain acceptance and recovers by reading without another write", async () => {
  vi.useFakeTimers(); const saved = deferred<unknown>(); api.accept.mockReturnValue(saved.promise);
  const { navigate } = card(); await click("Accept & Join");
  await act(async () => vi.advanceTimersByTimeAsync(10_001));
  expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
  expect(api.accept.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => saved.resolve({ invitation: { status: "accepted" } }));
  expect(screen.queryByRole("button", { name: "Open workspace" })).toBeNull();
  api.details.mockResolvedValue({ ...pending(), status: "accepted" });
  await click("Check invitation status");
  expect(screen.getByRole("button", { name: "Open workspace" })).toBeTruthy();
  expect(api.accept).toHaveBeenCalledTimes(1); expect(api.active).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
});
it("retries the same decline and confirms its saved result", async () => {
  api.reject.mockRejectedValueOnce(new Error("Fixture delivery failed")).mockResolvedValueOnce({ invitation: { status: "rejected" } });
  card(); await click("Decline"); await click("Decline invitation"); await click("Retry decline");
  expect(api.reject.mock.calls.map(call => call[0].data)).toEqual(["fixture-invite", "fixture-invite"]);
  expect(screen.getByRole("status").textContent).toContain("Your decline was saved");
  expect(api.active).not.toHaveBeenCalled();
});
it("bounds a status read without issuing acceptance and ignores its late result", async () => {
  vi.useFakeTimers(); const read = deferred<InvitationView>(); card(); api.details.mockReturnValueOnce(read.promise);
  await click("Accept & Join");
  await act(async () => vi.advanceTimersByTimeAsync(10_001));
  expect(api.accept).not.toHaveBeenCalled();
  await act(async () => read.resolve(pending()));
  expect(api.accept).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Retry acceptance" })).toBeTruthy();
});
it("does not activate or navigate after leaving during the final access check", async () => {
  const read = deferred<InvitationView>(); const view = card({ ...pending(), status: "accepted" });
  api.details.mockReturnValueOnce(read.promise); await click("Open workspace"); view.unmount();
  expect(api.details.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => read.resolve({ ...pending(), status: "accepted" }));
  expect(api.active).not.toHaveBeenCalled(); expect(view.navigate).not.toHaveBeenCalled();
});
it("requires an explicit workspace open and preserves recovery when activation fails", async () => {
  const { navigate } = card({ ...pending(), status: "accepted" });
  api.active.mockRejectedValueOnce(new Error("Fixture activation failed")).mockResolvedValueOnce({});
  expect(api.active).not.toHaveBeenCalled(); await click("Open workspace");
  expect(screen.getByRole("alert").textContent).toContain("Fixture activation failed"); expect(navigate).not.toHaveBeenCalled();
  await click("Retry opening workspace"); expect(navigate).toHaveBeenCalledExactlyOnceWith("/fixture");
});
it("rechecks access before opening and never activates removed membership", async () => {
  const { navigate } = card({ ...pending(), status: "accepted" });
  api.details.mockResolvedValue({ ...pending(), status: "access-removed" });
  await click("Open workspace");
  expect(screen.getByRole("heading", { name: "Workspace access has changed" })).toBeTruthy();
  expect(api.active).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
});
it("keeps the invitation destination through the main signup and verification flows", () => {
  const view = card({ status: "signed-out" });
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.getByRole("link", { name: "Create account" }).getAttribute("href")).toBe("/login?returnTo=%2Finvite%2Ffixture-invite&signup=1");
  view.unmount(); card({ status: "unverified", email: "invitee@example.test" });
  expect(screen.getByRole("link", { name: "Verify email" }).getAttribute("href")).toBe("/verify-email?returnTo=%2Finvite%2Ffixture-invite");
  expect(screen.queryByRole("button", { name: "Accept & Join" })).toBeNull();
});
it("contains sign-out failure while retaining the invitation destination", async () => {
  const { navigate } = card({ status: "wrong-account", email: "other@example.test" });
  api.signout.mockResolvedValueOnce({ error: { message: "Fixture denial" } }).mockResolvedValueOnce({ error: null });
  await click("Use another account"); expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("sign out");
  await click("Retry sign out"); expect(navigate).toHaveBeenCalledExactlyOnceWith("/login?returnTo=%2Finvite%2Ffixture-invite");
});
it("disables responses when an open invitation expires", async () => {
  vi.useFakeTimers(); const initial = pending(); initial.invitation.expiresAt = Date.now() + 1000;
  card(initial); await act(async () => vi.advanceTimersByTimeAsync(1001));
  expect(screen.getByRole("heading", { name: "Invitation expired" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept & Join" })).toBeNull();
  expect(api.accept).not.toHaveBeenCalled(); expect(api.reject).not.toHaveBeenCalled();
});


it("hydrates an invitation when server and viewer default timezones differ", async () => {
  const initial = pending();
  const navigate = vi.fn().mockResolvedValue(undefined);
  const format = Date.prototype.toLocaleString;
  let fallbackTimeZone = "UTC";
  const formatting = vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function(this: Date, locale, options) {
    return format.call(this, locale, { ...options, timeZone: options?.timeZone ?? fallbackTimeZone });
  });
  const element = <InvitationResponseCard initial={initial} invitationId="fixture-invite" navigate={navigate} />;
  const container = document.createElement("div"); document.body.appendChild(container);
  container.innerHTML = renderToString(element);
  fallbackTimeZone = "America/Toronto";
  const onRecoverableError = vi.fn(); let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, element, { onRecoverableError }); });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Accept & Join");
  } finally {
    await act(async () => root?.unmount());container.remove();formatting.mockRestore();
  }
});
