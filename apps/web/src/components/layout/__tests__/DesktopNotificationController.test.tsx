import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { DesktopNotificationController } from "../DesktopNotificationController";
import { DesktopNotificationContext, type DesktopNotificationDelivery } from "../DesktopNotificationContext";
import { DesktopNotificationNotice } from "../DesktopNotificationNotice";
import { UnsupportedDesktopNotificationActionsError } from "@/lib/desktop-notification-state";

function NotificationFixture({ children }: { children?: ReactNode }) {
  const [delivery, setDelivery] = useState<DesktopNotificationDelivery | null>(null);
  return <DesktopNotificationContext.Provider value={delivery}>
    <DesktopNotificationController onDeliveryChange={setDelivery} />
    {children}
  </DesktopNotificationContext.Provider>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  showNotification: vi.fn(),
  context: vi.fn(),
  listen: vi.fn(),
  desktop: true,
  slug: "faithfire-production" as string | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: mocks.slug }),
}));

vi.mock("@/lib/desktop-runtime", () => ({
  DESKTOP_NOTIFICATION_POLL_EVENT: "showpilot-desktop-notification-poll",
  focusDesktopMainWindow: vi.fn().mockResolvedValue(undefined),
  isDesktopMainWindow: () => true,
  isDesktopRuntime: () => mocks.desktop,
  listenForDesktopNotificationActions: mocks.listen,
  showDesktopNotification: mocks.showNotification,
}));

vi.mock("@/lib/personal-notifications", () => ({
  getPersonalDeviceNotifications: mocks.getNotifications,
}));

vi.mock("@/lib/session", () => ({
  getOrgRouteContext: mocks.context,
}));

const oldNotification = {
  id: "notification-old",
  title: "Existing notification",
  message: "Already present when Desktop opened",
  actionUrl: "schedule",
  readAt: null,
};

const newNotification = {
  id: "notification-new",
  title: "New notification",
  message: "Arrived after Desktop opened",
  actionUrl: "chat?room=production",
  readAt: null,
};

