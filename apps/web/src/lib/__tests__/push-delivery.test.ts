import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  env: {
    EXPO_ACCESS_TOKEN: "expo-access-token",
    VAPID_PRIVATE_KEY: "private-key",
    VAPID_PUBLIC_KEY: "public-key",
    VAPID_SUBJECT: "mailto:test@showpilot.tech",
  },
  rows: [] as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>,
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.env }));

vi.mock("../d1", () => ({
  getD1: () => ({
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          mocks.calls.push({ sql, params });
          return {
            async all<T>() {
              return { results: mocks.rows as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  }),
}));

vi.mock("web-push", () => ({
  default: {
    sendNotification: mocks.sendNotification,
    setVapidDetails: mocks.setVapidDetails,
  },
}));

import { deliverPushToUser } from "../push-delivery.server";

const payload = {
  title: "Crew call changed",
  body: "Your call time is now 07:30.",
  url: "/faithfire/schedule",
  tag: "assignment-1",
};

describe("push delivery", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.rows.length = 0;
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("queues a receipt after Expo accepts a native push", async () => {
    mocks.rows.push({
      id: "subscription-1",
      endpoint: "ExpoPushToken[native-token]",
      p256dh: "",
      auth: "",
    });
    const fetcher = vi.fn(async () => Response.json({
      data: { status: "ok", id: "ticket-1" },
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(deliverPushToUser("org-1", "user-1", payload)).resolves.toEqual({
      sent: 1,
      configured: true,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://exp.host/--/api/v2/push/send",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer expo-access-token" }),
      }),
    );
    const receiptInsert = mocks.calls.find((call) => call.sql.includes("INSERT INTO expo_push_receipt"));
    expect(receiptInsert?.params).toEqual([expect.any(String), "ticket-1", "subscription-1"]);
  });

  it("removes a native token rejected as unregistered", async () => {
    mocks.rows.push({
      id: "subscription-2",
      endpoint: "ExponentPushToken[stale-token]",
      p256dh: "",
      auth: "",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{
        status: "error",
        message: "The device is no longer registered",
        details: { error: "DeviceNotRegistered" },
      }],
    })));

    await expect(deliverPushToUser("org-1", "user-1", payload)).resolves.toEqual({
      sent: 0,
      configured: true,
    });
    expect(mocks.calls).toContainEqual({
      sql: "DELETE FROM push_subscription WHERE id = ?",
      params: ["subscription-2"],
    });
  });

  it("removes an expired browser push subscription", async () => {
    mocks.rows.push({
      id: "subscription-3",
      endpoint: "https://push.example.test/subscription-3",
      p256dh: "p256dh",
      auth: "auth",
    });
    mocks.sendNotification.mockRejectedValue({ statusCode: 410 });

    await expect(deliverPushToUser("org-1", "user-1", payload)).resolves.toEqual({
      sent: 0,
      configured: true,
    });
    expect(mocks.calls).toContainEqual({
      sql: "DELETE FROM push_subscription WHERE id = ?",
      params: ["subscription-3"],
    });
  });
});
