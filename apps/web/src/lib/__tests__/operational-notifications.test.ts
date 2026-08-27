import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyOperationalEvent } from "../operational-notifications.server";

const mocks = vi.hoisted(() => ({
  binds: [] as unknown[][],
  insertError: null as Error | null,
  deliverPushToUser: vi.fn(),
}));

vi.mock("../db", () => ({
  getPrisma: () => ({
    member: { findMany: vi.fn().mockResolvedValue([]) },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ slug: "test-org" }),
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

const event = {
  orgId: "org-1",
  recipientIds: ["user-1"],
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
});
