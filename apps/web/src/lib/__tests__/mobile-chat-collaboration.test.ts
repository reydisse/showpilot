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
  function statement(sql: string, params: unknown[]): MobileApiStatement {
    input.calls?.push({ sql, params });
    return {
      async first<T>() {
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
        if (sql.startsWith("SELECT userId FROM member WHERE organizationId = ? AND userId IN")) {
          const allowed = new Set(input.memberIds ?? ["operator-1", "operator-2", "operator-3"]);
          return { results: params.slice(1).filter((userId) => allowed.has(String(userId))).map((userId) => ({ userId })) as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
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
});
