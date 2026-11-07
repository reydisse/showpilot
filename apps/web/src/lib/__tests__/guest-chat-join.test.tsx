import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Route as GuestRoute } from "@/routes/join/chat.$token";
const api = vi.hoisted(() => ({ validate: vi.fn(), chat: vi.fn(() => ({})) }));
vi.mock("@/lib/crew-chat-pass", () => ({ validateCrewChatPass: api.validate }));
vi.mock("@/hooks/useChat", () => ({ useChat: api.chat }));
vi.mock("@/components/chat/ChatPanel", () => ({ ChatPanel: () => <h1>Guest chat connected</h1> }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
async function renderJoin() {
  const root = createRootRoute();
  Object.assign(GuestRoute.options, { getParentRoute: () => root, id: "/join/chat/$token", path: "/join/chat/$token" });
  const router = createRouter({ routeTree: root.addChildren([GuestRoute]), history: createMemoryHistory({ initialEntries: ["/join/chat/fixture-token"] }) });
  await router.load();
  await act(async () => render(<RouterProvider router={router} />));
  return router;
}
it("waits for an explicit named guest join and clears that identity when the token changes", async () => {
  api.validate.mockResolvedValue({ status: "valid", pass: { orgId: "org", orgSlug: "venue", exp: Math.floor(Date.now()/1000)+3600 } });
  const router = await renderJoin();
  expect(api.chat).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Camera fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Join Team Chat" }));
  expect(api.chat).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org", guestToken: "fixture-token", senderName: "Camera fixture" }));
  expect(screen.getByRole("heading", { name: "Guest chat connected" })).toBeTruthy();
  api.chat.mockClear();
  await act(async () => router.navigate({ href: "/join/chat/another-token" }));
  expect(screen.getByLabelText("Display name")).toHaveProperty("value", "");
  expect(screen.queryByRole("heading", { name: "Guest chat connected" })).toBeNull();
  expect(api.chat).not.toHaveBeenCalledWith(expect.objectContaining({ guestToken: "another-token" }));
});
it("removes the chat when its signed access period ends", async () => {
  vi.useFakeTimers();
  api.validate.mockResolvedValue({ status: "valid", pass: { orgId: "org", orgSlug: "venue", exp: Math.floor(Date.now()/1000)+2 } });
  await renderJoin();
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Camera fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Join Team Chat" }));
  expect(screen.getByRole("heading", { name: "Guest chat connected" })).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(2100));
  expect(screen.getByRole("heading", { name: "This crew pass has expired" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Guest chat connected" })).toBeNull();
});
it.each(["invalid", "expired", "unavailable"])("never connects or requests a guest name for a %s pass", async status => {
  api.validate.mockResolvedValue({ status });
  await renderJoin();
  expect(screen.queryByLabelText("Display name")).toBeNull();
  expect(api.chat).not.toHaveBeenCalled();
});
