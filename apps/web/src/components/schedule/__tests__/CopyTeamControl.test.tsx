import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CopyTeamControl } from "../CopyTeamControl";
import {
  copyTeamCommandSchema,
  type CopyTeamCommand,
  type CopyTeamResult,
} from "@/lib/schedule-copy-contract";
const api = vi.hoisted(() => ({
  copy: vi.fn(),
  refresh: vi.fn(),
  userId: "user-1",
  canCopy: true,
  source: "source-a",
}));
vi.mock("@/lib/schedule-copy", () => ({ copyScheduleTeam: api.copy }));
const clients: QueryClient[] = [];
function result(command: CopyTeamCommand): CopyTeamResult {
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    copied: 1,
    reason: null,
    items: [
      { id: "copied-1", label: "Audio", changed: false, invitation: null },
    ],
  };
}
function mount() {
  const client = new QueryClient();
  clients.push(client);
  const ui = (visible: boolean) => (
    <QueryClientProvider client={client}>
      {visible && (
        <CopyTeamControl
          orgId="org-1"
          userId={api.userId}
          showId="target"
          selection={{
            showId: "target",
            serviceDate: "2099-01-08",
            copyFromShowId: api.source,
            copyFrom: "2099-01-01",
          }}
          canCopy={api.canCopy}
          onChanged={api.refresh}
        />
      )}
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return { show: (visible: boolean) => view.rerender(ui(visible)) };
}
const tick = async (ms = 30) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const sent = (index = 0) =>
  copyTeamCommandSchema.parse(api.copy.mock.calls[index][0].data);
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  api.userId = "user-1";
  api.canCopy = true;
  api.source = "source-a";
  api.copy.mockImplementation(async ({ data }) => result(data));
  api.refresh.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});
it("retains the original copy across navigation, a changed source and a populated target", async () => {
  const pending = held<CopyTeamResult>();
  api.copy.mockReturnValueOnce(pending.promise);
  const view = mount();
  click("Copy team");
  await tick();
  const command = sent();
  view.show(false);
  await tick(15_100);
  api.source = "source-b";
  api.canCopy = false;
  view.show(true);
  await tick();
  expect(screen.getByText(/Team copy was not confirmed/)).toBeTruthy();
  pending.resolve(result(command));
  await tick();
  expect(api.refresh).not.toHaveBeenCalled();
  click("Retry team copy");
  await tick();
  expect(sent(1)).toEqual(command);
  expect(screen.getByText(/1 position copied/)).toBeTruthy();
});
it("shows invitation uncertainty separately and retries the same copy request", async () => {
  api.copy.mockImplementationOnce(async ({ data }) => ({
    ...result(data),
    items: [
      {
        id: "copied-1",
        label: "Audio",
        changed: false,
        invitation: {
          id: "copied-1",
          label: "Audio",
          email: "uncertain",
          inAppDelivered: true,
          reason: null,
          updatedAt: Date.now(),
        },
      },
    ],
  }));
  mount();
  click("Copy team");
  await tick();
  expect(screen.getByText(/Email acceptance is unknown/)).toBeTruthy();
  expect(screen.getByText(/1 position copied/)).toBeTruthy();
  click("Retry team copy");
  await tick();
  expect(sent(1)).toEqual(sent());
});
it("bounds refresh independently and does not copy again on Retry refresh", async () => {
  const pending = held<void>();
  api.refresh.mockReturnValueOnce(pending.promise);
  mount();
  click("Copy team");
  await tick(12_100);
  expect(screen.getByText(/Schedule could not refresh/)).toBeTruthy();
  pending.resolve();
  await tick();
  click("Retry refresh");
  await tick();
  expect(api.copy).toHaveBeenCalledTimes(1);
  expect(api.refresh).toHaveBeenCalledTimes(2);
});
it("requires review and a new explicit copy after a blocked request", async () => {
  api.copy.mockImplementationOnce(async ({ data }) => ({
    ...result(data),
    copied: 0,
    reason: "source-empty",
    items: [],
  }));
  mount();
  click("Copy team");
  await tick();
  expect(screen.getByText(/source show has no positions/)).toBeTruthy();
  click("Review another copy");
  await tick();
  expect(api.copy).toHaveBeenCalledTimes(1);
  click("Copy team");
  await tick();
  expect(sent(1).requestId).not.toBe(sent().requestId);
});
it("does not show or retry another account's copy", async () => {
  api.copy.mockRejectedValueOnce(new TypeError("Offline"));
  const view = mount();
  click("Copy team");
  await tick();
  expect(screen.getByRole("button", { name: "Retry team copy" })).toBeTruthy();
  api.userId = "user-2";
  view.show(true);
  await tick();
  expect(screen.queryByRole("button", { name: "Retry team copy" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy team" })).toBeTruthy();
});

it("does not start overlapping reviews that could clear a later copy attempt", async () => {
  api.copy.mockImplementationOnce(async ({ data }) => ({
    ...result(data),
    copied: 0,
    reason: "source-empty",
    items: [],
  }));
  mount();
  click("Copy team");
  await tick();
  const pending = held<void>();
  api.refresh.mockReturnValueOnce(pending.promise);
  const review = screen.getByRole("button", { name: "Review another copy" });
  fireEvent.click(review);
  fireEvent.click(review);
  await tick();
  expect(api.refresh).toHaveBeenCalledTimes(2);
  pending.resolve();
  await tick();
  click("Copy team");
  await tick();
  expect(api.copy).toHaveBeenCalledTimes(2);
});
