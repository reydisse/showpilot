import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReminderControl } from "../ReminderControl";
import {
  scheduleReminderCommandSchema,
  type ScheduleReminderCommand,
  type ScheduleReminderResult,
} from "@/lib/schedule-reminder-contract";
const api = vi.hoisted(() => ({
  send: vi.fn(),
  refresh: vi.fn(),
  userId: "user-1",
}));
vi.mock("@/lib/schedule-reminder", () => ({ sendScheduleReminders: api.send }));
vi.mock("@tanstack/react-router", () => ({
  useRouteContext: () => ({ user: { id: api.userId } }),
}));
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient();
  clients.push(client);
  const ui = (visible: boolean) => (
    <QueryClientProvider client={client}>
      {visible && (
        <ReminderControl
          orgId="org-1"
          target={{ kind: "show", id: "show-1" }}
          label="Remind awaiting crew"
          onChanged={api.refresh}
        />
      )}
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return { show: (visible: boolean) => view.rerender(ui(visible)) };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const tick = async (ms = 30) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
function sent(index = 0) {
  return scheduleReminderCommandSchema.parse(
    api.send.mock.calls[index][0].data,
  );
}
function result(
  command: ScheduleReminderCommand,
  states: ("accepted" | "failed" | "uncertain" | "expired" | "changed")[] = [
    "accepted",
  ],
): ScheduleReminderResult {
  return {
    orgId: command.orgId,
    userId: command.userId,
    requestId: command.requestId,
    items: states.map((email, i) => ({
      id: `assignment-${i}`,
      label: `Crew ${i}`,
      email,
      inAppDelivered: false,
      reason: null,
      updatedAt: Date.now(),
    })),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  api.userId = "user-1";
  api.refresh.mockResolvedValue(undefined);
  api.send.mockImplementation(async ({ data }) => result(data));
});
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("retains a stalled reminder across navigation and retries exactly once without accepting a late reply", async () => {
  const held = deferred<ScheduleReminderResult>();
  api.send.mockReturnValueOnce(held.promise);
  const view = mount();
  click("Remind awaiting crew");
  await tick();
  const command = sent();
  const busy = screen.getByRole<HTMLButtonElement>("button", {
    name: "Remind awaiting crew",
  });
  expect(busy.disabled).toBe(true);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/Checking reminder delivery/)).toBeNull();
  view.show(false);
  await tick(15_100);
  view.show(true);
  await tick();
  expect(screen.getByText("Some reminders could not be sent.")).toBeTruthy();
  held.resolve(result(command));
  await tick();
  expect(api.refresh).not.toHaveBeenCalled();
  click("Retry reminders");
  await tick();
  expect(sent(1)).toEqual(command);
  expect(
    screen.getByRole("button", { name: "Send another reminder" }),
  ).toBeTruthy();
  expect(screen.queryByText(/emails accepted/)).toBeNull();
});

it("shows only genuine failures and sends the same bulk request on Retry", async () => {
  api.send.mockImplementationOnce(async ({ data }) =>
    result(data, ["accepted", "failed", "uncertain"]),
  );
  mount();
  click("Remind awaiting crew");
  await tick();
  const command = sent();
  expect(screen.getByRole("alert").textContent).toContain(
    "Some reminders could not be sent.",
  );
  expect(screen.getByText("Crew 1")).toBeTruthy();
  expect(
    screen.queryByText(/Crew 0|Crew 2|emails accepted|Email acceptance is unknown/),
  ).toBeNull();
  click("Retry reminders");
  await tick();
  expect(sent(1)).toEqual(command);
});

it("retries a failed Schedule refresh without sending more emails", async () => {
  api.refresh.mockRejectedValueOnce(new Error("view offline"));
  mount();
  click("Remind awaiting crew");
  await tick();
  expect(screen.getByText("Schedule could not be updated.")).toBeTruthy();
  click("Retry refresh");
  await tick();
  expect(api.send).toHaveBeenCalledTimes(1);
  expect(api.refresh).toHaveBeenCalledTimes(2);
});

it("bounds a hung refresh and ignores its late completion", async () => {
  const held = deferred<void>();
  api.refresh.mockReturnValueOnce(held.promise);
  mount();
  click("Remind awaiting crew");
  await tick(12_100);
  held.resolve();
  await tick();
  expect(screen.getByRole("button", { name: "Retry refresh" })).toBeTruthy();
  click("Retry refresh");
  await tick();
  expect(api.send).toHaveBeenCalledTimes(1);
});

it("requires an explicit new request after the safe retry window ends", async () => {
  api.send.mockImplementationOnce(async ({ data }) =>
    result(data, ["expired"]),
  );
  mount();
  click("Remind awaiting crew");
  await tick();
  const original = sent();
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
  expect(
    screen.getByText("Review the current assignments before sending again."),
  ).toBeTruthy();
  expect(screen.queryByText(/may already have arrived/)).toBeNull();
  click("Send new reminders after review");
  await tick();
  expect(sent(1).requestId).not.toBe(original.requestId);
});

it("never presents another account's result or treats a mismatched reply as success", async () => {
  api.send.mockImplementationOnce(async ({ data }) => ({
    ...result(data),
    userId: "other-user",
  }));
  const view = mount();
  click("Remind awaiting crew");
  await tick();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(api.refresh).not.toHaveBeenCalled();
  view.show(false);
  api.userId = "user-2";
  view.show(true);
  await tick();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Remind awaiting crew" }),
  ).toBeTruthy();
});

it("coalesces repeated refresh retries after reminder delivery", async () => {
  api.refresh.mockRejectedValueOnce(new Error("Refresh offline"));
  mount();
  click("Remind awaiting crew");
  await tick();
  const held = deferred<void>();
  api.refresh.mockReturnValueOnce(held.promise);
  const retry = screen.getByRole("button", { name: "Retry refresh" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await tick();
  expect(api.refresh).toHaveBeenCalledTimes(2);
  held.resolve();
  await tick();
  expect(api.send).toHaveBeenCalledTimes(1);
});

it("reports an empty selection", async () => {
  api.send.mockImplementationOnce(async ({ data }) => result(data, []));
  mount();
  click("Remind awaiting crew");
  await tick();
  expect(screen.getByRole("status").textContent).toBe(
    "No pending assignments in this selection.",
  );
});

it("keeps status-check failures silent while allowing the same request to be retried", async () => {
  api.send.mockImplementationOnce(async ({ data }) => {
    const reply = result(data, ["failed", "uncertain"]);
    reply.items[0].reason = "status-check-failed";
    return reply;
  });
  mount();
  click("Remind awaiting crew");
  await tick();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/Crew [01]/)).toBeNull();
  click("Retry reminders");
  await tick();
  expect(sent(1)).toEqual(sent());
});
