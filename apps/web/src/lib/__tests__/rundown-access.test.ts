import { describe, expect, it } from "vitest";
import { resolveRundownAccess, rundownPermissionError } from "../rundown-pin.server";
import { hashRundownPin } from "../rundown-pin-crypto";
import type { Permission } from "../permissions";

const tm = { role: "tm", permissions: ["show:view", "rundown:view"] satisfies Permission[] };
function database(pin: string | null) {
  return { prepare: () => ({ bind: (orgId: unknown) => ({ first: async <T>() =>
    (orgId === "org-1" && pin ? { value: pin } : null) as T | null,
  }) }) };
}

describe("TM PIN grants editing and live controls", () => {
  it.each([null, "0000"])("leaves reading open with PIN %s", async (pin) => {
    const access = await resolveRundownAccess(database("2468"), "org-1", tm, pin);
    expect(rundownPermissionError(access, "rundown:view")).toBeNull();
    expect(rundownPermissionError(access, ["rundown:view", "rundown:control"])).toBeNull();
    expect(rundownPermissionError(access, "rundown:edit")).toBe("pin_required");
    expect(rundownPermissionError(access, "rundown:control")).toBe("pin_required");
  });

  it("unlocks both actions with a hashed PIN, without granting show creation", async () => {
    const access = await resolveRundownAccess(database(await hashRundownPin("2468")), "org-1", tm, "2468");
    expect(access.pin).toBe("unlocked");
    expect(rundownPermissionError(access, "rundown:edit")).toBeNull();
    expect(rundownPermissionError(access, "rundown:control")).toBeNull();
    expect(rundownPermissionError(access, "schedule:manage")).toBe("forbidden");
  });

  it.each([null, "   "])("does not grant extra permissions when the PIN is empty (%s)", async (pin) => {
    const access = await resolveRundownAccess(database(pin), "org-1", tm, "2468");
    expect(access).toEqual({ pin: "unprotected", permissions: tm.permissions });
    expect(rundownPermissionError(access, "rundown:control")).toBe("forbidden");
  });

  it("does not use another organization's PIN or elevate other roles", async () => {
    const db = database("2468");
    expect((await resolveRundownAccess(db, "org-2", tm, "2468")).permissions).toEqual(tm.permissions);
    const member = await resolveRundownAccess(db, "org-1", { ...tm, role: "member" }, "2468");
    expect(rundownPermissionError(member, "rundown:edit")).toBe("forbidden");
  });

  it("requires the configured PIN even when a TM has a write grant", async () => {
    const access = { ...tm, permissions: [...tm.permissions, "rundown:edit"] satisfies Permission[] };
    expect(rundownPermissionError(await resolveRundownAccess(database("2468"), "org-1", access, null), "rundown:edit")).toBe("pin_required");
    expect(rundownPermissionError(await resolveRundownAccess(database(null), "org-1", access, null), "rundown:edit")).toBeNull();
  });
});
