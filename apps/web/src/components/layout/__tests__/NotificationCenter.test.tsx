import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render as renderUI,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationInbox } from "../NotificationCenter";

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  getPreferences: vi.fn(),
  updatePreference: vi.fn(),
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
  getPersonalNotificationPreferences: mocks.getPreferences,
  markAllPersonalNotificationsRead: mocks.markAllRead,
  markPersonalNotificationRead: mocks.markRead,
  updatePersonalNotificationPreference: mocks.updatePreference,
}));

vi.mock("@/lib/desktop-runtime", () => ({
  isDesktopRuntime: () => mocks.isDesktop,
}));

function render(
  ui: ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return renderUI(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("NotificationInbox", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    mocks.isDesktop = false;
  });

  beforeEach(() => {
    mocks.getPreferences.mockResolvedValue([]);
    mocks.updatePreference.mockResolvedValue({
      outcome: "applied",
      preference: { category: "schedule", deviceAlerts: false },
    });
  });

  it("keeps long assignment responses readable and clears unread state", async () => {
    const longMessage =
      "Jordan declined because their travel schedule changed. "
        .repeat(12)
        .trim();
    mocks.getNotifications.mockResolvedValue({
      unread: 1,
      notifications: [
        {
          id: "notification-1",
          type: "assignment",
          severity: "high",
          title: "Assignment declined",
          message: longMessage,
          actionUrl: "schedule?assignment=assignment-1",
          source: "schedule",
          createdAt: new Date().toISOString(),
          readAt: null,
        },
      ],
    });
    mocks.markAllRead.mockImplementation(async ({ data }) => {
      mocks.getNotifications.mockResolvedValue({
        notifications: [],
        unread: 0,
        nextCursor: null,
      });
      return {
        ok: true,
        requestId: data.requestId,
        readAt: new Date().toISOString(),
      };
    });
    const onUnreadChange = vi.fn();

    render(
      <NotificationInbox
        userId="fixture-user"
        orgId="org-1"
        slug="launch-audit"
        onUnreadChange={onUnreadChange}
      />,
    );

    expect(await screen.findByText("Assignment declined")).not.toBe(undefined);
    const message = screen.getByText(longMessage);
    expect(message.className).toContain("break-words");
    expect(message.className).toContain("[overflow-wrap:anywhere]");

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    await waitFor(() =>
      expect(mocks.markAllRead).toHaveBeenCalledWith({
        data: { orgId: "org-1", requestId: expect.any(String) },
        signal: expect.any(AbortSignal),
      }),
    );
    await waitFor(() => expect(onUnreadChange).toHaveBeenCalledWith(0));
    expect(screen.queryByText("Unread")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    expect(onUnreadChange).toHaveBeenCalledWith(0);
  });

  it("shows a useful empty state", async () => {
    mocks.getNotifications.mockResolvedValue({ notifications: [], unread: 0 });

    render(
      <NotificationInbox
        userId="fixture-user"
        orgId="org-1"
        slug="launch-audit"
      />,
    );

    expect(await screen.findByText("Nothing waiting for you.")).not.toBe(
      undefined,
    );
    expect(
      screen.getByText(/Assignments, mentions, and operational alerts/),
    ).not.toBe(undefined);
  });

  it("loads older history with a stable cursor and keeps both pages", async () => {
    const cursor = {
      createdAt: "2026-09-20T12:00:00.000Z",
      id: "notification-30",
    };
    mocks.getNotifications
      .mockResolvedValueOnce({
        unread: 2,
        nextCursor: cursor,
        notifications: [
          {
            id: "notification-new",
            type: "assignment",
            severity: "info",
            title: "Newest alert",
            message: "New",
            actionUrl: "schedule",
            source: "new",
            createdAt: "2026-09-21T12:00:00.000Z",
            readAt: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        unread: 2,
        nextCursor: null,
        notifications: [
          {
            id: "notification-old",
            type: "assignment",
            severity: "info",
            title: "Older alert",
            message: "Old",
            actionUrl: "schedule",
            source: "old",
            createdAt: cursor.createdAt,
            readAt: null,
          },
        ],
      });

    render(
      <NotificationInbox
        userId="fixture-user"
        orgId="org-1"
        slug="launch-audit"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Load older notifications" }),
    );

    await waitFor(() =>
      expect(mocks.getNotifications).toHaveBeenLastCalledWith({
        data: { orgId: "org-1", cursor },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(screen.getByText("Newest alert")).not.toBe(undefined);
    expect(await screen.findByText("Older alert")).not.toBe(undefined);
    expect(
      screen.queryByRole("button", { name: "Load older notifications" }),
    ).toBeNull();

    mocks.getNotifications.mockResolvedValueOnce({
      unread: 2,
      nextCursor: cursor,
      notifications: [
        {
          id: "notification-new",
          type: "assignment",
          severity: "info",
          title: "Newest alert",
          message: "New",
          actionUrl: "schedule",
          source: "new",
          createdAt: "2026-09-21T12:00:00.000Z",
          readAt: null,
        },
      ],
    });
    mocks.getNotifications.mockResolvedValueOnce({
      unread: 2,
      nextCursor: null,
      notifications: [
        {
          id: "notification-old",
          type: "assignment",
          severity: "info",
          title: "Older alert",
          message: "Old",
          actionUrl: "schedule",
          source: "old",
          createdAt: cursor.createdAt,
          readAt: null,
        },
      ],
    });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() =>
      expect(mocks.getNotifications).toHaveBeenCalledTimes(4),
    );
    expect(screen.getByText("Older alert")).not.toBe(undefined);
    expect(
      screen.queryByRole("button", { name: "Load older notifications" }),
    ).toBeNull();
  });

  it("does not resurrect unread state when an older refresh finishes after mark all read", async () => {
    const notification = {
      id: "race",
      type: "assignment",
      severity: "info",
      title: "Crew call",
      message: "Arrive at 8",
      actionUrl: "",
      source: "show",
      createdAt: "2026-09-28T12:00:00Z",
      readAt: null,
    };
    const page = { notifications: [notification], unread: 1, nextCursor: null };
    mocks.getNotifications.mockResolvedValueOnce(page);
    mocks.markAllRead.mockImplementation(async ({ data }) => {
      mocks.getNotifications.mockResolvedValue({
        notifications: [],
        unread: 0,
        nextCursor: null,
      });
      return {
        ok: true,
        requestId: data.requestId,
        readAt: new Date().toISOString(),
      };
    });
    render(
      <NotificationInbox
        userId="fixture-user"
        orgId="org-1"
        slug="launch-audit"
      />,
    );
    await screen.findByText("Crew call");
    let finishRefresh: (value: typeof page) => void = () => {};
    mocks.getNotifications.mockReturnValueOnce(
      new Promise<typeof page>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() =>
      expect(mocks.getNotifications).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await act(async () => {
      finishRefresh(page);
    });
    await waitFor(() => expect(screen.queryByText("Unread")).toBeNull());
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
  });

  it("always keeps the inbox on and exposes one device-alert choice per category", async () => {
    mocks.getNotifications.mockResolvedValue({ notifications: [], unread: 0 });
    mocks.getPreferences.mockResolvedValue([
      { category: "schedule", deviceAlerts: true },
    ]);

    render(
      <NotificationInbox
        userId="fixture-user"
        orgId="org-1"
        slug="launch-audit"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Preferences" }));
    expect(screen.getByText(/Everything stays in your inbox/)).not.toBe(
      undefined,
    );
    expect(screen.queryByRole("switch", { name: /in-app/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("switch", { name: "Schedule device alerts" }),
    );

    await waitFor(() =>
      expect(mocks.updatePreference).toHaveBeenCalledWith({
        data: {
          orgId: "org-1",
          category: "schedule",
          deviceAlerts: false,
          expectedDeviceAlerts: true,
          requestId: expect.any(String),
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses the Desktop controller count event instead of starting another polling interval", async () => {
    mocks.isDesktop = true;
    mocks.getNotifications
      .mockResolvedValueOnce({ notifications: [], unread: 1 })
      .mockResolvedValueOnce({ notifications: [], unread: 2 });
    const intervalSpy = vi.spyOn(window, "setInterval");

    render(
      <NotificationInbox
        userId="fixture-user"
        orgId="org-1"
        slug="launch-audit"
      />,
    );
    await waitFor(() =>
      expect(mocks.getNotifications).toHaveBeenCalledTimes(1),
    );
    expect(intervalSpy.mock.calls.some(([, delay]) => delay === 20_000)).toBe(
      false,
    );

    act(() =>
      window.dispatchEvent(
        new CustomEvent("showpilot-personal-notification-count", {
          detail: { orgId: "org-1", unread: 2 },
        }),
      ),
    );

    await waitFor(() =>
      expect(mocks.getNotifications).toHaveBeenCalledTimes(2),
    );
    intervalSpy.mockRestore();
  });
});

const fixtureAlert = {
  id: "alert-1",
  type: "assignment",
  severity: "info",
  title: "Inbox fixture",
  message: "Arrive early",
  actionUrl: "schedule",
  source: "show",
  createdAt: "2026-11-08T00:00:00Z",
  readAt: null,
};
const fixturePage = {
  notifications: [fixtureAlert],
  unread: 1,
  nextCursor: null,
};
const inboxUI = (
  <NotificationInbox userId="fixture-user" orgId="org-1" slug="launch-audit" />
);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("bounds the initial read, never claims empty on failure, and ignores its late reply", async () => {
  const held = deferred<typeof fixturePage>();
  mocks.getNotifications.mockReturnValueOnce(held.promise);
  vi.useFakeTimers();
  const view = render(inboxUI);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_100);
  });
  expect(
    screen.getByRole("button", { name: "Retry notifications" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Loading notifications")).toBeNull();
  expect(screen.queryByText("Nothing waiting for you.")).toBeNull();
  expect(document.querySelector("[role=alert] time")).toBeTruthy();
  expect(mocks.getNotifications.mock.calls.at(-1)?.[0].signal.aborted).toBe(
    true,
  );
  await act(async () => {
    held.resolve(fixturePage);
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.queryByText("Inbox fixture")).toBeNull();
  mocks.getNotifications.mockResolvedValue(fixturePage);
  fireEvent.click(screen.getByRole("button", { name: "Retry notifications" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByText("Inbox fixture")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  vi.useRealTimers();
});

it("keeps confirmed history while a timed-out older-page read retries the same cursor", async () => {
  const cursor = { id: "alert-1", createdAt: fixtureAlert.createdAt };
  const held = deferred<typeof fixturePage>();
  mocks.getNotifications
    .mockResolvedValueOnce({ ...fixturePage, nextCursor: cursor })
    .mockReturnValueOnce(held.promise);
  const view = render(inboxUI);
  await screen.findByText("Inbox fixture");
  vi.useFakeTimers();
  fireEvent.click(
    screen.getByRole("button", { name: "Load older notifications" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_100);
  });
  expect(screen.getByText("Inbox fixture")).toBeTruthy();
  expect(
    screen.getByText(/Older notifications could not be loaded/),
  ).toBeTruthy();
  mocks.getNotifications.mockResolvedValueOnce({
    notifications: [{ ...fixtureAlert, id: "old", title: "Older fixture" }],
    unread: 1,
    nextCursor: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry notifications" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(mocks.getNotifications).toHaveBeenLastCalledWith({
    data: { orgId: "org-1", cursor },
    signal: expect.any(AbortSignal),
  });
  expect(screen.getByText("Older fixture")).toBeTruthy();
  await act(async () => {
    held.resolve({ ...fixturePage, notifications: [] });
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByText("Older fixture")).toBeTruthy();
  view.unmount();
  vi.useRealTimers();
});

it("retains an uncertain mark-all across panel close and retries its original request", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.getNotifications.mockResolvedValue(fixturePage);
  const held = deferred<{ ok: true; requestId: string; readAt: string }>();
  mocks.markAllRead.mockReturnValueOnce(held.promise);
  let view = render(inboxUI, client);
  await screen.findByText("Inbox fixture");
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const original = mocks.markAllRead.mock.calls.at(-1)?.[0].data;
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_100);
  });
  view = render(inboxUI, client);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByText(/Mark all read was not confirmed/)).toBeTruthy();
  await act(async () => {
    held.resolve({
      ok: true,
      requestId: original.requestId,
      readAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(
    screen.getByRole("button", { name: "Retry read status" }),
  ).toBeTruthy();
  mocks.markAllRead.mockImplementationOnce(async ({ data }) => {
    mocks.getNotifications.mockResolvedValue({
      notifications: [
        { ...fixtureAlert, id: "new", title: "Arrived after mark-all" },
      ],
      unread: 1,
      nextCursor: null,
    });
    return {
      ok: true,
      requestId: data.requestId,
      readAt: new Date().toISOString(),
    };
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry read status" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(mocks.markAllRead).toHaveBeenLastCalledWith({
    data: original,
    signal: expect.any(AbortSignal),
  });
  expect(screen.getByText("Arrived after mark-all")).toBeTruthy();
  expect(screen.getByText("Unread")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Retry read status" }),
  ).toBeNull();
  view.unmount();
  client.clear();
  vi.useRealTimers();
});

it("retains individual read failures after navigation without leaking them to another account", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.getNotifications.mockResolvedValue(fixturePage);
  mocks.markRead.mockRejectedValue(new Error("network"));
  const view = render(inboxUI, client);
  fireEvent.click(await screen.findByRole("button", { name: /Inbox fixture/ }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalled());
  await screen.findByRole("button", { name: "Retry read status" });
  const original = mocks.markRead.mock.calls.at(-1)?.[0].data;
  view.unmount();
  const other = render(
    <NotificationInbox userId="other-user" orgId="org-1" slug="launch-audit" />,
    client,
  );
  await screen.findByText("Inbox fixture");
  expect(
    screen.queryByRole("button", { name: "Retry read status" }),
  ).toBeNull();
  other.unmount();
  const again = render(inboxUI, client);
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry read status" }),
  );
  await waitFor(() =>
    expect(mocks.markRead).toHaveBeenLastCalledWith({
      data: original,
      signal: expect.any(AbortSignal),
    }),
  );
  again.unmount();
  client.clear();
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});


it("pauses hidden polling and coalesces focus events into the active read", async () => {
  mocks.getNotifications.mockResolvedValueOnce(fixturePage);
  const view = render(inboxUI);
  await screen.findByText("Inbox fixture");
  const visibility = vi.spyOn(document, "visibilityState", "get");
  vi.useFakeTimers();
  visibility.mockReturnValue("hidden");
  focusManager.setFocused(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(40_100); });
  expect(mocks.getNotifications).toHaveBeenCalledTimes(1);
  const held = deferred<typeof fixturePage>();
  mocks.getNotifications.mockReturnValueOnce(held.promise);
  visibility.mockReturnValue("visible");focusManager.setFocused(true);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(mocks.getNotifications).toHaveBeenCalledTimes(2);
  await act(async () => { held.resolve(fixturePage); await vi.advanceTimersByTimeAsync(10); });
  view.unmount();visibility.mockRestore();focusManager.setFocused(undefined);vi.useRealTimers();
});

it("publishes the newest page's count and repairs the sidebar on a fresh unchanged count", async () => {
  const cursor = { id: "alert-1", createdAt: fixtureAlert.createdAt };
  const first = { ...fixturePage, nextCursor: cursor };
  const older = { notifications: [{ ...fixtureAlert, id: "old", title: "Older counted alert" }], unread: 2, nextCursor: null };
  mocks.getNotifications.mockResolvedValueOnce(first).mockResolvedValueOnce(older);
  mocks.getPreferences.mockResolvedValue([]);
  const onUnreadChange = vi.fn();
  render(<NotificationInbox userId="fixture-user" orgId="org-1" slug="launch-audit" onUnreadChange={onUnreadChange} />);
  await screen.findByText("Inbox fixture");
  fireEvent.click(screen.getByRole("button", { name: "Load older notifications" }));
  await screen.findByText("Older counted alert");
  await waitFor(() => expect(onUnreadChange).toHaveBeenLastCalledWith(2));
  onUnreadChange.mockClear();
  mocks.getNotifications.mockResolvedValueOnce({ ...first, unread: 2 }).mockResolvedValueOnce(older);
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(mocks.getNotifications).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(onUnreadChange).toHaveBeenCalledWith(2));
});
