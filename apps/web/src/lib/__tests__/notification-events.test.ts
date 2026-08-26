import { describe, expect, it, vi } from "vitest";
import {
  announcePersonalNotificationCount,
  PERSONAL_NOTIFICATION_COUNT_EVENT,
  readPersonalNotificationCount,
} from "../notification-events";

describe("personal notification count events", () => {
  it("announces a normalized workspace count", () => {
    const listener = vi.fn();
    window.addEventListener(PERSONAL_NOTIFICATION_COUNT_EVENT, listener);
    announcePersonalNotificationCount("org-1", 4.9);
    window.removeEventListener(PERSONAL_NOTIFICATION_COUNT_EVENT, listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(readPersonalNotificationCount(listener.mock.calls[0][0])).toEqual({ orgId: "org-1", unread: 4 });
  });

  it("rejects malformed events and clamps negative counts", () => {
    expect(readPersonalNotificationCount(new Event("other"))).toBeNull();
    expect(readPersonalNotificationCount(new CustomEvent(PERSONAL_NOTIFICATION_COUNT_EVENT, { detail: { orgId: "org-1", unread: -3 } }))).toEqual({ orgId: "org-1", unread: 0 });
    expect(readPersonalNotificationCount(new CustomEvent(PERSONAL_NOTIFICATION_COUNT_EVENT, { detail: { orgId: "", unread: 2 } }))).toBeNull();
  });
});
