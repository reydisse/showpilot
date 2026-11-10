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
import { KioskDutyRoster } from "../KioskDutyRoster";
import { EditableDutyOfficers } from "@/components/dashboard/pm-widgets";
import type {
  DutyRosterCommand,
  DutyRosterSnapshot,
} from "@/lib/duty-roster-contract";
const rpc = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  notices: vi.fn(),
}));
vi.mock("@/lib/duty-roster", () => ({
  getDutyRosterState: rpc.read,
  writeDutyRoster: rpc.write,
  retryDutyNotifications: rpc.notices,
}));
const clients: QueryClient[] = [];
const state = (): DutyRosterSnapshot => ({
  rolesRevision: 0,
  weekRevision: 0,
  roles: [
    {
      id: "audio",
      code: "audio",
      name: "Audio",
      short: "Audio",
      sortOrder: 1,
      revision: 0,
    },
  ],
  tech: {},
  pmUserId: null,
  members: [
    { id: "person", name: "Fixture person" },
    { id: "other", name: "Other person" },
  ],
  pendingNotifications: 0,
});
let snapshot: DutyRosterSnapshot;
beforeEach(() => {
  vi.useFakeTimers();
  snapshot = state();
  rpc.read
    .mockReset()
    .mockImplementation(async () => structuredClone(snapshot));
  rpc.write
    .mockReset()
    .mockImplementation(async ({ data }: { data: DutyRosterCommand }) => ({
      requestId: data.requestId,
      outcome: "applied",
      snapshot: structuredClone(snapshot),
    }));
  rpc.notices.mockReset().mockResolvedValue({ pendingNotifications: 0 });
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.useRealTimers();
});
const tick = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
function cache() {
  const client = new QueryClient();
  clients.push(client);
  return client;
}
async function view(client = cache(), orgId = "org", userId = "user") {
  const result = render(
    <QueryClientProvider client={client}>
      <KioskDutyRoster orgId={orgId} userId={userId} />
    </QueryClientProvider>,
  );
  await tick();
  return result;
}
const selectAudio = (value = "person") =>
  fireEvent.change(screen.getByLabelText("Audio assignment"), {
    target: { value },
  });
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save Week" }));
it("confirms removing a duty role and its assignments, and cancellation sends nothing", async () => {
  await view();
  fireEvent.click(screen.getByRole("button", { name: /Manage roles/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Delete Audio roster role" }),
  );
  expect(rpc.write).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await tick();
  expect(rpc.write).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete Audio roster role" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Delete role",
    }),
  );
  await tick();
  expect(rpc.write.mock.calls[0][0].data).toMatchObject({
    action: "delete-role",
    roleId: "audio",
    roleRevision: 0,
  });
});
it("bounds a stalled save and retries the exact command after remount, keeping a newer saved assignment", async () => {
  const client = cache();
  rpc.write.mockImplementationOnce(() => new Promise(() => {}));
  const mounted = await view(client);
  selectAudio();
  save();
  await tick(10_100);
  expect(
    screen.getByRole("button", { name: "Retry roster command" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty(
    "value",
    "person",
  );
  const command = rpc.write.mock.calls[0][0].data;
  expect(rpc.write.mock.calls[0][0].signal.aborted).toBe(true);
  mounted.unmount();
  snapshot = { ...state(), tech: { audio: "other" }, weekRevision: 2 };
  await view(client);
  fireEvent.click(screen.getByRole("button", { name: "Retry roster command" }));
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(command);
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty(
    "value",
    "other",
  );
  expect(rpc.write).toHaveBeenCalledTimes(2);
});
it("retains unsent week drafts when navigating to another week and back", async () => {
  await view();
  const date = screen.getByLabelText("Roster week starting Sunday");
  if (!(date instanceof HTMLInputElement))
    throw new Error("Date input missing");
  const original = date.value;
  selectAudio();
  fireEvent.change(date, { target: { value: "2031-02-02" } });
  await tick();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty("value", "");
  fireEvent.change(date, { target: { value: original } });
  await tick();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty(
    "value",
    "person",
  );
  expect(rpc.write).not.toHaveBeenCalled();
});
it("keeps the active week's draft when a pending save for another week resolves", async () => {
  let finish: (value: unknown) => void = () => {};
  rpc.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await view();
  selectAudio();
  save();
  await tick();
  const command = rpc.write.mock.calls[0][0].data;
  fireEvent.change(screen.getByLabelText("Roster week starting Sunday"), {
    target: { value: "2031-02-02" },
  });
  await tick();
  await act(async () =>
    finish({
      requestId: command.requestId,
      outcome: "applied",
      snapshot: { ...state(), weekRevision: 1, tech: { audio: "person" } },
    }),
  );
  await tick();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Roster week starting Sunday")).toHaveProperty(
    "value",
    "2031-02-02",
  );
});
it("does not apply a late read for another week, and retains a draft through read failure", async () => {
  let finish: (value: unknown) => void = () => {};
  rpc.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = cache();
  await view(client);
  fireEvent.change(screen.getByLabelText("Roster week starting Sunday"), {
    target: { value: "2031-02-02" },
  });
  await tick();
  expect(rpc.read.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => finish({ ...state(), tech: { audio: "other" } }));
  await tick();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty("value", "");
  selectAudio();
  rpc.read.mockImplementationOnce(() => new Promise(() => {}));
  act(() => {
    void client.invalidateQueries({
      queryKey: ["duty-roster-state", "org", "user"],
    });
  });
  await tick(8_100);
  expect(
    screen.getByRole("button", { name: "Retry roster week" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty(
    "value",
    "person",
  );
  expect(screen.getByRole("button", { name: "Save Week" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry roster week" }));
  await tick();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty(
    "value",
    "person",
  );
  expect(rpc.write).not.toHaveBeenCalled();
});
it("retains a conflicting draft and requires review before saving against newer assignments", async () => {
  rpc.write.mockImplementationOnce(
    async ({ data }: { data: DutyRosterCommand }) => ({
      requestId: data.requestId,
      outcome: "conflict",
      snapshot: { ...state(), weekRevision: 1, tech: { audio: "other" } },
    }),
  );
  await view();
  selectAudio();
  save();
  await tick();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty(
    "value",
    "person",
  );
  expect(screen.getByText("Currently saved: Other person")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save Week" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Review current roster" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Review current roster",
    }),
  );
  await tick();
  save();
  expect(rpc.write).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save assignments" }));
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toMatchObject({
    weekRevision: 1,
    tech: [{ roleId: "audio", userId: "person" }],
  });
});
it("retries notifications without repeating the saved roster command", async () => {
  snapshot.pendingNotifications = 1;
  rpc.notices.mockImplementationOnce(() => new Promise(() => {}));
  await view();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry duty notifications" }),
  );
  await tick(8_100);
  expect(screen.getByText(/Last delivery attempt/)).toBeTruthy();
  snapshot.pendingNotifications = 0;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry duty notifications" }),
  );
  await tick();
  expect(rpc.write).not.toHaveBeenCalled();
  expect(rpc.notices).toHaveBeenCalledTimes(2);
  expect(
    screen.queryByRole("button", { name: "Retry duty notifications" }),
  ).toBeNull();
});
it("keeps a duplicate role's form and prevents saving a departed member", async () => {
  snapshot.tech.audio = "departed";
  rpc.write.mockImplementationOnce(
    async ({ data }: { data: DutyRosterCommand }) => ({
      requestId: data.requestId,
      outcome: "role-code-taken",
      snapshot,
    }),
  );
  await view();
  expect(screen.getByRole("button", { name: "Save Week" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: /Manage roles/ }));
  for (const [label, value] of [
    ["Role code", "Audio"],
    ["Role name", "Audio desk"],
    ["Short label", "FOH"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Add role" }));
  await tick();
  expect(screen.getByText(/That role code already exists/)).toBeTruthy();
  expect(screen.getByLabelText("Role name")).toHaveProperty(
    "value",
    "Audio desk",
  );
});
it("isolates drafts and pending commands by account and organization", async () => {
  rpc.write.mockImplementationOnce(() => new Promise(() => {}));
  const client = cache(),
    mounted = await view(client);
  selectAudio();
  save();
  await tick(10_100);
  mounted.unmount();
  const other = await view(client, "other-org");
  expect(
    screen.queryByRole("button", { name: "Retry roster command" }),
  ).toBeNull();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty("value", "");
  other.unmount();
  await view(client, "org", "other-user");
  expect(
    screen.queryByRole("button", { name: "Retry roster command" }),
  ).toBeNull();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty("value", "");
});
it("PM uses confirmed assignments, recovers timed-out writes, and never copies old attendance onto the new person", async () => {
  const client = cache();
  snapshot.pmUserId = "person";
  rpc.write.mockImplementationOnce(() => new Promise(() => {}));
  render(
    <QueryClientProvider client={client}>
      <EditableDutyOfficers
        orgId="org"
        userId="user"
        model={{
          dutyWeekStart: "2026-11-08",
          duty: [
            {
              key: "pm",
              role: "Production Manager",
              source: "roster",
              label: "Production Manager",
              name: "Fixture person",
              userId: "person",
              status: "confirmed",
            },
            {
              key: "tm",
              role: "Technical Manager",
              source: null,
              label: "Technical Manager",
              name: null,
              userId: null,
              status: "open",
            },
          ],
        }}
      />
    </QueryClientProvider>,
  );
  await tick();
  expect(screen.getByLabelText("Technical Manager")).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.change(screen.getByLabelText("Production Manager"), {
    target: { value: "other" },
  });
  expect(rpc.write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Change assignment" }));
  await tick(10_100);
  const command = rpc.write.mock.calls[0][0].data;
  expect(command).toMatchObject({
    action: "set-officer",
    duty: "pm",
    userId: "other",
    weekRevision: 0,
  });
  snapshot.pmUserId = "other";
  snapshot.weekRevision = 1;
  fireEvent.click(screen.getByRole("button", { name: "Retry roster command" }));
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(command);
  expect(screen.getByLabelText("Production Manager")).toHaveProperty(
    "value",
    "other",
  );
  expect(screen.queryByText("Confirmed")).toBeNull();
  expect(
    screen.getByText("Assigned; attendance awaiting refresh"),
  ).toBeTruthy();
});
it("refreshes changes from another operator without discarding unsaved selections", async () => {
  await view();
  selectAudio();
  snapshot = { ...snapshot, weekRevision: 1, tech: { audio: "other" } };
  await tick(30_100);
  expect(screen.getByText("Currently saved: Other person")).toBeTruthy();
  expect(screen.getByLabelText("Audio assignment")).toHaveProperty(
    "value",
    "person",
  );
  expect(screen.getByRole("button", { name: "Save Week" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(rpc.write).not.toHaveBeenCalled();
});
it("keeps read Retry visibly pending and disabled until its bounded result", async () => {
  rpc.read
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementationOnce(() => new Promise(() => {}));
  await view();
  await tick(8_100);
  fireEvent.click(screen.getByRole("button", { name: "Retry roster week" }));
  await tick();
  expect(
    screen.getByRole("button", { name: "Retry roster week" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByText("Retrying roster week…")).toBeTruthy();
  await tick(8_100);
  expect(
    screen.getByRole("button", { name: "Retry roster week" }),
  ).toHaveProperty("disabled", false);
  expect(rpc.read).toHaveBeenCalledTimes(2);
});
