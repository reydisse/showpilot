import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { withPermission } from "../route-permissions";

const { checkRoutePermission } = vi.hoisted(() => ({ checkRoutePermission: vi.fn() }));
vi.mock("../rbac", () => ({ checkRoutePermission }));

beforeEach(() => { vi.clearAllMocks(); });

describe("Technical Manager rundown route challenge", () => {
  it.each(["rundown", "show"] as const)("returns a locked TM to %s after unlocking", async (returnTo) => {
    checkRoutePermission.mockResolvedValue({ ok: false, reason: "pin_required" });
    try {
      await withPermission("tm", "rundown:view", "test-org", "org-1", returnTo);
    } catch (error) {
      expect(isRedirect(error)).toBe(true);
      if (isRedirect(error)) expect(error.options).toMatchObject({
        to: "/$slug/rundown-pin", params: { slug: "test-org" }, search: { returnTo },
      });
      return;
    }
    throw new Error("Expected the PIN form redirect");
  });

  it("opens the route when the PIN is valid or no PIN is configured", async () => {
    checkRoutePermission.mockResolvedValue({ ok: true });
    await expect(withPermission("tm", "rundown:view", "test-org", "org-1")).resolves.toBeUndefined();
    expect(checkRoutePermission).toHaveBeenCalledWith({ data: { orgId: "org-1", permission: "rundown:view" } });
  });

  it("does not add a PIN challenge for administrators", async () => {
    await expect(withPermission("admin", "rundown:view", "test-org", "org-1")).resolves.toBeUndefined();
    expect(checkRoutePermission).not.toHaveBeenCalled();
  });
});
