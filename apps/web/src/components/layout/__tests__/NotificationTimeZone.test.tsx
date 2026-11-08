import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationTimeZone } from "../NotificationTimeZone";
import { notificationTimeZoneCommandSchema } from "@/lib/notification-timezone-contract";

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/personal-notifications", () => ({
  getPersonalNotificationTimeZone: api.read,
  savePersonalNotificationTimeZone: api.save,
}));

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const otherZone =
  deviceZone === "Europe/London" ? "Asia/Tokyo" : "Europe/London";
const clients: QueryClient[] = [];
function mount(orgId = "org-1", userId = "user-1", automatic = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const ui = (open: boolean, org = orgId, user = userId) => (
    <QueryClientProvider client={client}>
      {automatic ? (
        <NotificationTimeZone
          orgId={org}
          userId={user}
          mode="background"
          onReview={() => {}}
        />
      ) : null}
      {open ? (
        <NotificationTimeZone orgId={org} userId={user} mode="status" />
      ) : null}
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return {
    client,
    show: (open: boolean, org?: string, user?: string) =>
      view.rerender(ui(open, org, user)),
  };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function tick(ms = 20) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function commandAt(index: number) {
  return notificationTimeZoneCommandSchema.parse(
    api.save.mock.calls[index]?.[0].data,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  api.read.mockResolvedValue({ timeZone: deviceZone, revision: 1 });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("never claims a default before a confirmed read and ignores a late initial reply", async () => {
  const held = deferred<unknown>();
  api.read.mockReturnValueOnce(held.promise);
  mount();
  expect(screen.getByText("Checking alert timezone…")).toBeTruthy();
  expect(screen.queryByText(/workspace default/)).toBeNull();
  await tick(8_100);
  expect(
    screen.getByRole("button", { name: "Retry timezone check" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Alert timezone needs attention" }),
  ).toBeTruthy();
  expect(document.querySelector("[role=alert] time")).toBeTruthy();
  expect(api.read.mock.calls[0][0].signal.aborted).toBe(true);
  held.resolve({ timeZone: otherZone, revision: 7 });
  await tick();
  expect(screen.queryByText(/Last confirmed timezone/)).toBeNull();
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry timezone check" }));
  await tick();
  expect(screen.getByText(/Last confirmed timezone/).textContent).toContain(
    deviceZone,
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shares one automatic save between background and open account details", async () => {
  api.read.mockResolvedValueOnce({ timeZone: otherZone, revision: 4 });
  api.save.mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    outcome: "applied",
    state: { timeZone: deviceZone, revision: 5 },
  }));
  api.read.mockResolvedValue({ timeZone: deviceZone, revision: 5 });
  mount();
  await tick();
  expect(api.save).toHaveBeenCalledTimes(1);
  expect(commandAt(0)).toMatchObject({
    orgId: "org-1",
    timeZone: deviceZone,
    expectedRevision: 4,
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retains an uncertain command across closing and scope changes, then retries without replacing a newer device save", async () => {
  const held = deferred<unknown>();
  api.read.mockResolvedValueOnce({ timeZone: otherZone, revision: 4 });
  api.save.mockReturnValueOnce(held.promise);
  const view = mount();
  await tick();
  const original = commandAt(0);
  view.show(false);
  await tick(8_100);
  expect(api.save.mock.calls[0][0].signal.aborted).toBe(true);
  view.show(true, "org-2", "user-2");
  await tick();
  expect(
    screen.queryByRole("button", { name: "Retry timezone save" }),
  ).toBeNull();
  view.show(true);
  await tick();
  expect(
    screen.getByRole("button", { name: "Retry timezone save" }),
  ).toBeTruthy();
  held.resolve({
    requestId: original.requestId,
    outcome: "applied",
    state: { timeZone: deviceZone, revision: 5 },
  });
  await tick();
  expect(
    screen.getByRole("button", { name: "Retry timezone save" }),
  ).toBeTruthy();
  api.read.mockResolvedValue({ timeZone: otherZone, revision: 6 });
  api.save.mockResolvedValueOnce({
    requestId: original.requestId,
    outcome: "superseded",
    state: { timeZone: otherZone, revision: 6 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry timezone save" }));
  await tick();
  expect(commandAt(1)).toEqual(original);
  expect(api.save).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/A newer timezone is in effect/)).toBeTruthy();
  expect(screen.getByText(/Last confirmed timezone/).textContent).toContain(
    otherZone,
  );
  api.read.mockResolvedValue({ timeZone: deviceZone, revision: 7 });
  api.save.mockImplementationOnce(async ({ data }) => ({
    requestId: data.requestId,
    outcome: "applied",
    state: { timeZone: deviceZone, revision: 7 },
  }));
  fireEvent.click(
    screen.getByRole("button", { name: /Use this device’s timezone/ }),
  );
  await tick();
  expect(api.save).toHaveBeenCalledTimes(3);
  expect(commandAt(2)).toMatchObject({
    timeZone: deviceZone,
    expectedRevision: 6,
  });
  expect(commandAt(2).requestId).not.toBe(original.requestId);
});

it("retries only the read when refresh fails after a confirmed save", async () => {
  api.read
    .mockResolvedValueOnce({ timeZone: otherZone, revision: 1 })
    .mockRejectedValue(new Error("Offline"));
  api.save.mockImplementation(async ({ data }) => ({
    requestId: data.requestId,
    outcome: "applied",
    state: { timeZone: deviceZone, revision: 2 },
  }));
  mount();
  await tick();
  expect(api.save).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Retry timezone save" }),
  ).toBeNull();
  expect(screen.getByText(/Last confirmed timezone/).textContent).toContain(
    deviceZone,
  );
  api.read.mockResolvedValue({ timeZone: deviceZone, revision: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Retry timezone check" }));
  await tick();
  expect(api.save).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps a mismatched acknowledgement uncertain until the same command is confirmed", async () => {
  api.read.mockResolvedValueOnce({ timeZone: otherZone, revision: 1 });
  api.save.mockResolvedValueOnce({
    requestId: crypto.randomUUID(),
    outcome: "applied",
    state: { timeZone: deviceZone, revision: 2 },
  });
  mount();
  await tick();
  const original = commandAt(0);
  expect(
    screen.getByRole("button", { name: "Retry timezone save" }),
  ).toBeTruthy();
  api.save.mockResolvedValueOnce({
    requestId: original.requestId,
    outcome: "applied",
    state: { timeZone: deviceZone, revision: 2 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry timezone save" }));
  await tick();
  expect(commandAt(1)).toEqual(original);
  expect(screen.queryByRole("alert")).toBeNull();
});
