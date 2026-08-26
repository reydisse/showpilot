import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationInbox } from "../NotificationCenter";

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
  navigate: vi.fn(),
  isDesktop: false,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/lib/personal-notifications", () => ({
  getPersonalNotifications: mocks.getNotifications,
  markAllPersonalNotificationsRead: mocks.markAllRead,
  markPersonalNotificationRead: mocks.markRead,
}));

vi.mock("@/lib/desktop-runtime", () => ({
  isDesktopRuntime: () => mocks.isDesktop,
}));

describe("NotificationInbox", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.isDesktop = false;
  });

  it("keeps long assignment responses readable and clears unread state", async () => {
    const longMessage = "Jordan declined because their travel schedule changed. ".repeat(12).trim();
    mocks.getNotifications.mockResolvedValue({
      unread: 1,
      notifications: [{
        id: "notification-1",
        type: "assignment",
        severity: "high",
        title: "Assignment declined",
        message: longMessage,
        actionUrl: "schedule?assignment=assignment-1",
        source: "schedule",
        createdAt: new Date().toISOString(),
        readAt: null,
      }],
    });
    mocks.markAllRead.mockResolvedValue({ ok: true });
    const onUnreadChange = vi.fn();

    render(<NotificationInbox orgId="org-1" slug="launch-audit" onUnreadChange={onUnreadChange} />);

    expect(await screen.findByText("Assignment declined")).not.toBe(undefined);
    const message = screen.getByText(longMessage);
    expect(message.className).toContain("break-words");
    expect(message.className).toContain("[overflow-wrap:anywhere]");

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    await waitFor(() => expect(mocks.markAllRead).toHaveBeenCalledWith({ data: { orgId: "org-1" } }));
    expect(screen.queryByText("Unread")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    expect(onUnreadChange).toHaveBeenCalledWith(0);
  });

  it("shows a useful empty state", async () => {
    mocks.getNotifications.mockResolvedValue({ notifications: [], unread: 0 });

    render(<NotificationInbox orgId="org-1" slug="launch-audit" />);

    expect(await screen.findByText("Nothing waiting for you.")).not.toBe(undefined);
    expect(screen.getByText(/Assignments, mentions, and operational alerts/)).not.toBe(undefined);
  });

  it("uses the Desktop controller count event instead of starting another polling interval", async () => {
    mocks.isDesktop = true;
    mocks.getNotifications
      .mockResolvedValueOnce({ notifications: [], unread: 1 })
      .mockResolvedValueOnce({ notifications: [], unread: 2 });
    const intervalSpy = vi.spyOn(window, "setInterval");

    render(<NotificationInbox orgId="org-1" slug="launch-audit" />);
    await waitFor(() => expect(mocks.getNotifications).toHaveBeenCalledTimes(1));
    expect(intervalSpy.mock.calls.some(([, delay]) => delay === 20_000)).toBe(false);

    act(() => window.dispatchEvent(new CustomEvent("showpilot-personal-notification-count", {
      detail: { orgId: "org-1", unread: 2 },
    })));

    await waitFor(() => expect(mocks.getNotifications).toHaveBeenCalledTimes(2));
    intervalSpy.mockRestore();
  });
});
