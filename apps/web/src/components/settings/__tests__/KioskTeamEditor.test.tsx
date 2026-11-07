vi.mock("../KioskDutyRoster", () => ({ KioskDutyRoster: () => null }));
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KioskSection } from "../KioskSection";
import { KioskTeamEditor } from "../KioskTeamEditor";
const rpc = vi.hoisted(() => ({ teams: vi.fn(), write: vi.fn() }));
vi.mock("../KioskDisplayControl", () => ({ KioskDisplayControl: () => null }));
vi.mock("@/lib/kiosk-admin", () => ({
  getKioskTeams: rpc.teams,
  writeKioskTeam: rpc.write,
}));
vi.mock("@/lib/kiosk", () => ({
  listKioskTokens: async () => [],
  createKioskToken: vi.fn(),
  revokeKioskToken: vi.fn(),
}));
const clients: QueryClient[] = [];
const team = {
  id: "team",
  name: "Audio",
  color: "#3b82f6",
  sortOrder: 1,
  revision: 0,
  members: [],
};
const tick = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const cache = () => {
  const client = new QueryClient();
  clients.push(client);
  return client;
};
const result = (
  data: { requestId: string },
  outcome: "applied" | "conflict" = "applied",
) => ({ id: "team", requestId: data.requestId, outcome });
beforeEach(() => {
  vi.useFakeTimers();
  rpc.teams.mockReset().mockResolvedValue([]);
  rpc.write
    .mockReset()
    .mockImplementation(({ data }) => Promise.resolve(result(data)));
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.useRealTimers();
});
function view(client = cache()) {
  return render(
    <QueryClientProvider client={client}>
      <KioskSection userId="user" orgId="org" slug="org" members={[]} />
    </QueryClientProvider>,
  );
}
function editor(
  client = cache(),
  userId = "user",
  orgId = "org",
  onChange = vi.fn(),
) {
  return render(
    <QueryClientProvider client={client}>
      <KioskTeamEditor
        orgId={orgId}
        userId={userId}
        teams={[team]}
        members={[]}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
}
async function create() {
  fireEvent.change(screen.getByLabelText("New team name"), {
    target: { value: "Audio" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add Team" }));
  await tick();
}
it("asks before deleting a kiosk org-chart team", async () => {
  rpc.teams.mockResolvedValue([team]);
  view();
  await tick();
  fireEvent.click(screen.getByTitle("Delete team"));
  expect(rpc.write).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(rpc.write).not.toHaveBeenCalled();
});
it("bounds an unacknowledged team creation and retains the draft for retry", async () => {
  rpc.write.mockImplementation(() => new Promise(() => {}));
  view();
  await tick();
  await create();
  await tick(10_100);
  expect(
    screen.getByRole("button", { name: "Retry team command" }),
  ).toBeTruthy();
  expect(screen.getByDisplayValue("Audio")).toBeTruthy();
  expect(rpc.write.mock.calls[0][0].signal.aborted).toBe(true);
});
it("retains an exact failed create across navigation and isolates account and organization", async () => {
  const client = cache();
  rpc.write.mockRejectedValueOnce(new Error("Lost response"));
  const first = editor(client);
  await tick();
  await create();
  const command = rpc.write.mock.calls[0][0].data;
  first.unmount();
  const other = editor(client, "other");
  await tick();
  expect(
    screen.queryByRole("button", { name: "Retry team command" }),
  ).toBeNull();
  other.unmount();
  const foreign = editor(client, "user", "other");
  await tick();
  expect(screen.getByLabelText("New team name")).toHaveProperty("value", "");
  foreign.unmount();
  const refreshed = vi.fn();
  editor(client, "user", "org", refreshed);
  await tick();
  expect(screen.getByLabelText("New team name")).toHaveProperty(
    "value",
    "Audio",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry team command" }));
  await tick();
  expect(rpc.write.mock.calls[1][0].data).toEqual(command);
  expect(refreshed).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("New team name")).toHaveProperty("value", "");
});
it("keeps unsent drafts through tab navigation and requires explicit Save", async () => {
  const client = cache(),
    first = editor(client);
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Edit team" }));
  fireEvent.change(screen.getByLabelText("Team name"), {
    target: { value: "New audio" },
  });
  fireEvent.blur(screen.getByLabelText("Team name"));
  expect(rpc.write).not.toHaveBeenCalled();
  first.unmount();
  editor(client);
  await tick();
  expect(screen.getByLabelText("Team name")).toHaveProperty(
    "value",
    "New audio",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save team" }));
  await tick();
  expect(rpc.write.mock.calls[0][0].data).toMatchObject({
    action: "update",
    id: "team",
    revision: 0,
    name: "New audio",
  });
});
it("ignores a late write reply and retains a conflict draft for review", async () => {
  let release = (_: unknown) => {};
  rpc.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  editor();
  await tick();
  fireEvent.click(screen.getByRole("button", { name: "Edit team" }));
  fireEvent.change(screen.getByLabelText("Team name"), {
    target: { value: "Draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save team" }));
  await tick(10_100);
  const data = rpc.write.mock.calls[0][0].data;
  rpc.write.mockResolvedValueOnce(result(data, "conflict"));
  fireEvent.click(screen.getByRole("button", { name: "Retry team command" }));
  await tick();
  release(result(data));
  await tick();
  expect(screen.getByLabelText("Team name")).toHaveProperty("value", "Draft");
  expect(screen.getByRole("alert").textContent).toContain("was not applied");
});
it("does not repeat an acknowledged write when refreshing the list fails", async () => {
  rpc.teams
    .mockResolvedValueOnce([])
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue([team]);
  view();
  await tick();
  await create();
  await tick(8_100);
  expect(
    screen.getByRole("button", { name: "Retry kiosk organization" }),
  ).toBeTruthy();
  expect(rpc.write).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Retry kiosk organization" }),
  );
  await tick();
  expect(rpc.write).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("article", { name: "Audio team" })).toBeTruthy();
});

it("applies a pending command acknowledgement after the editor remounts", async () => {
  const client = cache();
  let release = (_: unknown) => {};
  rpc.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = editor(client);
  await tick();
  await create();
  const command = rpc.write.mock.calls[0][0].data;
  first.unmount();
  editor(client);
  await tick();
  expect(screen.getByLabelText("New team name")).toHaveProperty(
    "value",
    "Audio",
  );
  release(result(command));
  await tick();
  expect(screen.getByLabelText("New team name")).toHaveProperty("value", "");
});

it("retains a denied membership choice without locking the editor on Retry", async () => {
  const client = cache();
  rpc.write.mockImplementation(({ data }) =>
    Promise.resolve(result(data, "conflict")),
  );
  render(
    <QueryClientProvider client={client}>
      <KioskTeamEditor
        orgId="org"
        userId="user"
        teams={[team]}
        members={[{ id: "departed", name: "Departed person", image: null }]}
        onChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Add member to Audio"), {
    target: { value: "departed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
  await tick();
  expect(screen.getByRole("alert").textContent).toContain("membership changed");
  expect(
    screen.queryByRole("button", { name: "Retry team command" }),
  ).toBeNull();
  expect(screen.getByLabelText("Add member to Audio")).toHaveProperty(
    "disabled",
    false,
  );
});
