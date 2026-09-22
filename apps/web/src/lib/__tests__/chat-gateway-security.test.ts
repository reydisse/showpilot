// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  access: vi.fn(),
  relay: vi.fn(),
  verifyPass: vi.fn(),
  storageGet: vi.fn(),
  storageDelete: vi.fn(),
  tombstoned: false,
}));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session } }) }));
vi.mock("@/lib/effective-access", () => ({ resolveEffectiveAccess: mocks.access }));
vi.mock("@/lib/crew-chat-pass", () => ({ verifyCrewChatPass: mocks.verifyPass }));
vi.mock("@/lib/mobile-api.server", () => ({ handleMobileApi: async () => null }));
vi.mock("@/lib/auth-origins", () => ({ isAllowedApiOrigin: () => true }));
vi.mock("@/durable-objects/ChatRelay", () => ({ ChatRelay: class {} }));
vi.mock("@/durable-objects/RundownRelay", () => ({ RundownRelay: class {} }));
vi.mock("@/durable-objects/TimecodeRelay", () => ({ TimecodeRelay: class {} }));
vi.mock("@/durable-objects/BridgeRelay", () => ({ BridgeRelay: class {} }));
vi.mock("@/durable-objects/LowerThirdsRelay", () => ({ LowerThirdsRelay: class {} }));
vi.mock("@/durable-objects/CueSheetRelay", () => ({ CueSheetRelay: class {} }));
import server from "../../server";

const testEnv = {
  KIOSK_SECRET: "test-only-secret",
  DB: {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org" };
          if (sql.includes("organization-deleting")) return mocks.tombstoned ? { value: "deleting" } : null;
          return null;
        },
        run: async () => ({ success: true }),
      }),
    }),
  },
  CHAT_RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: mocks.relay }) },
  STORAGE: { get: mocks.storageGet, delete: mocks.storageDelete },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.access.mockResolvedValue(null);
  mocks.verifyPass.mockResolvedValue({ orgId: "org", orgSlug: "org", exp: 4_000_000_000 });
  mocks.relay.mockResolvedValue(new Response("forwarded"));
  mocks.storageGet.mockResolvedValue(null);
  mocks.storageDelete.mockResolvedValue(undefined);
  mocks.tombstoned = false;
});

describe("chat gateway authority boundary", () => {
  it("rejects every old relay path once organization deletion is tombstoned", async () => {
    mocks.tombstoned = true;
    const response = await server.fetch(new Request("https://chat.test/api/chat/org/ws?guestToken=valid"), testEnv, {});
    expect(response.status).toBe(404);
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it("removes client identity and uses only the verified guest expiry", async () => {
    const response = await server.fetch(new Request("https://chat.test/api/chat/org/ws?guestToken=valid&guestName=Guest%20A&userId=owner&name=Owner&role=owner&guestExpiresAt=9999999999999"), testEnv, {});
    expect(response.status).toBe(200);
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    const params = new URL(forwarded.url).searchParams;
    expect(params.get("userId")).toBeNull();
    expect(params.get("name")).toBe("Guest A");
    expect(params.get("role")).toBe("Guest");
    expect(params.get("guestExpiresAt")).toBe("4000000000000");
    expect(params.get("attachmentOwnerId")).toMatch(/^guest:[0-9a-f]{64}$/);
  });

  it("takes member identity from authentication and discards a forged guest lease", async () => {
    mocks.session.mockResolvedValue({ user: { id: "member-1", name: "Authenticated Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    await server.fetch(new Request("https://chat.test/api/chat/org/ws?userId=other-member&name=Owner&role=owner&guestExpiresAt=1"), testEnv, {});
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    const params = new URL(forwarded.url).searchParams;
    expect(params.get("userId")).toBe("member-1");
    expect(params.get("name")).toBe("Authenticated Member");
    expect(params.get("role")).toBe("member");
    expect(params.get("guestExpiresAt")).toBeNull();
  });

  it("does not forward invalid guest passes or grant guests access to planning", async () => {
    mocks.verifyPass.mockResolvedValueOnce(null);
    expect((await server.fetch(new Request("https://chat.test/api/chat/org/ws?guestToken=invalid&userId=owner"), testEnv, {})).status).toBe(401);
    expect((await server.fetch(new Request("https://chat.test/api/chat/org/ws?guestToken=valid&room=planning"), testEnv, {})).status).toBe(403);
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it("returns a bounded client error for malformed multipart uploads", async () => {
    const response = await server.fetch(new Request("https://chat.test/api/chat/org/upload?guestToken=valid", {
      method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=missing" }, body: "truncated multipart",
    }), testEnv, {});
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid upload. Choose the file again.");
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it("lets only the uploader remove an unreferenced draft attachment", async () => {
    mocks.session.mockResolvedValue({ user: { id: "member-1", name: "Authenticated Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.storageGet.mockResolvedValue({ customMetadata: { uploadedBy: "member-1", roomId: "production" } });
    mocks.relay.mockResolvedValue(Response.json({ referenced: false }));

    const response = await server.fetch(new Request("https://chat.test/api/chat-file/org/file-1/notes.txt", {
      method: "DELETE",
    }), testEnv, {});

    expect(response.status).toBe(204);
    expect(mocks.storageDelete).toHaveBeenCalledWith("orgs/org/chat/file-1/notes.txt");
  });

  it("refuses to remove another member's attachment", async () => {
    mocks.session.mockResolvedValue({ user: { id: "member-1", name: "Authenticated Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.storageGet.mockResolvedValue({ customMetadata: { uploadedBy: "member-2", roomId: "production" } });

    const response = await server.fetch(new Request("https://chat.test/api/chat-file/org/file-2/stage.png", {
      method: "DELETE",
    }), testEnv, {});

    expect(response.status).toBe(403);
    expect(mocks.relay).not.toHaveBeenCalled();
    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });
});
