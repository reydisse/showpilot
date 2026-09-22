import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyOperationalEvent } from "../operational-notifications.server";

const mocks = vi.hoisted(() => ({
  binds: [] as unknown[][],
  insertError: null as Error | null,
  deliverPushToUser: vi.fn(),
  deviceAlerts: true,
  memberError: null as Error | null,
  preferenceError: null as Error | null,
  organizationError: null as Error | null,
}));

vi.mock("../db", () => ({
  getPrisma: () => ({
    member: { findMany: vi.fn(async () => {
      if (mocks.memberError) throw mocks.memberError;
      return [{ userId: "user-1", role: "member" }];
    }) },
    organization: {
      findUnique: vi.fn(async () => {
        if (mocks.organizationError) throw mocks.organizationError;
        return { slug: "test-org" };
      }),
    },
  }),
}));

vi.mock("../d1", () => ({
  getD1: () => ({
    prepare(sql: string) {
      expect(sql).toContain("ON CONFLICT(id) DO UPDATE");
      return {
        bind(...params: unknown[]) {
          mocks.binds.push(params);
          return {
            async run() {
              if (mocks.insertError) throw mocks.insertError;
              return { success: true };
            },
          };
        },
      };
    },
  }),
}));

vi.mock("../push-delivery.server", () => ({
  deliverPushToUser: mocks.deliverPushToUser,
}));

vi.mock("../notification-preferences.server", () => ({
  readRecipientNotificationPreferences: vi.fn(async (
    _orgId: string,
    userIds: string[],
  ) => {
    if (mocks.preferenceError) throw mocks.preferenceError;
    return new Map(userIds.map((userId) => [userId, mocks.deviceAlerts]));
  }),
}));

const event = {
  orgId: "org-1",
  recipientIds: ["user-1"],
  category: "schedule" as const,
  type: "assignment",
  title: "New assignment",
  message: "Stage manager · Sunday Service",
  actionUrl: "schedule?date=2026-09-30",
  source: "assignment-1",
  pushTag: "assignment-1",
  dedupeKey: "assignment-1",
};

describe("operational notifications", () => {
  beforeEach(() => {
    mocks.binds.length = 0;
    mocks.insertError = null;
    mocks.deviceAlerts = true;
    mocks.memberError = null;
    mocks.preferenceError = null;
    mocks.organizationError = null;
    mocks.deliverPushToUser.mockReset();
    mocks.deliverPushToUser.mockResolvedValue({ sent: 0, configured: false });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("uses a stable id so retried events replace rather than duplicate", async () => {
    await expect(notifyOperationalEvent(event)).resolves.toEqual({ notified: 1 });
    await expect(notifyOperationalEvent(event)).resolves.toEqual({ notified: 1 });

    expect(mocks.binds).toHaveLength(2);
    expect(mocks.binds[0][0]).toMatch(/^evt_[a-f0-9]{48}$/);
    expect(mocks.binds[1][0]).toBe(mocks.binds[0][0]);
  });

  it("counts a durable inbox write even when best-effort push fails", async () => {
    mocks.deliverPushToUser.mockRejectedValue(new Error("push unavailable"));

    await expect(notifyOperationalEvent(event)).resolves.toEqual({ notified: 1 });
  });

  it("does not report delivery when the durable inbox write fails", async () => {
    mocks.insertError = new Error("database unavailable");

    await expect(notifyOperationalEvent(event)).resolves.toEqual({ notified: 0 });
    expect(mocks.deliverPushToUser).not.toHaveBeenCalled();
  });

  it("writes an inbox-only record without sending device push", async () => {
    mocks.deviceAlerts = false;

    await expect(notifyOperationalEvent(event)).resolves.toEqual({ notified: 1 });

    expect(mocks.deliverPushToUser).not.toHaveBeenCalled();
    expect(mocks.binds[0]).toEqual(expect.arrayContaining(["schedule", 0]));
  });

  it.each(["member", "preference", "organization"] as const)(
    "contains %s preparation failures after the authoritative operation",
    async (stage) => {
      if (stage === "member") mocks.memberError = new Error("member lookup unavailable");
      if (stage === "preference") mocks.preferenceError = new Error("preference lookup unavailable");
      if (stage === "organization") mocks.organizationError = new Error("organization lookup unavailable");

      await expect(notifyOperationalEvent({ ...event, includeLeadership: true })).resolves.toEqual({ notified: 0 });
    },
  );
});
