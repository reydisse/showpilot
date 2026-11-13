import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "./$slug/production/incidents-history";

const IncidentHistoryPage = Route.options.component;
if (!IncidentHistoryPage) throw new Error("Incident history must have a page component.");

const router = vi.hoisted(() => ({
  search: { query: "", status: "all", severity: "all", category: "", assignee: "", from: "", to: "", sort: "newest", page: 1 },
  navigate: vi.fn(),
}));
vi.mock("@/lib/incident-history", () => ({ getIncidentHistory: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, fullPath: "/$slug/production/incidents-history", useParams: () => ({ slug: "fixture" }), useSearch: () => router.search, useLoaderData: () => ({ incidents: [], categories: [], total: 0, page: 1, pageSize: 30 }) }),
  useNavigate: () => router.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
beforeEach(() => {
  vi.useFakeTimers();
  router.search = { query: "", status: "all", severity: "all", category: "", assignee: "", from: "", to: "", sort: "newest", page: 1 };
  router.navigate.mockReset().mockImplementation(({ search }) => { router.search = typeof search === "function" ? search(router.search) : search; return Promise.resolve(); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(351); });

it("keeps the selected status when an earlier search debounce completes", async () => {
  const view = render(<IncidentHistoryPage />);
  fireEvent.change(screen.getByPlaceholderText("Search issues, people, categories…"), { target: { value: "camera" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "open" } });
  view.rerender(<IncidentHistoryPage />);
  await tick();
  expect(router.search).toMatchObject({ query: "camera", status: "open", page: 1 });
});

it("cancels a pending search when Clear filters is clicked", async () => {
  render(<IncidentHistoryPage />);
  fireEvent.change(screen.getByPlaceholderText("Search issues, people, categories…"), { target: { value: "camera" } });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await tick();
  expect(router.search.query).toBe("");
  expect(screen.getByPlaceholderText("Search issues, people, categories…")).toHaveProperty("value", "");
});
