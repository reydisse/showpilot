import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase, type MobileApiStatement } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  notify: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
  resolveAccessGrantAuthorityForAccess: vi.fn(),
}));

vi.mock("../operational-notifications.server", () => ({
  notifyOperationalEvent: mocks.notify,
}));

interface QueryCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(input: {
  calls?: QueryCall[];
  notificationsEnabled?: boolean;
  memberIds?: string[];
} = {}): MobileApiDatabase {
  const receipts = new Map<string, { fingerprint: string; payload: string }>();
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    input.calls?.push({ sql, params });
    return {
      async first<T>() {
        if (sql.startsWith("SELECT fingerprint,payload FROM chat_pass_creation_receipt")) return (receipts.get(JSON.stringify(params)) ?? null) as T | null;
        if (sql.startsWith("SELECT COUNT(DISTINCT userId) AS count FROM notification")) return { count: params.length-2 } as T;
        if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" } as T;
        if (sql.startsWith("SELECT slug FROM organization WHERE id = ?")) return { slug: "faithfire-production" } as T;
        if (sql.includes("key = 'notify-app-chat'")) {
          return (input.notificationsEnabled === false ? { value: "false" } : null) as T | null;
        }
        if (sql.startsWith("SELECT userId FROM member WHERE organizationId = ? AND userId = ?")) {
          const userId = String(params[1]);
          return (input.memberIds ?? ["operator-1", "operator-2", "operator-3"]).includes(userId)
            ? { userId } as T
            : null;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM member m") && sql.includes("JOIN user u")) {
          return { results: [
            { userId: "operator-1", role: "admin", name: "Ada Operator", image: null },
            { userId: "operator-2", role: "member", name: "Sam Crew", image: "/api/user/avatar/operator-2.jpg" },
          ] as T[] };
        }
        if (sql === "SELECT userId FROM member WHERE organizationId = ?") {
          return { results: (input.memberIds ?? ["operator-1", "operator-2", "operator-3"]).map((userId) => ({ userId })) as T[] };
        }
        if (sql.startsWith("SELECT userId FROM member WHERE organizationId = ? AND userId IN")) {
          const allowed = new Set(input.memberIds ?? ["operator-1", "operator-2", "operator-3"]);
          return { results: params.slice(1).filter((userId) => allowed.has(String(userId))).map((userId) => ({ userId })) as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.startsWith("INSERT INTO chat_pass_creation_receipt")) {
          const key = JSON.stringify(params.slice(0,3));
          if (!receipts.has(key)) receipts.set(key, { fingerprint: String(params[3]), payload: String(params[4]) });
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => statement(sql, params) };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

async function request(db: MobileApiDatabase, path: string, body?: Record<string, unknown>) {
  const response = await handleMobileApi(new Request(`https://showpilot.tech${path}`, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : undefined), { DB: db, KIOSK_SECRET: "mobile-chat-test-secret" });
  if (!response) throw new Error("Mobile API did not handle chat route");
  return response;
}

describe("mobile chat collaboration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: "operator-1", name: "Ada Operator", email: "ada@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({
      role: "admin",
      permissions: ["chat:access"],
      today: "2026-08-27",
    });
    mocks.notify.mockImplementation(async ({ recipientIds }: { recipientIds?: string[] }) => ({
      notified: recipientIds?.length ?? 0,
    }));
  });

  it("lists only tenant members for a chat participant", async () => {
    const calls: QueryCall[] = [];
    const response = await request(fakeDatabase({ calls }), "/api/mobile/v1/chat/members?orgId=org-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      currentUserId: "operator-1",
      canInvite: true,
      members: [
        { userId: "operator-1", role: "admin", name: "Ada Operator", image: null },
        { userId: "operator-2", role: "member", name: "Sam Crew", image: "/api/user/avatar/operator-2.jpg" },
      ],
    });
    expect(calls.find((call) => call.sql.includes("JOIN user u"))?.params).toEqual(["org-1"]);
  });

  it.each(["production", "planning"])("notifies group members without requiring mentions in %s", async (roomId) => {
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/notify?orgId=org-1", {
      roomId, text: "Rehearsal starts in ten minutes", messageId: "group-message-1",
    });
    expect(response.status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: ["operator-2", "operator-3"], type: "chat-group-message",
    }));
  });

  it("sends one notification per member when a group message also mentions them", async () => {
    await request(fakeDatabase(), "/api/mobile/v1/chat/notify?orgId=org-1", {
      roomId: "production", text: "<@operator-2|Sam> check audio", mentionedUserIds: ["operator-2"], messageId: "group-message-2",
    });
    const recipients = mocks.notify.mock.calls.flatMap(([event]) => event.recipientIds);
    expect(recipients.sort()).toEqual(["operator-2", "operator-3"]);
  });

  it("notifies a canonical direct-message participant", async () => {
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/notify?orgId=org-1", {
      roomId: "dm:operator-1:operator-2",
      text: "Can you check comms?",
      mentionedUserIds: [],
      messageId: "message-1",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notified: 1 });
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "operator-1",
      recipientIds: ["operator-2"],
      type: "chat-direct-message",
      dedupeKey: "chat-message:message-1:dm",
    }));
  });

  it("excludes members without room access even when they are mentioned", async () => {
    mocks.resolveAccess.mockImplementation(async (_db, userId) => ({
      role: "member", permissions: userId === "operator-3" ? [] : ["chat:access"], today: "2026-08-27",
    }));
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/notify?orgId=org-1", {
      roomId: "production", text: "Crew update", messageId: "group-no-access", mentionedUserIds: ["operator-3"],
    });
    expect(response.status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: ["operator-2"] }));
  });

  it("drops mention targets that are outside the organization", async () => {
    const response = await request(fakeDatabase({ memberIds: ["operator-1", "operator-2"] }), "/api/mobile/v1/chat/notify?orgId=org-1", {
      roomId: "production",
      text: "<@operator-2|Sam Crew> and <@foreign-user|Unknown>",
      mentionedUserIds: ["operator-2", "foreign-user"],
      messageId: "message-2",
    });
    expect(response.status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: ["operator-2"],
      message: "@Sam Crew and @Unknown",
    }));
  });

  it("rejects a direct-message room that does not include the caller", async () => {
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/notify?orgId=org-1", {
      roomId: "dm:operator-2:operator-3",
      text: "Tenant boundary probe",
      mentionedUserIds: [],
      messageId: "message-3",
    });
    expect(response.status).toBe(400);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("honors the organization chat-notification setting", async () => {
    const response = await request(fakeDatabase({ notificationsEnabled: false }), "/api/mobile/v1/chat/reaction-notify?orgId=org-1", {
      roomId: "production",
      messageId: "message-4",
      targetUserId: "operator-2",
      emoji: "👍",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notified: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("creates an expiring guest crew link for production leaders", async () => {
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/passes/crew?orgId=org-1", { hours: 4 });
    expect(response.status).toBe(200);
    const payload = await response.json() as { token: string; joinUrl: string; expiresAt: number };
    expect(payload.token).toMatch(/^chat_/);
    expect(payload.joinUrl).toContain("/join/chat/chat_");
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  it("creates a targeted Planning Room link and notifies valid members", async () => {
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/passes/planning?orgId=org-1", {
      hours: 8,
      targetUserIds: ["operator-2", "operator-3"],
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { token: string; targetCount: number };
    expect(payload.token).toMatch(/^planning_chat_/);
    expect(payload.targetCount).toBe(2);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientIds: ["operator-2", "operator-3"],
      type: "chat-planning-invite",
    }));
  });

  it("rejects a Planning Room target outside the organization", async () => {
    const response = await request(fakeDatabase({ memberIds: ["operator-1", "operator-2"] }), "/api/mobile/v1/chat/passes/planning?orgId=org-1", {
      hours: 8,
      targetUserIds: ["operator-2", "foreign-user"],
    });
    expect(response.status).toBe(400);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not let an ordinary chat member mint guest passes", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: ["chat:access"], today: "2026-08-27" });
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/passes/crew?orgId=org-1", { hours: 4 });
    expect(response.status).toBe(403);
  });

  it("requires effective chat access", async () => {
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: [], today: "2026-08-27" });
    const response = await request(fakeDatabase(), "/api/mobile/v1/chat/members?orgId=org-1");
    expect(response.status).toBe(403);
  });
  const notificationRequest = { roomId: "production", messageId: "saved-message", text: "Crew update", targetUserId: "operator-2", emoji: "👍", expectedUserId: "operator-1", requestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" };
  it.each(["notify", "reaction-notify"])("reports %s inbox failure separately from the saved chat update", async endpoint => {
    mocks.notify.mockRejectedValue(new Error("D1 unavailable"));
    const response = await request(fakeDatabase(), `/api/mobile/v1/chat/${endpoint}?orgId=org-1`, notificationRequest);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/Retry notifications/) });
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ requireInbox: true, once: true }));
  });
  it.each(["notify", "reaction-notify"])("returns authoritative identity for %s including disabled notifications", async endpoint => {
    const response = await request(fakeDatabase({ notificationsEnabled: false }), `/api/mobile/v1/chat/${endpoint}?orgId=org-1`, notificationRequest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notified: 0, orgId: "org-1", userId: "operator-1", roomId: "production", messageId: notificationRequest.messageId, requestId: notificationRequest.requestId });
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it.each(["notify", "reaction-notify"])("refuses %s queued by another signed-in account", async endpoint => {
    const response = await request(fakeDatabase(), `/api/mobile/v1/chat/${endpoint}?orgId=org-1`, { ...notificationRequest, expectedUserId: "previous-operator" });
    expect(response.status).toBe(409); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it.each(["notify", "reaction-notify"])("validates %s retry identity before writing", async endpoint => {
    const response = await request(fakeDatabase(), `/api/mobile/v1/chat/${endpoint}?orgId=org-1`, { ...notificationRequest, requestId: "not-a-uuid" });
    expect(response.status).toBe(400); expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("keeps reaction retries keyed to the original actor and event", async () => {
    for (let i = 0; i < 2; i++) {
      const response = await request(fakeDatabase(), "/api/mobile/v1/chat/reaction-notify?orgId=org-1", notificationRequest);
      expect(response.status).toBe(200);
    }
    for (const [event] of mocks.notify.mock.calls) expect(event).toMatchObject({
      once: true, requireInbox: true, dedupeKey: `chat-reaction:operator-1:${notificationRequest.requestId}`, recipientIds: ["operator-2"],
    });
  });
  it("retries all notification groups with stable once-only identities after a partial failure", async () => {
    mocks.notify.mockResolvedValueOnce({ notified: 1 }).mockRejectedValueOnce(new Error("Group inbox unavailable"));
    const body = { ...notificationRequest, mentionedUserIds: ["operator-2"] };
    const failed = await request(fakeDatabase(), "/api/mobile/v1/chat/notify?orgId=org-1", body);
    expect(failed.status).toBe(503);
    const retried = await request(fakeDatabase(), "/api/mobile/v1/chat/notify?orgId=org-1", body);
    expect(retried.status).toBe(200);
    expect(mocks.notify.mock.calls).toHaveLength(4);
    expect(mocks.notify.mock.calls[2][0]).toEqual(mocks.notify.mock.calls[0][0]);
    expect(mocks.notify.mock.calls[3][0]).toEqual(mocks.notify.mock.calls[1][0]);
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({ once: true, dedupeKey: "chat-message:saved-message:mention" });
  });

});
