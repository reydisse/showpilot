import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FirstSessionChecklist } from "./FirstSessionChecklist";

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/onboarding", () => ({
  getFirstSessionChecklist: api.read,
  updateFirstSessionChecklist: api.write,
}));
vi.mock("@/components/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    modules: ["rundown", "devices", "team"],
    terms: { item: "Item" },
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="#fixture">{children}</a>
  ),
}));

let client: QueryClient;
const initial = { show: true, completed: [], snapshot: null };
const mount = () =>
  render(
    <QueryClientProvider client={client}>
      <FirstSessionChecklist orgId="org" slug="org" userId="operator" />
    </QueryClientProvider>,
  );
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api.read.mockResolvedValue(initial);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.resetAllMocks();
});
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });

it("shows a failed checklist read and recovers by Retry", async () => {
  api.read.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => {
    mount();
  });
  await flush();
  expect(screen.getByRole("alert").textContent).toContain("checklist");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retry checklist" })),
  );
  await flush();
  expect(
    screen.getByRole("button", { name: "Dismiss checklist" }),
  ).toBeTruthy();
});

it("bounds an unanswered read rather than hiding it indefinitely", async () => {
  api.read.mockImplementation(() => new Promise(() => {}));
  await act(async () => {
    mount();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_001);
  });
  expect(screen.getByRole("alert").textContent).toContain("Last failed read");
  expect(api.read.mock.calls[0][0].signal.aborted).toBe(true);
});

it("does not dismiss on failure and retains the exact retry across remount", async () => {
  api.write.mockRejectedValueOnce(new Error("Save interrupted"));
  let view: ReturnType<typeof mount>;
  await act(async () => {
    view = mount();
  });
  await flush();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Dismiss checklist" })),
  );
  await flush();
  expect(screen.getByRole("alert").textContent).toContain("not confirmed");
  const original = api.write.mock.calls[0][0].data;
  view!.unmount();
  await act(async () => {
    mount();
  });
  await flush();
  api.write.mockResolvedValue({
    requestId: original.requestId,
    outcome: "applied",
    state: { show: false, completed: [], snapshot: "{}" },
  });
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Retry checklist change" }),
    ),
  );
  await flush();
  expect(api.write.mock.calls[1][0].data).toEqual(original);
  expect(
    screen.queryByRole("button", { name: "Dismiss checklist" }),
  ).toBeNull();
});

it("keeps confirmed item state while a save times out and rejects late replies", async () => {
  let release: (value: unknown) => void = () => {};
  api.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => {
    mount();
  });
  await flush();
  const item = screen.getByRole("button", {
    name: 'Mark "Rename a rundown item" done',
  });
  await act(async () => fireEvent.click(item));
  await flush();
  expect(item.getAttribute("aria-pressed")).toBe("false");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_001);
  });
  expect(
    screen.getByRole("button", { name: "Retry checklist change" }),
  ).toBeTruthy();
  expect(api.write.mock.calls[0][0].signal.aborted).toBe(true);
  const requestId = api.write.mock.calls[0][0].data.requestId;
  await act(async () =>
    release({
      requestId,
      outcome: "applied",
      state: { show: true, completed: ["rename-item"], snapshot: "{}" },
    }),
  );
  await flush();
  expect(item.getAttribute("aria-pressed")).toBe("false");
  expect(
    screen.getByRole("button", { name: "Retry checklist change" }),
  ).toBeTruthy();
});

it("shows conflicting progress for review without automatically repeating the action", async () => {
  api.write.mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    outcome: "conflict",
    state: { show: true, completed: ["rename-item"], snapshot: "saved" },
  }));
  await act(async () => {
    mount();
  });
  await flush();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Dismiss checklist" })),
  );
  await flush();
  expect(screen.getByRole("alert").textContent).toContain("not applied");
  expect(
    (
      screen.getByRole("button", {
        name: "Dismiss checklist",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Use saved checklist" }),
    ),
  );
  await flush();
  expect(
    (
      screen.getByRole("button", {
        name: "Dismiss checklist",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(api.write).toHaveBeenCalledTimes(1);
});
