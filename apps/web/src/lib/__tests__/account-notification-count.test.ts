import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startNotificationCount } from "../account-notification-count";
const mocks = vi.hoisted(() => ({ read: vi.fn(), desktop: false }));
vi.mock("../personal-notifications", () => ({
  getPersonalNotificationCount: mocks.read,
}));
vi.mock("../desktop-runtime", () => ({
  isDesktopRuntime: () => mocks.desktop,
}));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
const controllers: ReturnType<typeof startNotificationCount>[] = [];
function start(orgId = "org-a") {
  const publish = vi.fn();
  const controller = startNotificationCount(orgId, publish);
  controllers.push(controller);
  return { publish, controller };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.read.mockReset();
  mocks.desktop = false;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("bounds an initial count, ignores its late response, and retries without claiming zero", async () => {
  const held = deferred<{ unread: number }>();
  mocks.read.mockReturnValueOnce(held.promise);
  const { publish, controller } = start();
  await vi.advanceTimersByTimeAsync(8_100);
  expect(publish).toHaveBeenLastCalledWith({
    kind: "failed",
    snapshot: null,
    occurredAt: expect.any(Number),
    retrying: false,
  });
  expect(mocks.read.mock.calls[0][0].signal.aborted).toBe(true);
  held.resolve({ unread: 0 });
  await vi.advanceTimersByTimeAsync(1);
  expect(publish.mock.calls.at(-1)?.[0].kind).toBe("failed");
  mocks.read.mockResolvedValueOnce({ unread: 7 });
  controller.retry();
  await vi.advanceTimersByTimeAsync(1);
  expect(publish).toHaveBeenLastCalledWith({
    kind: "ready",
    snapshot: { unread: 7, confirmedAt: expect.any(Number) },
  });
});
it("retains the last confirmed count and the failed-at time while retrying", async () => {
  mocks.read
    .mockResolvedValueOnce({ unread: 4 })
    .mockRejectedValueOnce(new Error("offline"));
  const { publish, controller } = start();
  await vi.advanceTimersByTimeAsync(1);
  controller.retry();
  await vi.advanceTimersByTimeAsync(1);
  const failure = publish.mock.calls.at(-1)?.[0];
  expect(failure).toMatchObject({
    kind: "failed",
    snapshot: { unread: 4 },
    retrying: false,
  });
  const held = deferred<{ unread: number }>();
  mocks.read.mockReturnValueOnce(held.promise);
  controller.retry();
  expect(publish).toHaveBeenLastCalledWith({ ...failure, retrying: true });
});
it("coalesces events, cancels hidden reads, and refreshes on returning", async () => {
  const held = deferred<{ unread: number }>();
  mocks.read.mockReturnValueOnce(held.promise);
  const { publish } = start();
  await vi.advanceTimersByTimeAsync(1);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("focus"));
  expect(mocks.read).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(mocks.read.mock.calls[0][0].signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  held.resolve({ unread: 99 });
  await vi.advanceTimersByTimeAsync(1);
  expect(publish.mock.calls.at(-1)?.[0].snapshot).toBeNull();
  mocks.read.mockResolvedValueOnce({ unread: 2 });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1);
  expect(publish.mock.calls.at(-1)?.[0].snapshot.unread).toBe(2);
});
it("accepts a confirmed inbox count without letting an older sidebar read overwrite it", async () => {
  const held = deferred<{ unread: number }>();
  mocks.read.mockReturnValueOnce(held.promise);
  const { publish, controller } = start();
  await vi.advanceTimersByTimeAsync(1);
  controller.accept(0);
  held.resolve({ unread: 9 });
  await vi.advanceTimersByTimeAsync(1);
  expect(publish).toHaveBeenLastCalledWith({
    kind: "ready",
    snapshot: { unread: 0, confirmedAt: expect.any(Number) },
  });
  mocks.read.mockResolvedValueOnce({ unread: 1 });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(publish.mock.calls.at(-1)?.[0].snapshot.unread).toBe(1);
});
it("uses scoped native events as refresh signals and falls back when native delivery goes quiet", async () => {
  mocks.desktop = true;
  mocks.read.mockResolvedValue({ unread: 3 });
  const { publish } = start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  window.dispatchEvent(
    new CustomEvent("showpilot-personal-notification-count", {
      detail: { orgId: "other-org", unread: 99 },
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  window.dispatchEvent(
    new CustomEvent("showpilot-personal-notification-count", {
      detail: { orgId: "org-a", unread: 99 },
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls.at(-1)?.[0].snapshot.unread).toBe(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.read).toHaveBeenCalledTimes(3);
});
it("disposes pending work and listeners without publishing after account exit", async () => {
  const held = deferred<{ unread: number }>();
  mocks.read.mockReturnValueOnce(held.promise);
  const { publish, controller } = start();
  await vi.advanceTimersByTimeAsync(1);
  const calls = publish.mock.calls.length;
  controller.dispose();
  held.resolve({ unread: 10 });
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(publish).toHaveBeenCalledTimes(calls);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
