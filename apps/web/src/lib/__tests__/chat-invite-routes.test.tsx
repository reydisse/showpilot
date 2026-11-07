import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Route as PlanningRoute } from "@/routes/join/chat/planning/$token";
const api = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("@/lib/crew-chat-pass", () => ({ validatePlanningChatPass: api.validate }));

it("redirects an authorized Planning invite before rendering any wrong-member card", async () => {
  api.validate.mockResolvedValue({ status: "authorized", orgSlug: "fixture" });
  const root = createRootRoute();
  // The same static file-route initialization performed by routeTree.gen.ts.
  Object.assign(PlanningRoute.options, { getParentRoute: () => root, id: "/join/chat/planning/$token", path: "/join/chat/planning/$token" });
  const router = createRouter({ routeTree: root.addChildren([PlanningRoute]), isServer: true,
    history: createMemoryHistory({ initialEntries: ["/join/chat/planning/fixture-token"] }),
  });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  expect(html).not.toContain("This invite is for another member");
  expect(router._serverResult).toMatchObject({ type: "redirect" });
});

it.each([
  ["invalid", "This Planning invite is invalid"],
  ["revoked", "This Planning invite was revoked"],
  ["expired", "This Planning invite has expired"],
  ["unavailable", "This Planning invite is no longer available"],
  ["wrong-account", "This invite is for another member"],
  ["access-removed", "Your Planning access has changed"],
])("renders the actual Planning outcome: %s", async (status, heading) => {
  api.validate.mockResolvedValue({ status });
  const root = createRootRoute();
  Object.assign(PlanningRoute.options, { getParentRoute: () => root, id: "/join/chat/planning/$token", path: "/join/chat/planning/$token" });
  const router = createRouter({ routeTree: root.addChildren([PlanningRoute]), isServer: true, history: createMemoryHistory({ initialEntries: ["/join/chat/planning/fixture-token"] }) });
  await router.load();
  expect(renderToString(<RouterProvider router={router} />)).toContain(heading);
  expect(router._serverResult).toMatchObject({ type: "render", status: 200 });
});

it("carries the invite through sign-in without asking the member to reopen it", async () => {
  api.validate.mockResolvedValue({ status: "signed-out" });
  const root = createRootRoute();
  Object.assign(PlanningRoute.options, { getParentRoute: () => root, id: "/join/chat/planning/$token", path: "/join/chat/planning/$token" });
  const router = createRouter({ routeTree: root.addChildren([PlanningRoute]), isServer: true, history: createMemoryHistory({ initialEntries: ["/join/chat/planning/fixture-token"] }) });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  expect(html).toContain("/login?returnTo=%2Fjoin%2Fchat%2Fplanning%2Ffixture-token");
  expect(html).not.toContain("This invite is for another member");
});
