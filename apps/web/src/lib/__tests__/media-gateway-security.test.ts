// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  access: vi.fn(),
  media: vi.fn(),
  tombstoned: false,
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.session } }),
}));
vi.mock("@/lib/effective-access", () => ({
  resolveEffectiveAccess: mocks.access,
}));
vi.mock("@/lib/mobile-api.server", () => ({
  handleMobileApi: async () => null,
}));
vi.mock("@/lib/media-library.server", () => ({
  handleMediaRequest: mocks.media,
}));
vi.mock("@/durable-objects/ChatRelay", () => ({ ChatRelay: class {} }));
vi.mock("@/durable-objects/RundownRelay", () => ({ RundownRelay: class {} }));
vi.mock("@/durable-objects/TimecodeRelay", () => ({ TimecodeRelay: class {} }));
vi.mock("@/durable-objects/BridgeRelay", () => ({ BridgeRelay: class {} }));
vi.mock("@/durable-objects/LowerThirdsRelay", () => ({
  LowerThirdsRelay: class {},
}));
vi.mock("@/durable-objects/CueSheetRelay", () => ({ CueSheetRelay: class {} }));
import server from "../../server";

const testEnv = {
  DB: {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.startsWith("SELECT id FROM organization WHERE id = ?"))
            return { id: "canonical-org" };
          if (sql.includes("organization-deleting"))
            return mocks.tombstoned ? { value: "deleting" } : null;
          return null;
        },
      }),
    }),
  },
  STORAGE: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tombstoned = false;
  mocks.session.mockResolvedValue(null);
  mocks.access.mockResolvedValue(null);
  mocks.media.mockImplementation(
    async (_request: Request, options: { authorize: () => Promise<boolean> }) =>
      new Response("checked", {
        status: (await options.authorize()) ? 200 : 403,
      }),
  );
});
const call = (method = "GET", headers = {}) =>
  server.fetch(
    new Request(
      "https://app.showpilot.tech/api/media/org-slug/9cdf0f6e-f034-4224-aa2e-503527858686?orgId=forged&guestToken=forged",
      { method, headers },
    ),
    testEnv,
    {},
  );

it("does not grant media access from guest/display tokens or a forged organization", async () => {
  expect((await call()).status).toBe(403);
  expect(mocks.media.mock.calls[0][1].orgId).toBe("canonical-org");
});
it("requires timecode permission and checks fresh authority for every media request", async () => {
  mocks.session.mockResolvedValue({
    session: { id: "session", expiresAt: new Date("2099-01-01") },
    user: { id: "user", name: "Operator" },
  });
  mocks.access.mockResolvedValue({
    role: "member",
    permissions: ["chat:access"],
  });
  expect((await call()).status).toBe(403);
  mocks.access.mockResolvedValue({
    role: "owner",
    permissions: ["timecode:access"],
  });
  expect((await call("HEAD")).status).toBe(200);
  const authorize = mocks.media.mock.calls[1][1].authorize;
  mocks.access.mockResolvedValue({ role: "member", permissions: [] });
  expect(await authorize()).toBe(false);
  expect((await call()).status).toBe(403);
});
it.each(["PUT", "DELETE"])(
  "requires a trusted Origin before %s reaches storage",
  async (method) => {
    for (const origin of [
      undefined,
      "null",
      "https://evil.example",
      "http://192.168.1.5",
    ]) {
      expect(
        (await call(method, origin ? { Origin: origin } : {})).status,
      ).toBe(403);
    }
    expect(mocks.media).not.toHaveBeenCalled();
    await call(method, { Origin: "https://app.showpilot.tech" });
    expect(mocks.media).toHaveBeenCalledTimes(1);
  },
);
it("blocks tombstoned organizations before storage and during the post-upload recheck", async () => {
  mocks.session.mockResolvedValue({
    session: { id: "session", expiresAt: new Date("2099-01-01") },
    user: { id: "user", name: "Operator" },
  });
  mocks.access.mockResolvedValue({
    role: "owner",
    permissions: ["timecode:access"],
  });
  expect((await call()).status).toBe(200);
  const authorize = mocks.media.mock.calls[0][1].authorize;
  mocks.tombstoned = true;
  expect(await authorize()).toBe(false);
  expect((await call()).status).toBe(404);
  expect(mocks.media).toHaveBeenCalledTimes(1);
});
