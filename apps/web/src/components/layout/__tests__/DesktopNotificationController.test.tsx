import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotificationController } from "../DesktopNotificationController";

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: "faithfire-production" }),
}));

vi.mock("@/lib/desktop-runtime", () => ({
  DESKTOP_NOTIFICATION_POLL_EVENT: "showpilot-desktop-notification-poll",
  focusDesktopMainWindow: vi.fn().mockResolvedValue(undefined),
  isDesktopMainWindow: () => true,
  isDesktopRuntime: () => true,
  listenForDesktopNotificationActions: vi.fn().mockResolvedValue(() => undefined),
  showDesktopNotification: mocks.showNotification,
}));

vi.mock("@/lib/personal-notifications", () => ({
  getPersonalNotifications: mocks.getNotifications,
}));

vi.mock("@/lib/session", () => ({
  getOrgRouteContext: vi.fn().mockResolvedValue({
    user: { id: "user-1" },
    org: { id: "org-1" },
  }),
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
  beforeEach(() => {
    window.localStorage.clear();
    mocks.getNotifications.mockReset();
    mocks.showNotification.mockReset();
    mocks.getNotifications.mockResolvedValue({ notifications: [oldNotification] });
  });

  it("retries an unread notification when native permission initially prevents delivery", async () => {
    render(<DesktopNotificationController />);

    const historyKey = "showpilot.desktop-notifications.v1:user-1:org-1";
    await waitFor(() => expect(window.localStorage.getItem(historyKey)).toContain(oldNotification.id));
    expect(mocks.showNotification).not.toHaveBeenCalled();

    mocks.getNotifications.mockResolvedValue({ notifications: [newNotification, oldNotification] });
    mocks.showNotification.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    act(() => window.dispatchEvent(new Event("showpilot-desktop-notification-poll")));
    await waitFor(() => expect(mocks.showNotification).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(historyKey)).not.toContain(newNotification.id);

    act(() => window.dispatchEvent(new Event("showpilot-desktop-notification-poll")));
    await waitFor(() => expect(mocks.showNotification).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.localStorage.getItem(historyKey)).toContain(newNotification.id));
  });
});
