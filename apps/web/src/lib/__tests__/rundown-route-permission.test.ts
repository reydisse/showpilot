import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { withPermission } from "../route-permissions";

const { checkRoutePermission } = vi.hoisted(() => ({ checkRoutePermission: vi.fn() }));
vi.mock("../rbac", () => ({ checkRoutePermission }));

beforeEach(() => { vi.clearAllMocks(); });

describe("Technical Manager rundown route challenge", () => {
  it("sends a locked TM to the Rundown PIN form", async () => {
    checkRoutePermission.mockResolvedValue({ ok: false, reason: "pin_required" });
    try {
      await withPermission("tm", "rundown:edit", "test-org", "org-1");
    } catch (error) {
      expect(isRedirect(error)).toBe(true);
      if (isRedirect(error)) expect(error.options).toMatchObject({
        to: "/$slug/rundown-pin", params: { slug: "test-org" },
      });
      return;
    }
    throw new Error("Expected the PIN form redirect");
  });

  it("opens the rundown without checking the PIN", async () => {
    checkRoutePermission.mockResolvedValue({ ok: true });
    await expect(withPermission("tm", "rundown:view", "test-org", "org-1")).resolves.toBeUndefined();
    expect(checkRoutePermission).not.toHaveBeenCalled();
  });

  it("does not add a PIN challenge for administrators", async () => {
    await expect(withPermission("admin", "rundown:view", "test-org", "org-1")).resolves.toBeUndefined();
    expect(checkRoutePermission).not.toHaveBeenCalled();
  });
});
