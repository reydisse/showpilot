// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  access: vi.fn(),
  relay: vi.fn(),
}));

vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: mocks.session } }) }));
vi.mock("@/lib/effective-access", () => ({ resolveEffectiveAccess: mocks.access }));
vi.mock("@/lib/crew-chat-pass", () => ({ verifyCrewChatPass: vi.fn() }));
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
  DB: {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.startsWith("SELECT id FROM organization WHERE id = ?")) return { id: "org-1" };
          return null;
        },
        run: async () => ({ success: true }),
      }),
    }),
  },
  CUE_SHEET_RELAY: { idFromName: (name: string) => name, get: () => ({ fetch: mocks.relay }) },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "member-1", name: "Member" }, session: { id: "session-1" } });
  mocks.relay.mockResolvedValue(new Response("forwarded"));
});

describe("cue and incident live relay scopes", () => {
  it.each([
    [["cuesheet:view"], "observe"],
    [["cuesheet:add_notes"], "notes"],
    [["cuesheet:edit"], "columns,notes"],
    [["incidents:report"], "incidents"],
  ])("forwards %j with only its event scopes", async (permissions, expectedScope) => {
    mocks.access.mockResolvedValue({ role: "member", permissions, grantedPermissions: [] });
    const response = await server.fetch(new Request("https://showpilot.test/api/cue-sheet/org-1/ws"), testEnv, {});
    expect(response.status).toBe(200);
    const forwarded: Request = mocks.relay.mock.calls[0][0];
    expect(new URL(forwarded.url).searchParams.get("access")).toBe(expectedScope);
  });

  it("rejects members with no cue or incident authority", async () => {
    mocks.access.mockResolvedValue({ role: "member", permissions: ["show:view"], grantedPermissions: [] });
    const response = await server.fetch(new Request("https://showpilot.test/api/cue-sheet/org-1/ws"), testEnv, {});
    expect(response.status).toBe(401);
    expect(mocks.relay).not.toHaveBeenCalled();
  });
});
