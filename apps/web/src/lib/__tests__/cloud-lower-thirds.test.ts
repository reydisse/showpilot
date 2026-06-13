import { describe, it, expect } from "vitest";
import { checkPermission } from "@/middleware/withPermission";
import { isAdminTier } from "@/lib/permissions";

// Minimal D1 stub that answers the two queries the permission middleware makes
// for lower-thirds routes: the caller's org_member role and the org's
// cloud_enabled flag. No rundown PIN is configured.
function makeDb({
  role,
  cloudEnabled,
}: {
  role: string | null;
  cloudEnabled: boolean;
}) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.includes("FROM org_member") || sql.includes("FROM member")) {
                return (role ? { role } : null) as T | null;
              }
              if (sql.includes("cloud_enabled")) {
                return { cloud_enabled: cloudEnabled ? 1 : 0 } as T;
              }
              // app_setting (rundown pin) and anything else: no row.
              return null;
            },
          };
        },
      };
    },
  };
}

function context(role: string | null, cloudEnabled: boolean) {
  return {
    request: new Request("https://showpilot.local/test"),
    env: { DB: makeDb({ role, cloudEnabled }) },
    session: { userId: "user-1", orgId: "org-1" },
  };
}

describe("cloud lower thirds gating (withPermission)", () => {
  it("role HAS permission + flag OFF → feature_disabled (423), not forbidden", async () => {
    // tm holds lowerthird:view/trigger/configure
    const result = await checkPermission(context("tm", false), "lowerthird:trigger");
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(423);
    const body = (await res.json()) as { error: string; feature?: string };
    expect(body.error).toBe("feature_disabled");
    expect(body.feature).toBe("cloud_lower_thirds");
  });

  it("role LACKS permission → forbidden (403) regardless of flag", async () => {
    // member has no lowerthird:* permissions
    for (const cloud of [false, true]) {
      const result = await checkPermission(context("member", cloud), "lowerthird:trigger");
      expect(result).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("forbidden");
    }
  });

  it("role HAS permission + flag ON → allowed (resolves role)", async () => {
    const result = await checkPermission(context("tm", true), "lowerthird:trigger");
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual({ role: "tm" });
  });

  it("non-lower-thirds permission is unaffected by the flag", async () => {
    const result = await checkPermission(context("member", false), "show:view");
    expect(result).toEqual({ role: "member" });
  });
});

describe("isAdminTier (cloud lower thirds toggle gating)", () => {
  it.each(["owner", "admin", "td", "cd", "pd"])("%s can manage", (role) => {
    expect(isAdminTier(role)).toBe(true);
  });

  it.each(["pm", "tm", "sm", "member", "stageManager", null, undefined, "bogus"])(
    "%s cannot manage",
    (role) => {
      expect(isAdminTier(role)).toBe(false);
    },
  );
});
