import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { authenticateDisplayRequest, displayCookieName, issueDisplayPass, DISPLAY_PASS_LIFETIME_MS } from "../display-access.server";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), cookie: vi.fn(), request: vi.fn(), secret: "display-session-fixture", org: "org-1" }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  let validate = (data: unknown) => data;
  const builder = {
    inputValidator: (validator: typeof validate) => { validate = validator; return builder; },
    handler: (handler: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => handler({ data: validate(input.data) }),
  }; return builder;
} }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.request, setCookie: mocks.cookie }));
vi.mock("cloudflare:workers", () => ({ env: {
  get KIOSK_SECRET() { return mocks.secret; },
  DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: mocks.org }) }) }) },
} }));
vi.mock("../org-access", () => ({ assertOrgPermission: mocks.permission }));
import { createDisplayLink, ensureDisplaySession } from "../display-access";
beforeEach(() => {
  vi.resetAllMocks(); mocks.secret = "display-session-fixture"; mocks.org = "org-1";
  mocks.request.mockReturnValue(new Request("https://app.example/_serverFn/fixture"));
  mocks.permission.mockResolvedValue({ user: { id: "owner" } });
});
describe("display session establishment", () => {
  it.each(["member", "shared", "renewal"])("keeps the %s cookie through the signed deadline without extending access", async mode => {
    const now = 1_800_000_000_250;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const old = await issueDisplayPass("org-1", "overlay", mocks.secret, now - DISPLAY_PASS_LIFETIME_MS + 35_000);
      if (mode === "shared") mocks.permission.mockRejectedValue(new Error("Unauthorized"));
      if (mode === "renewal") mocks.request.mockReturnValue(new Request("https://app.example/_serverFn/fixture", {
        headers: { cookie: `${displayCookieName("org-1", "overlay")}=${old.token}` },
      }));
      const result = await ensureDisplaySession({ data: { orgSlug: "venue", surface: "overlay", ...(mode === "shared" ? { token: old.token } : {}) } });
      if (!result.authorized) throw new Error("Valid display session was denied");
      expect(mocks.cookie).toHaveBeenCalledOnce();
      const token: unknown = mocks.cookie.mock.calls[0]?.[1];
      const maxAge: unknown = mocks.cookie.mock.calls[0]?.[2]?.maxAge;
      if (typeof token !== "string" || typeof maxAge !== "number") throw new Error("Display cookie was not set");
      expect(now + maxAge * 1000).toBeGreaterThanOrEqual(result.expiresAt);
      expect(now + maxAge * 1000).toBeLessThan(result.expiresAt + 1000);
      const request = new Request("https://app.example/api/overlay/venue", {
        headers: { cookie: `${displayCookieName("org-1", "overlay")}=${token}` },
      });
      expect(await authenticateDisplayRequest(env.DB, request, "org-1", "overlay", mocks.secret, result.expiresAt - 1)).toEqual({
        orgId: "org-1", surface: "overlay", expiresAt: result.expiresAt,
      });
      expect(await authenticateDisplayRequest(env.DB, request, "org-1", "overlay", mocks.secret, result.expiresAt)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
  it("creates an HttpOnly org-scoped cookie only after member authorization", async () => {
    const result = await ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer" } });
    expect(result.authorized).toBe(true);
    expect(mocks.permission).toHaveBeenCalledWith("org-1", ["show:view", "rundown:view", "timecode:access"]);
    expect(mocks.cookie).toHaveBeenCalledWith(displayCookieName("org-1", "timer"), expect.any(String), expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax", path: "/" }));
  });
  it("exchanges a valid shared pass without a member session and rejects a pass for another surface", async () => {
    mocks.permission.mockRejectedValue(new Error("Unauthorized"));
    const issued = await issueDisplayPass("org-1", "timer", mocks.secret);
    expect(await ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer", token: issued.token } })).toEqual({ authorized: true, expiresAt: issued.authority.expiresAt });
    expect(mocks.permission).not.toHaveBeenCalled();
    mocks.cookie.mockClear();
    expect(await ensureDisplaySession({ data: { orgSlug: "venue", surface: "overlay", token: issued.token } })).toEqual({ authorized: false });
    expect(mocks.cookie).not.toHaveBeenCalled();
  });
  it("does not create or share access without permission or a signing secret", async () => {
    mocks.permission.mockRejectedValue(new Error("Forbidden"));
    expect(await ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer" } })).toEqual({ authorized: false });
    await expect(createDisplayLink({ data: { orgSlug: "venue", surface: "timer" } })).rejects.toThrow("Forbidden");
    expect(mocks.cookie).not.toHaveBeenCalled();
    mocks.permission.mockResolvedValue({ user: { id: "owner" } }); mocks.secret = "";
    await expect(ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer" } })).rejects.toThrow("unavailable");
  });
  it("renews an expiring member display but does not extend anonymous shared access", async () => {
    const old = await issueDisplayPass("org-1", "timer", mocks.secret, Date.now() - DISPLAY_PASS_LIFETIME_MS + 30_000);
    mocks.request.mockReturnValue(new Request("https://app.example/_serverFn/fixture", { headers: { cookie: `${displayCookieName("org-1", "timer")}=${old.token}` } }));
    mocks.permission.mockRejectedValue(new Error("Unauthorized"));
    expect(await ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer" } })).toEqual({ authorized: true, expiresAt: old.authority.expiresAt });
    expect(mocks.cookie).not.toHaveBeenCalled();
    mocks.permission.mockResolvedValue({ user: { id: "owner" } });
    const renewed = await ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer" } });
    if (!renewed.authorized) throw new Error("Member renewal was denied");
    expect(renewed.expiresAt).toBeGreaterThan(old.authority.expiresAt);
    expect(mocks.cookie).toHaveBeenCalledOnce();
  });
});
