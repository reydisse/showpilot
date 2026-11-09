import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProPresenterOutputControl } from "../ProPresenterOutputControl";
const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/propresenter-output", () => ({
  getProPresenterOutput: rpc.read,
  changeProPresenterOutput: rpc.write,
}));
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  client = new QueryClient();
  rpc.read.mockResolvedValue({
    enabled: false,
    revision: null,
    serverTime: Date.now(),
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
function view() {
  return render(
    <QueryClientProvider client={client}>
      <ProPresenterOutputControl
        orgId="org"
        userId="user"
        surface="rundown"
        enabled
      />
    </QueryClientProvider>,
  );
}
it.each([false, true])(
  "requires confirmation before changing enabled=%s and supports cancellation",
  async (enabled) => {
    rpc.read.mockResolvedValue({
      enabled,
      revision: null,
      serverTime: Date.now(),
    });
    view();
    await settle();
    fireEvent.click(
      screen.getByRole("button", {
        name: enabled ? "Hide stage slides" : "Show stage slides",
      }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(rpc.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(rpc.write).not.toHaveBeenCalled();
  },
);
it("disables an open review with an explanation when output revision changes", async () => {
  view();
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show stage slides" }));
  act(() =>
    client.setQueryData(
      ["web-propresenter-output-state", "user", "org", "rundown"],
      { enabled: false, revision: crypto.randomUUID(), serverTime: Date.now() },
    ),
  );
  await settle();
  expect(screen.getByRole("button", { name: "Show slides" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText(/changed during review/)).toBeTruthy();
  expect(rpc.write).not.toHaveBeenCalled();
});
it("shows a timestamp and recovery control after a lost output reply", async () => {
  rpc.write.mockRejectedValueOnce(new Error("private network detail"));
  view();
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show stage slides" }));
  fireEvent.click(screen.getByRole("button", { name: "Show slides" }));
  await settle();
  expect(screen.getByRole("alert").textContent).toContain(
    "Output change was not confirmed",
  );
  expect(
    screen.getByRole("alert").querySelector("time")?.dateTime,
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Recover output change" }),
  ).toHaveProperty("disabled", false);
  expect(
    screen.getByRole("button", { name: "Show stage slides" }),
  ).toHaveProperty("disabled", true);
  expect(screen.queryByText(/private network/)).toBeNull();
});
