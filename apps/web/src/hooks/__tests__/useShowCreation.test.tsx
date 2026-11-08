import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useShowCreation } from "../useShowCreation";
import { inventoryDraft } from "@/components/shows/ShowCreationForm";
const mock = vi.hoisted(() => ({ create: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/pm-actions", () => ({ createNextService: mock.create }));
vi.mock("@/lib/show-creation-review", () => ({
  reviewShowCreation: mock.review,
}));
let client: QueryClient;
const input = { orgId: "org", serviceDate: "2099-02-01", name: "Original" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(
  options: Parameters<typeof useShowCreation>[2] = {
    onCreated: async () => {},
  },
) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ({ userId }) =>
      useShowCreation(
        { orgId: "org", userId, entry: "test" },
        { name: "Draft" },
        options,
      ),
    { wrapper, initialProps: { userId: "user" } },
  );
}
beforeEach(() => {
  client = new QueryClient();
  mock.create
    .mockReset()
    .mockImplementation(async ({ data }) => ({
      ok: true,
      showId: data.requestId,
      serviceDate: data.serviceDate,
    }));
  mock.review.mockReset();
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});
it("claims creation synchronously so repeated clicks issue one request", async () => {
  const held = deferred<unknown>();
  mock.create.mockReturnValue(held.promise);
  const { result } = setup();
  act(() => {
    result.current.submit(input);
    result.current.submit(input);
  });
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
});
it("a cleared account cache cannot be restored by a late creation reply", async () => {
  const held = deferred<unknown>();
  mock.create.mockReturnValue(held.promise);
  const opened = vi.fn();
  const { result } = setup({ onCreated: opened });
  act(() => result.current.submit(input));
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
  const command = mock.create.mock.calls[0][0].data;
  act(() => client.clear());
  await act(async () =>
    held.resolve({
      ok: true,
      showId: command.requestId,
      serviceDate: command.serviceDate,
    }),
  );
  expect(result.current.attempt).toBeNull();
  expect(opened).not.toHaveBeenCalled();
});
it("switching accounts neither exposes an old draft nor opens the old account's result", async () => {
  const held = deferred<unknown>();
  mock.create.mockReturnValue(held.promise);
  const opened = vi.fn();
  const view = setup({ onCreated: opened });
  act(() => {
    view.result.current.setDraft(() => ({ name: "Private draft" }));
    view.result.current.submit(input);
  });
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
  const command = mock.create.mock.calls[0][0].data;
  view.rerender({ userId: "other" });
  await act(async () =>
    held.resolve({
      ok: true,
      showId: command.requestId,
      serviceDate: command.serviceDate,
    }),
  );
  expect(view.result.current.draft.name).toBe("Draft");
  expect(view.result.current.attempt).toBeNull();
  expect(opened).not.toHaveBeenCalled();
});
it("preparation timeout releases the draft and prevents a later RPC from starting", async () => {
  vi.useFakeTimers();
  const held = deferred<void>();
  const { result } = setup({
    onCreated: async () => {},
    beforeCreate: () => held.promise,
  });
  act(() => result.current.submit(input));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(result.current.attempt).toBeNull();
  expect(result.current.notice).toMatch(/timed out/);
  await act(async () => held.resolve());
  expect(mock.create).not.toHaveBeenCalled();
});
it("opening has its own deadline and cannot erase a recovery result on late completion", async () => {
  vi.useFakeTimers();
  const held = deferred<void>();
  const opened = vi
    .fn()
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue(undefined);
  const { result } = setup({ onCreated: opened });
  act(() => result.current.submit(input));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
  });
  expect(result.current.attempt).toMatchObject({
    kind: "created",
    opening: "failed",
  });
  await act(async () => held.resolve());
  expect(result.current.attempt).toMatchObject({
    kind: "created",
    opening: "failed",
  });
  await act(async () => result.current.open());
  expect(opened).toHaveBeenCalledTimes(2);
  expect(mock.create).toHaveBeenCalledTimes(1);
});
it("review coalesces repeated clicks and retains a timed-out request for another review", async () => {
  vi.useFakeTimers();
  mock.create.mockRejectedValue(new Error("Lost reply"));
  const held = deferred<unknown>();
  mock.review.mockReturnValue(held.promise);
  const { result } = setup();
  act(() => result.current.submit(input));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  act(() => {
    result.current.review();
    result.current.review();
  });
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(mock.review).toHaveBeenCalledTimes(1);
  expect(result.current.attempt).toMatchObject({ kind: "unconfirmed" });
  expect(result.current.locked).toBe(true);
  await act(async () => held.resolve({ kind: "cancelled" }));
  expect(result.current.locked).toBe(true);
  mock.review.mockResolvedValue({ kind: "cancelled" });
  await act(async () => result.current.review());
  expect(result.current.attempt).toBeNull();
});
it("inventory defaults are converted from venue time into the draft's displayed timezone", () => {
  expect(
    inventoryDraft(
      {
        serviceDate: "2099-02-01",
        name: "",
        startTime: "10:00",
        callTime: "",
        location: "",
        timeZone: "UTC",
        source: { kind: "blank" },
      },
      {
        id: "inventory",
        name: "Sunday",
        location: "Main",
        defaultStartTime: "09:30",
        itemCount: 3,
      },
      "America/Toronto",
    ),
  ).toMatchObject({
    name: "Sunday",
    location: "Main",
    startTime: "14:30",
    source: { kind: "inventory", id: "inventory" },
  });
});
