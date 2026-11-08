import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TmRundownControls } from "../dashboard/TmRundownControls";
import type { TmRundownSnapshot } from "@/lib/tm-rundown-contract";
const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/tm-rundown", () => ({
  getTmRundownState: rpc.read,
  writeTmRundown: rpc.write,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
let client: QueryClient;
const state: TmRundownSnapshot = {
  target: { showId: "show", serviceDate: "2026-11-08" },
  revision: 7,
  serverTime: 0,
  initialized: true,
  timer: { playback: "play", elapsed: 0 },
  currentItem: { id: "one", title: "First item" },
  nextItem: { id: "two", title: "Second item" },
  firstItem: { id: "one", title: "First item" },
  hasPrevious: false,
  lyricsEnabled: true,
  canControl: true,
  blockedReason: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  rpc.read
    .mockReset()
    .mockImplementation(async () => ({ ...state, serverTime: Date.now() }));
  rpc.write
    .mockReset()
    .mockImplementation(async ({ data }) => ({
      requestId: data.requestId,
      outcome: "applied",
    }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
const tick = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const element = (userId = "user") => (
  <QueryClientProvider client={client}>
    <TmRundownControls orgId="org" userId={userId} slug="org" />
  </QueryClientProvider>
);
async function view() {
  const result = render(element());
  await tick();
  return result;
}
const next = () =>
  screen.getByRole("button", { name: /Next Advance rundown item/ });
it("bounds a stalled rundown feedback read and offers a retry", async () => {
  rpc.read.mockImplementation(() => new Promise(() => {}));
  await view();
  await tick(8100);
  expect(
    screen.getByRole("button", { name: "Retry rundown feedback" }),
  ).toBeTruthy();
});
it("keeps transport disabled when the initial state cannot be confirmed", async () => {
  rpc.read.mockRejectedValue(new Error("Fixture unavailable"));
  await view();
  expect(screen.getByRole("button", { name: /Start timer/ })).toHaveProperty(
    "disabled",
    true,
  );
});
it("bounds a stalled Next command and retries the exact original request", async () => {
  rpc.write.mockImplementationOnce(() => new Promise(() => {}));
  await view();
  fireEvent.click(next());
  await tick(10100);
  expect(next()).toHaveProperty("disabled", true);
  const original = rpc.write.mock.calls[0][0].data;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry rundown command" }),
  );
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(original);
  expect(screen.getByText("Command confirmed.")).toBeTruthy();
});
it("retains the unconfirmed command across navigation and isolates another user", async () => {
  rpc.write.mockRejectedValueOnce(new Error("Lost reply"));
  const mounted = await view();
  fireEvent.click(next());
  await tick();
  mounted.unmount();
  const another = render(element("other"));
  await tick();
  expect(
    screen.queryByRole("button", { name: "Retry rundown command" }),
  ).toBeNull();
  another.unmount();
  render(element());
  await tick();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry rundown command" }),
  );
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(
    rpc.write.mock.calls[0][0].data,
  );
});
it("retains confirmed content and disables transport on a failed refresh", async () => {
  await view();
  rpc.read.mockRejectedValue(new Error("Feedback failed"));
  await tick(2100);
  expect(screen.getByText("First item")).toBeTruthy();
  expect(screen.getByText("Last confirmed state")).toBeTruthy();
  expect(next()).toHaveProperty("disabled", true);
});
it("preserves acknowledged success when the following feedback refresh fails", async () => {
  await view();
  rpc.read.mockRejectedValue(new Error("Feedback failed"));
  fireEvent.click(next());
  await tick();
  expect(screen.getByText("Command confirmed.")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry rundown feedback" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Retry rundown command" }),
  ).toBeNull();
});
it("confirms show end and cancels the dialog when the active show changes", async () => {
  await view();
  fireEvent.click(screen.getByRole("button", { name: /End show Confirm/ }));
  await tick();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(rpc.write).not.toHaveBeenCalled();
  rpc.read.mockResolvedValue({
    ...state,
    target: { ...state.target, showId: "other-show" },
  });
  await tick(2100);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText(/Show changed, confirmation cancelled/)).toBeTruthy();
});
it("keeps End show confirmation open through an item advance", async () => {
  await view();
  fireEvent.click(screen.getByRole("button", { name: /End show Confirm/ }));
  rpc.read.mockResolvedValue({
    ...state,
    serverTime: Date.now(),
    revision: 8,
    currentItem: { id: "two", title: "Second item" },
  });
  await tick(2100);
  fireEvent.click(screen.getByRole("button", { name: "End show" }));
  await tick();
  expect(rpc.write.mock.calls[0][0].data).toMatchObject({
    action: "timer-stop",
    expectedRevision: 8,
    target: state.target,
  });
});
it("requires confirmation before hiding lyrics", async () => {
  await view();
  fireEvent.click(screen.getByRole("button", { name: /Lyrics off/ }));
  await tick();
  expect(rpc.write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Hide lyrics" }));
  await tick();
  expect(rpc.write.mock.calls[0][0].data.action).toBe("lyrics-off");
});
it("does not replay revision conflicts automatically", async () => {
  rpc.write.mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    outcome: "revision-conflict",
  }));
  await view();
  fireEvent.click(next());
  await tick(4100);
  expect(rpc.write).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/rundown changed before this command/)).toBeTruthy();
});
it("exposes a locked rundown and keeps its controls disabled", async () => {
  rpc.read.mockResolvedValue({
    ...state,
    canControl: false,
    blockedReason:
      "Unlock the rundown with its PIN before using these controls.",
  });
  await view();
  expect(next()).toHaveProperty("disabled", true);
  expect(screen.getByText(/Unlock the rundown/)).toBeTruthy();
});
