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
import { KioskDisplayControl } from "../KioskDisplayControl";
import { KioskSection } from "../KioskSection";
const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/kiosk-display", () => ({
  getKioskBlankState: rpc.read,
  setKioskBlankState: rpc.write,
}));
vi.mock("@/lib/kiosk-admin", () => ({
  getKioskTeams: async () => [],
}));
vi.mock("@/lib/kiosk", () => ({
  listKioskTokens: async () => [],
  createKioskToken: vi.fn(),
  revokeKioskToken: vi.fn(),
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  rpc.read.mockReset();
  rpc.write.mockReset();
  rpc.read.mockResolvedValue({ blanked: false, revision: null });
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.useRealTimers();
});
const settle = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
function view() {
  const client = new QueryClient();
  clients.push(client);
  const props = { orgId: "org", slug: "org", userId: "user", members: [] };
  return render(
    <QueryClientProvider client={client}>
      <KioskSection {...props} />
    </QueryClientProvider>,
  );
}
it("confirms blanking and sends no command when canceled", async () => {
  view();
  await settle();
  fireEvent.click(
    screen.getByRole("button", { name: /^Blank(?: all displays)?$/ }),
  );
  expect(rpc.write).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(rpc.write).not.toHaveBeenCalled();
});
it("does not present an unknown read as restored displays and offers bounded retry", async () => {
  rpc.read.mockImplementation(() => new Promise(() => {}));
  view();
  await settle();
  expect(
    screen
      .getByRole("button", { name: /^Blank(?: all displays)?$/ })
      .hasAttribute("disabled"),
  ).toBe(true);
  await settle(8_100);
  expect(
    screen.getByRole("button", { name: "Retry display state" }),
  ).toBeTruthy();
  expect(rpc.write).not.toHaveBeenCalled();
});

const revision = () => crypto.randomUUID();
function cache() {
  const client = new QueryClient();
  clients.push(client);
  return client;
}
function control(client = cache(), userId = "user", orgId = "org") {
  return render(
    <QueryClientProvider client={client}>
      <KioskDisplayControl orgId={orgId} userId={userId} />
    </QueryClientProvider>,
  );
}
async function blank() {
  fireEvent.click(screen.getByRole("button", { name: "Blank all displays" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Blank displays" }));
  await settle();
}
const result = (
  requestId: string,
  blanked: boolean,
  outcome: "applied" | "superseded" | "conflict" = "applied",
) => ({ requestId, outcome, snapshot: { blanked, revision: revision() } });
it("retains the exact failed command across navigation with account and org isolation", async () => {
  const client = cache();
  rpc.write.mockRejectedValueOnce(new Error("Lost reply"));
  const first = control(client);
  await settle();
  await blank();
  const original = rpc.write.mock.calls[0][0].data;
  first.unmount();
  const other = control(client, "other");
  await settle();
  expect(
    screen.queryByRole("button", { name: "Retry display command" }),
  ).toBeNull();
  other.unmount();
  const foreign = control(client, "user", "other-org");
  await settle();
  expect(
    screen.queryByRole("button", { name: "Retry display command" }),
  ).toBeNull();
  foreign.unmount();
  control(client);
  await settle();
  rpc.write.mockResolvedValueOnce(
    result(original.requestId, false, "superseded"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry display command" }),
  );
  await settle();
  expect(rpc.write.mock.calls[1][0].data).toEqual(original);
  expect(screen.getByRole("alert").textContent).toContain(
    "another controller changed",
  );
  expect(
    screen.getByRole("button", { name: "Blank all displays" }),
  ).toBeTruthy();
});
it("bounds write confirmation and ignores its late reply after retry", async () => {
  let release = (_: unknown) => {};
  rpc.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  control();
  await settle();
  await blank();
  await settle(10_100);
  const original = rpc.write.mock.calls[0][0].data;
  expect(rpc.write.mock.calls[0][0].signal.aborted).toBe(true);
  rpc.write.mockResolvedValueOnce(result(original.requestId, true));
  fireEvent.click(
    screen.getByRole("button", { name: "Retry display command" }),
  );
  await settle();
  release(result(original.requestId, false, "conflict"));
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Restore displays" })).toBeTruthy();
});
it("keeps the revision reviewed when confirmation opens, even when polling finds a later change", async () => {
  control();
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Blank all displays" }));
  await settle();
  rpc.read.mockResolvedValue({ blanked: false, revision: revision() });
  await settle(5_100);
  rpc.write.mockImplementationOnce(({ data }) =>
    Promise.resolve(result(data.requestId, false, "conflict")),
  );
  fireEvent.click(screen.getByRole("button", { name: "Blank displays" }));
  await settle();
  expect(rpc.write.mock.calls[0][0].data.expectedRevision).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain(
    "Your command was not applied",
  );
});
it("restores without a destructive confirmation and rejects a late pre-write poll", async () => {
  const initial = { blanked: true, revision: revision() };
  let release = (_: unknown) => {};
  rpc.read
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ blanked: false, revision: revision() });
  rpc.write.mockImplementation(({ data }) =>
    Promise.resolve(result(data.requestId, false)),
  );
  control();
  await settle();
  await settle(5_100);
  fireEvent.click(screen.getByRole("button", { name: "Restore displays" }));
  await settle();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(rpc.write.mock.calls[0][0].data).toMatchObject({
    blanked: false,
    expectedRevision: initial.revision,
  });
  expect(rpc.read.mock.calls[1][0].signal.aborted).toBe(true);
  release(initial);
  await settle();
  expect(
    screen.getByRole("button", { name: "Blank all displays" }),
  ).toBeTruthy();
});
