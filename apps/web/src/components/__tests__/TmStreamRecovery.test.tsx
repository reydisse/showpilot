import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TmStreamControls } from "../dashboard/TmStreamControls";
import type { TmStreamSnapshot } from "@/lib/tm-stream-contract";
const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/tm-stream", () => ({
  getTmStreamState: rpc.read,
  writeTmStream: rpc.write,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
let client: QueryClient;
const state: TmStreamSnapshot = {
  canControl: true,
  inputs: [{ id: "input", name: "Main encoder" }],
  destinations: [
    {
      id: "one",
      name: "Main destination",
      version: "reviewed-version",
      enabled: true,
      status: "none",
    },
  ],
};
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  rpc.read.mockReset().mockResolvedValue(state);
  rpc.write.mockReset().mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    results: data.targets.map((target: { id: string }) => ({
      id: target.id,
      success: true,
    })),
  }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
const tick = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const element = (userId = "user", orgId = "org") => (
  <QueryClientProvider client={client}>
    <TmStreamControls userId={userId} orgId={orgId} slug="org" />
  </QueryClientProvider>
);
async function view() {
  const mounted = render(element());
  await tick();
  return mounted;
}
async function confirm(action = "Go live", confirm = "Go live now") {
  fireEvent.click(screen.getByRole("button", { name: action }));
  await tick();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: confirm }),
  );
  await tick();
}
it("bounds initial feedback and keeps retry visibly pending", async () => {
  rpc.read.mockImplementation(() => new Promise(() => {}));
  await view();
  await tick(8100);
  const retry = screen.getByRole("button", {
    name: "Retry streaming feedback",
  });
  expect(screen.getByRole("button", { name: "Go live" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(retry);
  await tick();
  expect(screen.getByText("Retrying…")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry streaming feedback" }),
  ).toHaveProperty("disabled", true);
});
it("confirms the original input and destinations even if polling changes the selection", async () => {
  await view();
  fireEvent.click(screen.getByRole("button", { name: "Go live" }));
  await tick();
  expect(screen.getByRole("dialog").textContent).toContain(
    "Main encoder to: Main destination",
  );
  rpc.read.mockResolvedValue({
    ...state,
    destinations: [
      ...state.destinations,
      {
        id: "two",
        name: "Unreviewed",
        version: "later",
        enabled: true,
        status: "none",
      },
    ],
  });
  await tick(5100);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Go live now",
    }),
  );
  await tick();
  expect(rpc.write.mock.calls[0][0].data).toMatchObject({
    liveInputId: "input",
    targets: [{ id: "one", version: "reviewed-version" }],
  });
});
it("requires a choice when more than one input is ready and supports cancel", async () => {
  rpc.read.mockResolvedValue({
    ...state,
    inputs: [...state.inputs, { id: "second", name: "Second encoder" }],
  });
  await view();
  expect(screen.getByRole("button", { name: "Go live" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Live input" }), {
    target: { value: "second" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Go live" }));
  await tick();
  expect(screen.getByRole("dialog").textContent).toContain("Second encoder");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await tick();
  expect(rpc.write).not.toHaveBeenCalled();
});
it("bounds writes and keeps the exact command across navigation and account changes", async () => {
  rpc.write.mockImplementationOnce(() => new Promise(() => {}));
  const mounted = await view();
  await confirm();
  await tick(10100);
  const original = rpc.write.mock.calls[0][0].data;
  mounted.unmount();
  const other = render(element("another"));
  await tick();
  expect(
    screen.queryByRole("button", { name: "Retry streaming command" }),
  ).toBeNull();
  other.unmount();
  render(element());
  await tick();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry streaming command" }),
  );
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(original);
});
it("allows Stop during Go Live and keeps Stop feedback after the older reply arrives", async () => {
  let release!: (value: unknown) => void;
  rpc.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await view();
  await confirm();
  expect(screen.getByRole("button", { name: "Stop stream" })).toHaveProperty(
    "disabled",
    false,
  );
  await confirm("Stop stream", "Stop destinations");
  const live = rpc.write.mock.calls[0][0].data;
  await act(async () =>
    release({
      requestId: live.requestId,
      results: [{ id: "one", success: true }],
    }),
  );
  await tick();
  expect(
    screen.getByText(
      "Stop request confirmed. Check current output status above.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Go Live request confirmed/)).toBeNull();
});
it("reports partial failures by destination and retries the original request", async () => {
  rpc.write.mockImplementationOnce(async ({ data }) => ({
    requestId: data.requestId,
    results: [{ id: "one", success: false, error: "Output not confirmed" }],
  }));
  await view();
  await confirm();
  expect(screen.getByRole("alert").textContent).toContain(
    "Main destination: Output not confirmed",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry streaming command" }),
  );
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(
    rpc.write.mock.calls[0][0].data,
  );
});
it("preserves success if the following read fails and offers only feedback retry", async () => {
  await view();
  rpc.read.mockRejectedValue(new Error("Feedback unavailable"));
  await confirm();
  expect(
    screen.getByText(
      "Go Live request confirmed. Check current output status above.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry streaming feedback" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Retry streaming command" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Go live" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "Stop stream" })).toHaveProperty(
    "disabled",
    false,
  );
});
it("shows unknown provider status with retry and permits Stop", async () => {
  rpc.read.mockResolvedValue({
    ...state,
    destinations: [
      {
        ...state.destinations[0],
        status: "unknown",
        error: "Output check failed",
      },
    ],
  });
  await view();
  expect(screen.getByText("Status unavailable")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Retry streaming feedback" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Go live" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "Stop stream" })).toHaveProperty(
    "disabled",
    false,
  );
});
it("discards open confirmations on account or organization changes", async () => {
  const mounted = await view();
  fireEvent.click(screen.getByRole("button", { name: "Go live" }));
  await tick();
  mounted.rerender(element("other", "another-org"));
  await tick();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(rpc.write).not.toHaveBeenCalled();
});

it("can Stop retained Go Live targets when navigation lost the read cache and feedback is unavailable", async () => {
  rpc.write.mockRejectedValueOnce(new Error("Lost Go Live reply"));
  const mounted = await view();
  await confirm();
  const original = rpc.write.mock.calls[0][0].data;
  mounted.unmount();
  client.removeQueries({ queryKey: ["tm-stream-state", "org", "user"] });
  rpc.read.mockRejectedValue(new Error("Feedback unavailable"));
  render(element());
  await tick();
  expect(screen.getByRole("button", { name: "Stop stream" })).toHaveProperty(
    "disabled",
    false,
  );
  await confirm("Stop stream", "Stop destinations");
  expect(rpc.write.mock.calls[1][0].data).toMatchObject({
    action: "stream-stop",
    targets: original.targets,
  });
});
it("keeps confirmed output changes visible while retrying notification delivery", async () => {
  rpc.write.mockImplementationOnce(async ({ data }) => ({
    requestId: data.requestId,
    results: [{ id: "one", success: true }],
    notificationError: "Team notification was not saved",
  }));
  await view();
  await confirm();
  expect(
    screen.getByText(
      "Go Live request confirmed. Check current output status above.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain(
    "Team notification was not saved",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry streaming command" }),
  );
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(
    rpc.write.mock.calls[0][0].data,
  );
});
