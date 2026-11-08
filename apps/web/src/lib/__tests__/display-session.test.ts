import { beforeEach, describe, expect, it, vi } from "vitest";
import { displayCookieName, issueDisplayPass, DISPLAY_PASS_LIFETIME_MS } from "../display-access.server";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), cookie: vi.fn(), request: vi.fn(), secret: "display-session-fixture", lookup: vi.fn() }));
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
  DB: { prepare: () => ({ bind: () => ({ first: mocks.lookup }) }) },
} }));
vi.mock("../org-access", () => ({ assertOrgPermission: mocks.permission }));
import { createDisplayLink, ensureDisplaySession } from "../display-access";
beforeEach(() => {
  vi.resetAllMocks(); mocks.secret = "display-session-fixture"; mocks.lookup.mockResolvedValue({ id: "org-1" });
  mocks.request.mockReturnValue(new Request("https://app.example/_serverFn/fixture"));
  mocks.permission.mockResolvedValue({ user: { id: "owner" } });
});
describe("display session establishment", () => {
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
    expect(await ensureDisplaySession({ data: { orgSlug: "venue", surface: "overlay", token: issued.token } })).toEqual({ authorized: false, reason: "access-denied" });
    expect(mocks.cookie).not.toHaveBeenCalled();
  });
  it("does not create or share access without permission or a signing secret", async () => {
    mocks.permission.mockRejectedValue(new Error("Forbidden"));
    expect(await ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer" } })).toEqual({ authorized: false, reason: "access-denied" });
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


it("reports a missing organization without authenticating or creating a display pass", async () => {
  mocks.lookup.mockResolvedValue(null);
  const issued = await issueDisplayPass("org-1", "timer", mocks.secret);
  expect(await ensureDisplaySession({ data: { orgSlug: "missing", surface: "timer", token: issued.token } })).toEqual({ authorized: false, reason: "not-found" });
  expect(mocks.permission).not.toHaveBeenCalled();
  expect(mocks.cookie).not.toHaveBeenCalled();
  await expect(createDisplayLink({ data: { orgSlug: "missing", surface: "timer" } })).rejects.toThrow("Organization not found");
});
it("keeps lookup outages distinct from missing organizations", async () => {
  mocks.lookup.mockRejectedValue(new Error("Fixture database unavailable"));
  await expect(ensureDisplaySession({ data: { orgSlug: "venue", surface: "timer" } })).rejects.toThrow("Fixture database unavailable");
  expect(mocks.cookie).not.toHaveBeenCalled();
});
