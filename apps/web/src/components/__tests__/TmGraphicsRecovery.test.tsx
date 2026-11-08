import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TmGraphicsControls } from "../dashboard/TmGraphicsControls";
import type { GraphicsClearSnapshot } from "@/lib/graphics-clear-contract";
const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/tm-graphics", () => ({
  getTmGraphicsState: rpc.read,
  writeTmGraphicsClear: rpc.write,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
let client: QueryClient;
const state: GraphicsClearSnapshot = {
  programRevision: 3,
  relayRevision: 4,
  serverTime: 0,
  program: [{ id: "program", title: "Program title" }],
  programUnknown: false,
  lowerThirds: ["Speaker name"],
  canClear: true,
};
beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  rpc.read
    .mockReset()
    .mockImplementation(async () => ({ ...state, serverTime: Date.now() }));
  rpc.write.mockReset().mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    program: "applied",
    relay: "applied",
  }));
});
afterEach(() => {
  cleanup();
  client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});
const tick = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const element = (userId = "user", orgId = "org") => (
  <QueryClientProvider client={client}>
    <TmGraphicsControls orgId={orgId} userId={userId} slug="org" />
  </QueryClientProvider>
);
async function view() {
  const mounted = render(element());
  await tick();
  return mounted;
}
async function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "Clear graphics" }));
  await tick();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Clear graphics now",
    }),
  );
  await tick();
}
it("bounds an initial read and keeps retry pending without showing an empty output", async () => {
  rpc.read.mockImplementation(() => new Promise(() => {}));
  await view();
  await tick(8100);
  expect(screen.queryByText("No Program graphics on air")).toBeNull();
  expect(screen.getByRole("button", { name: "Clear graphics" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry graphics feedback" }),
  );
  await tick();
  expect(screen.getByText("Retrying…")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry graphics feedback" }),
  ).toHaveProperty("disabled", true);
});
it("names both outputs and cancels without clearing", async () => {
  await view();
  fireEvent.click(screen.getByRole("button", { name: "Clear graphics" }));
  await tick();
  expect(screen.getByRole("dialog").textContent).toContain(
    "Program title, Speaker name",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await tick();
  expect(rpc.write).not.toHaveBeenCalled();
});
it("retains the reviewed revisions while newer feedback arrives during confirmation", async () => {
  await view();
  fireEvent.click(screen.getByRole("button", { name: "Clear graphics" }));
  await tick();
  rpc.read.mockImplementation(async () => ({
    ...state,
    programRevision: 9,
    relayRevision: 10,
    serverTime: Date.now(),
  }));
  await tick(2100);
  fireEvent.click(screen.getByRole("button", { name: "Clear graphics now" }));
  await tick();
  expect(rpc.write.mock.calls[0][0].data).toMatchObject({
    expectedProgramRevision: 3,
    expectedRelayRevision: 4,
  });
});
it("bounds a stalled Clear and retries the exact original command across navigation", async () => {
  rpc.write.mockImplementationOnce(() => new Promise(() => {}));
  const mounted = await view();
  await confirm();
  await tick(10100);
  expect(screen.getByRole("button", { name: "Clear graphics" })).toHaveProperty(
    "disabled",
    true,
  );
  const original = rpc.write.mock.calls[0][0].data;
  mounted.unmount();
  render(element());
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Retry graphics clear" }));
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(original);
});
it("isolates pending commands from another account and discards confirmations on scope change", async () => {
  const mounted = await view();
  fireEvent.click(screen.getByRole("button", { name: "Clear graphics" }));
  await tick();
  mounted.rerender(element("other", "another"));
  await tick();
  expect(screen.queryByRole("dialog")).toBeNull();
  rpc.write.mockRejectedValueOnce(new Error("Lost reply"));
  await confirm();
  mounted.rerender(element());
  await tick();
  expect(
    screen.queryByRole("button", { name: "Retry graphics clear" }),
  ).toBeNull();
});
it("reports partial completion instead of claiming all outputs are clear", async () => {
  rpc.write.mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    program: "applied",
    relay: "conflict",
  }));
  await view();
  await confirm();
  expect(
    screen.getByText(
      "Program cleared. A newer lower third was preserved. Review current output before clearing again.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Clear request confirmed/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Retry graphics clear" }),
  ).toBeNull();
});
it("preserves confirmed success when the following read fails", async () => {
  await view();
  rpc.read.mockRejectedValue(new Error("Read failed"));
  await confirm();
  expect(
    screen.getByText(
      "Clear request confirmed. Current graphics are shown above.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry graphics feedback" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Retry graphics clear" }),
  ).toBeNull();
  expect(screen.getByText("Program title")).toBeTruthy();
});
it("shows expired commands as requiring a fresh review", async () => {
  rpc.write.mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    program: "expired",
    relay: "skipped",
  }));
  await view();
  await confirm();
  expect(
    screen.getByText(
      "Clear expired before changing output. Review current graphics before trying again.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Retry graphics clear" }),
  ).toBeNull();
});
it("allows a reviewed clear of unreadable saved output without treating it as idle", async () => {
  rpc.read.mockImplementation(async () => ({
    ...state,
    program: [],
    lowerThirds: [],
    programUnknown: true,
    serverTime: Date.now(),
  }));
  await view();
  expect(screen.getByRole("button", { name: "Clear graphics" })).toHaveProperty(
    "disabled",
    false,
  );
  await confirm();
  expect(rpc.write).toHaveBeenCalledTimes(1);
});
it("disables Clear when feedback confirms no output or missing control permission", async () => {
  rpc.read.mockImplementation(async () => ({
    ...state,
    program: [],
    lowerThirds: [],
    serverTime: Date.now(),
  }));
  await view();
  expect(screen.getByRole("button", { name: "Clear graphics" })).toHaveProperty(
    "disabled",
    true,
  );
  rpc.read.mockImplementation(async () => ({
    ...state,
    canClear: false,
    serverTime: Date.now(),
  }));
  await tick(2100);
  expect(
    screen.getByText("Graphics control permission is required."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clear graphics" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("pauses hidden polling and coalesces pending feedback reads", async () => {
  await view();
  act(() => focusManager.setFocused(false));
  await tick(6100);
  expect(rpc.read).toHaveBeenCalledTimes(1);
  rpc.read.mockImplementation(() => new Promise(() => {}));
  act(() => focusManager.setFocused(true));
  await tick();
  const count = rpc.read.mock.calls.length;
  expect(count).toBe(2);
  await tick(4100);
  expect(rpc.read).toHaveBeenCalledTimes(count);
});
