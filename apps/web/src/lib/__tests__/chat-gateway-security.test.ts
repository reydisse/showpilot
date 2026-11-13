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
  rooms: [] as string[],
}));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session } }) }));
vi.mock("@/lib/effective-access", () => ({ resolveEffectiveAccess: mocks.access }));
vi.mock("@/lib/chat-pass-revocation.server", () => ({ chatPassDigest: async () => "sha256:" + "a".repeat(64), verifyCrewChatPass: mocks.verifyPass }));
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
  BETTER_AUTH_SECRET: "test-only-internal-secret",
  DB: {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org" };
          if (sql.includes("organization-deleting")) return mocks.tombstoned ? { value: "deleting" } : null;
          if (sql.startsWith("SELECT userId FROM member")) return params[1] === "removed" ? null : { userId: params[1] };
          return null;
        },
        all: async () => ({ results: mocks.rooms.map((roomId) => ({ roomId })) }),
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
  mocks.rooms = [];
});

describe("chat gateway authority boundary", () => {
  it.each(["internal/guest-ws", "internal/external-import", "external/import"])("does not expose %s to a caller", async path => {
    const response = await server.fetch(new Request(`https://chat.test/api/chat/org/${path}?guestToken=valid`, {
      headers: { "x-showpilot-internal-secret": "forged" },
    }), testEnv, {});
    expect(response.status).toBe(404);
    expect(mocks.relay).not.toHaveBeenCalled();
  });

  it("counts only the authenticated user's group rooms and accessible DMs", async () => {
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Crew" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.rooms = ["production", "planning", "dm:member-1:member-2", "dm:member-2:member-3", "dm:member-1:removed"];
    mocks.relay.mockImplementation(async () => Response.json({ unread: 2 }));
    const response = await server.fetch(new Request("https://chat.test/api/chat/org/unread?userId=member-2"), testEnv, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unread: 6 });
    const requests = mocks.relay.mock.calls.map(([url]) => new URL(String(url)));
    expect(requests.map((url) => url.searchParams.get("room"))).toEqual(["production", "planning", "dm:member-1:member-2"]);
    expect(requests.every((url) => url.searchParams.get("userId") === "member-1" && url.searchParams.get("orgId") === "org")).toBe(true);
  });

  it("does not expose unread counts to guests or members without chat access", async () => {
    expect((await server.fetch(new Request("https://chat.test/api/chat/org/unread?guestToken=valid"), testEnv, {})).status).toBe(401);
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Crew" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: [] });
    expect((await server.fetch(new Request("https://chat.test/api/chat/org/unread"), testEnv, {})).status).toBe(401);
    expect(mocks.relay).not.toHaveBeenCalled();
  });
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
    expect(new URL(forwarded.url).pathname).toBe("/internal/guest-ws");
    expect(forwarded.headers.get("x-showpilot-internal-secret")).toBe(testEnv.BETTER_AUTH_SECRET);
    expect(params.get("userId")).toBeNull();
    expect(params.get("name")).toBe("Guest A");
    expect(params.get("role")).toBe("Guest");
    expect(params.get("guestExpiresAt")).toBe("4000000000000");
    expect(params.get("attachmentOwnerId")).toMatch(/^guest:[0-9a-f]{64}$/);
  });

  it("takes member identity from authentication and discards a forged guest lease", async () => {
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Authenticated Member" } });
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
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Authenticated Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.storageGet.mockResolvedValue({ customMetadata: { uploadedBy: "member-1", roomId: "production" } });
    mocks.relay.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await server.fetch(new Request("https://chat.test/api/chat-file/org/file-1/notes.txt", {
      method: "DELETE",
    }), testEnv, {});

    expect(response.status).toBe(204);
    expect(mocks.storageDelete).not.toHaveBeenCalled();
    const [target, options] = mocks.relay.mock.calls[0];
    expect(new URL(target).pathname).toBe("/internal/discard-attachment");
    expect(JSON.parse(options.body)).toEqual({ url: "/api/chat-file/org/file-1/notes.txt", ownerId: "member-1" });
    expect(options.headers["x-showpilot-internal-secret"]).toBe(testEnv.BETTER_AUTH_SECRET);
  });

  it("does not serve bytes after the room reserved deletion but storage cleanup is still pending", async () => {
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.storageGet.mockResolvedValue({ customMetadata: { uploadedBy: "member-1", roomId: "production" } });
    mocks.relay.mockResolvedValue(Response.json({ deleted: true }));
    const response = await server.fetch(new Request("https://chat.test/api/chat-file/org/draft/notes.txt"), testEnv, {});
    expect(response.status).toBe(404);
    expect(new URL(mocks.relay.mock.calls[0][0]).pathname).toBe("/internal/attachment-state");
  });

  it("does not expose upload reservation objects as chat attachments", async () => {
    const response = await server.fetch(new Request("https://chat.test/api/chat-file/org/_uploads/claim"), testEnv, {});
    expect(response.status).toBe(404); expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it("refuses to remove another member's attachment", async () => {
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Authenticated Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.storageGet.mockResolvedValue({ customMetadata: { uploadedBy: "member-2", roomId: "production" } });

    const response = await server.fetch(new Request("https://chat.test/api/chat-file/org/file-2/stage.png", {
      method: "DELETE",
    }), testEnv, {});

    expect(response.status).toBe(403);
    expect(mocks.relay).not.toHaveBeenCalled();
    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });
  it("routes cancellation with the authenticated actor and validated room, even before a file exists", async () => {
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.relay.mockResolvedValue(new Response(null, { status: 204 }));
    const spec = { uploadId: crypto.randomUUID(), name: "notes.txt", mimeType: "text/plain", size: 5, sha256: "a".repeat(64) };
    const response = await server.fetch(new Request("https://chat.test/api/chat/org/cancel-upload?room=planning&expectedUserId=member-1", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
    }), testEnv, {});
    expect(response.status).toBe(204);
    const [target, options] = mocks.relay.mock.calls[0];
    expect(new URL(target).pathname).toBe("/internal/cancel-upload");
    expect(new URL(target).searchParams.get("room")).toBe("planning");
    expect(JSON.parse(options.body)).toEqual({ spec, ownerId: "member-1" });
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it.each(["member-2", ""])("refuses cancellation without the original account identity (%s)", async expectedUserId => {
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    const response = await server.fetch(new Request(`https://chat.test/api/chat/org/cancel-upload?expectedUserId=${expectedUserId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), testEnv, {});
    expect(response.status).toBe(409); expect(mocks.relay).not.toHaveBeenCalled();
  });

  it("fails closed when chat authority is not configured", async () => {
    mocks.session.mockResolvedValue({ session: { id: "fixture-session", expiresAt: new Date("2099-01-01") }, user: { id: "member-1", name: "Member" } });
    mocks.access.mockResolvedValue({ role: "member", permissions: ["chat:access"] });
    mocks.storageGet.mockResolvedValue({ customMetadata: { uploadedBy: "member-1", roomId: "production" } });
    const response = await server.fetch(new Request("https://chat.test/api/chat-file/org/file-1/notes.txt", { method: "DELETE" }), { ...testEnv, BETTER_AUTH_SECRET: undefined }, {});
    expect(response.status).toBe(503); expect(mocks.relay).not.toHaveBeenCalled();
  });

});
