import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@showpilot/shared";
import { Profiler } from "react";
import { NotificationPreferences } from "../NotificationPreferences";
const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/personal-notifications", () => ({
  getPersonalNotificationPreferences: rpc.read,
  updatePersonalNotificationPreference: rpc.write,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  rpc.read.mockReset().mockResolvedValue([...DEFAULT_NOTIFICATION_PREFERENCES]);
  rpc.write.mockReset();
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.useRealTimers();
});
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(value);
  return value;
}
function view(cache = client(), userId = "user") {
  return render(
    <QueryClientProvider client={cache}>
      <NotificationPreferences orgId="org" userId={userId} />
    </QueryClientProvider>,
  );
}

it("does not continuously rerender while a save receipt is unavailable", async () => {
  vi.useFakeTimers();
  const commits = vi.fn();
  rpc.write.mockImplementationOnce(() => new Promise(() => {}));
  render(
    <QueryClientProvider client={client()}>
      <Profiler id="preferences" onRender={commits}>
        <NotificationPreferences orgId="org" userId="user" />
      </Profiler>
    </QueryClientProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  fireEvent.click(
    screen.getByRole("switch", { name: "Schedule device alerts" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(commits.mock.calls.length).toBeLessThan(20);
});

it("shows all five personal categories with named controls", async () => {
  view();
  await screen.findByRole("switch", { name: "Schedule device alerts" });
  expect(screen.getAllByRole("switch")).toHaveLength(5);
  expect(screen.getByText(/only to your account/)).toBeTruthy();
});
it("retains the exact failed save through closing and never retries the inbox instead", async () => {
  const cache = client();
  const first = view(cache);
  rpc.write.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(
    await screen.findByRole("switch", { name: "Schedule device alerts" }),
  );
  await screen.findByRole("button", { name: "Retry preference save" });
  const original = rpc.write.mock.calls[0][0].data;
  expect(original).toMatchObject({
    category: "schedule",
    deviceAlerts: false,
    expectedDeviceAlerts: true,
  });
  expect(
    screen
      .getByRole("switch", { name: "Schedule device alerts" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  first.unmount();
  view(cache);
  rpc.write.mockResolvedValueOnce({
    outcome: "superseded",
    preference: { category: "schedule", deviceAlerts: true },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry preference save" }),
  );
  await screen.findByText(
    "A newer alert choice is in effect. Retrying did not replace it.",
  );
  expect(rpc.write.mock.calls[1][0].data).toEqual(original);
});
it("separates a failed post-save refresh from the acknowledged mutation", async () => {
  view();
  await screen.findByRole("switch", { name: "Chat device alerts" });
  rpc.read.mockRejectedValueOnce(new Error("Read failed"));
  rpc.write.mockResolvedValueOnce({
    outcome: "applied",
    preference: { category: "chat", deviceAlerts: false },
  });
  fireEvent.click(screen.getByRole("switch", { name: "Chat device alerts" }));
  const retry = await screen.findByRole("button", {
    name: "Retry preferences refresh",
  });
  expect(
    screen.queryByRole("button", { name: "Retry preference save" }),
  ).toBeNull();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry preferences refresh" }),
    ).toBeNull(),
  );
  expect(rpc.write).toHaveBeenCalledOnce();
});
it("keeps another account isolated from a failed request", async () => {
  const cache = client();
  const first = view(cache);
  rpc.write.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(
    await screen.findByRole("switch", { name: "Chat device alerts" }),
  );
  await screen.findByRole("button", { name: "Retry preference save" });
  first.unmount();
  view(cache, "different-user");
  await screen.findByRole("switch", { name: "Chat device alerts" });
  expect(
    screen.queryByRole("button", { name: "Retry preference save" }),
  ).toBeNull();
});
it("bounds hanging reads and offers a real read retry", async () => {
  vi.useFakeTimers();
  rpc.read.mockImplementationOnce(() => new Promise(() => {}));
  view();
  await act(() => vi.advanceTimersByTimeAsync(8_100));
  expect(screen.queryByText("Loading your alert choices…")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Retry preferences refresh" }),
  ).toBeTruthy();
  expect(rpc.read.mock.calls[0][0].signal.aborted).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Retry preferences refresh" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.getAllByRole("switch")).toHaveLength(5);
});
it("bounds writes, aborts transport and ignores a late reply after recovery", async () => {
  let release = (_value: unknown) => {};
  vi.useFakeTimers();
  view();
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(
    screen.getByRole("switch", { name: "Reports device alerts" }),
  ).toBeTruthy();
  rpc.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole("switch", { name: "Reports device alerts" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(10_100));
  expect(
    screen.getByRole("button", { name: "Retry preference save" }),
  ).toBeTruthy();
  expect(rpc.write.mock.calls[0][0].signal.aborted).toBe(true);
  rpc.write.mockResolvedValueOnce({
    outcome: "superseded",
    preference: { category: "reports", deviceAlerts: true },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Retry preference save" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(100));
  await act(async () =>
    release({
      outcome: "applied",
      preference: { category: "reports", deviceAlerts: false },
    }),
  );
  expect(
    screen
      .getByRole("switch", { name: "Reports device alerts" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByText(
      "A newer alert choice is in effect. Retrying did not replace it.",
    ),
  ).toBeTruthy();
});