describe("DesktopNotificationController", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  beforeEach(() => {
    mocks.desktop = true;
    mocks.slug = "faithfire-production";
    mocks.context
      .mockReset()
      .mockResolvedValue({ user: { id: "user-1" }, org: { id: "org-1" } });
    mocks.listen.mockReset().mockResolvedValue(async () => {});
    window.localStorage.clear();
    mocks.getNotifications.mockReset();
    mocks.showNotification.mockReset();
    mocks.getNotifications.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      notifications: [oldNotification],
      unread: 1,
    });
  });

  it("keeps inbox delivery alive while an unsupported native listener waits for an update or explicit retry", async () => {
    vi.useFakeTimers();
    mocks.listen.mockRejectedValueOnce(new UnsupportedDesktopNotificationActionsError());
    render(<NotificationFixture><DesktopNotificationNotice /></NotificationFixture>);
    await act(async () => {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("alert").textContent).toContain("Update ShowPilot Desktop");
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.getNotifications.mock.calls.length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry desktop alerts" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries an unread notification when native permission initially prevents delivery", async () => {
    render(<NotificationFixture />);

    const historyKey = "showpilot.desktop-notifications.v1:user-1:org-1";
    await waitFor(() =>
      expect(window.localStorage.getItem(historyKey)).toContain(
        oldNotification.id,
      ),
    );
    expect(mocks.showNotification).not.toHaveBeenCalled();

    mocks.getNotifications.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      notifications: [newNotification, oldNotification],
      unread: 2,
    });
    mocks.showNotification
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    act(() =>
      window.dispatchEvent(new Event("showpilot-desktop-notification-poll")),
    );
    await waitFor(() =>
      expect(mocks.showNotification).toHaveBeenCalledTimes(1),
    );
    expect(window.localStorage.getItem(historyKey)).not.toContain(
      newNotification.id,
    );

    act(() =>
      window.dispatchEvent(new Event("showpilot-desktop-notification-poll")),
    );
    await waitFor(() =>
      expect(mocks.showNotification).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem(historyKey)).toContain(
        newNotification.id,
      ),
    );
  });

  it("releases a stalled inbox poll so a later poll can recover", async () => {
    vi.useFakeTimers();
    mocks.getNotifications.mockReturnValueOnce(new Promise(() => {}));
    render(<NotificationFixture />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(mocks.getNotifications).toHaveBeenCalledTimes(2);
  });

  it("keeps successful deliveries when a later notification fails", async () => {
    const historyKey = "showpilot.desktop-notifications.v1:user-1:org-1";
    window.localStorage.setItem(
      historyKey,
      JSON.stringify([oldNotification.id]),
    );
    const later = { ...newNotification, id: "notification-later" };
    mocks.getNotifications.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      notifications: [later, newNotification, oldNotification],
      unread: 3,
    });
    mocks.showNotification
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("Native notification failed"));
    render(<NotificationFixture />);
    await waitFor(() =>
      expect(mocks.showNotification).toHaveBeenCalledTimes(2),
    );
    expect(window.localStorage.getItem(historyKey)).toContain(
      newNotification.id,
    );
    mocks.showNotification.mockResolvedValue(true);
    act(() =>
      window.dispatchEvent(new Event("showpilot-desktop-notification-poll")),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem(historyKey)).toContain(later.id),
    );
    expect(
      mocks.showNotification.mock.calls.filter(
        (call) => call[2].notificationId === newNotification.id,
      ),
    ).toHaveLength(1);
  });

  it("leaves signed-out web children usable without starting native delivery", () => {
    mocks.desktop = false;
    mocks.slug = undefined;
    render(
      <NotificationFixture>
        <button>Sign in</button>
      </NotificationFixture>,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("shows a timed read failure, coalesces retries and ignores the late old reply", async () => {
    vi.useFakeTimers();
    const held = deferred<{
      userId: string;
      orgId: string;
      notifications: (typeof newNotification)[];
      unread: number;
    }>();
    mocks.getNotifications.mockReturnValueOnce(held.promise);
    render(
      <NotificationFixture>
        <DesktopNotificationNotice />
      </NotificationFixture>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be checked",
    );
    expect(
      screen.getByRole("alert").querySelector("time")?.dateTime,
    ).toBeTruthy();
    expect(mocks.getNotifications.mock.calls[0][0].signal.aborted).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry desktop alerts" }),
    );
    act(() =>
      window.dispatchEvent(new Event("showpilot-desktop-notification-poll")),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getNotifications).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      held.resolve({
        userId: "user-1",
        orgId: "org-1",
        notifications: [newNotification],
        unread: 1,
      });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  it("does not start an inbox request from a late expired context read", async () => {
    vi.useFakeTimers();
    const held = deferred<{ user: { id: string }; org: { id: string } }>();
    mocks.context.mockReturnValueOnce(held.promise);
    render(
      <NotificationFixture>
        <DesktopNotificationNotice />
      </NotificationFixture>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => {
      held.resolve({ user: { id: "user-1" }, org: { id: "org-1" } });
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getNotifications).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry desktop alerts" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getNotifications).toHaveBeenCalledTimes(1);
  });

  it("uses memory history when persistent history cannot be updated", async () => {
    const key = "showpilot.desktop-notifications.v1:user-1:org-1";
    window.localStorage.setItem(key, JSON.stringify([oldNotification.id]));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    mocks.getNotifications.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      notifications: [newNotification, oldNotification],
      unread: 2,
    });
    mocks.showNotification.mockResolvedValue(true);
    render(<NotificationFixture />);
    await waitFor(() =>
      expect(mocks.showNotification).toHaveBeenCalledTimes(1),
    );
    act(() =>
      window.dispatchEvent(new Event("showpilot-desktop-notification-poll")),
    );
    await waitFor(() =>
      expect(mocks.getNotifications).toHaveBeenCalledTimes(2),
    );
    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
  });

  it("does not associate a different account's alerts with cached identity", async () => {
    mocks.getNotifications.mockResolvedValue({
      userId: "user-2",
      orgId: "org-1",
      notifications: [newNotification],
      unread: 1,
    });
    render(
      <NotificationFixture>
        <DesktopNotificationNotice />
      </NotificationFixture>,
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(
      window.localStorage.getItem(
        "showpilot.desktop-notifications.v1:user-1:org-1",
      ),
    ).toBeNull();
    expect(mocks.showNotification).not.toHaveBeenCalled();
    mocks.context.mockResolvedValue({
      user: { id: "user-2" },
      org: { id: "org-1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Retry desktop alerts" }),
    );
    await waitFor(() =>
      expect(
        window.localStorage.getItem(
          "showpilot.desktop-notifications.v1:user-2:org-1",
        ),
      ).toContain(newNotification.id),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retires a late listener registration after timeout and cleans up the active retry", async () => {
    vi.useFakeTimers();
    const held = deferred<() => Promise<void>>();
    const retired = vi.fn(async () => {}),
      active = vi.fn(async () => {});
    mocks.listen
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(active);
    const view = render(
      <NotificationFixture>
        <DesktopNotificationNotice />
      </NotificationFixture>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "actions could not connect",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry desktop alerts" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      held.resolve(retired);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(retired).toHaveBeenCalledTimes(1);
    expect(active).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(active).toHaveBeenCalledTimes(1);
  });

  it("reports a failed retired-listener cleanup and retries that removal", async () => {
    vi.useFakeTimers();
    const held = deferred<() => Promise<void>>();
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC failed"))
      .mockResolvedValue(undefined);
    mocks.listen.mockReturnValueOnce(held.promise);
    render(
      <NotificationFixture>
        <DesktopNotificationNotice />
      </NotificationFixture>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Retry desktop alerts" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      held.resolve(remove);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "previous desktop alert connection could not close",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry desktop alerts" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
