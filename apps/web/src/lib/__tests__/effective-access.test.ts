import { describe, expect, it } from "vitest";
import {
  addAccessDays,
  parseGrantedPermissions,
  resolveAccessGrantAuthority,
  resolveEffectiveAccess,
  weekStartForAccess,
  type AccessDatabase,
} from "@/lib/effective-access";

function accessDb(options: {
  role?: string | null;
  timezone?: string;
  grantSets?: string[];
  revision?: string;
  onDuty?: boolean;
}): AccessDatabase {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>() {
              if (sql.includes("FROM member WHERE")) {
                return (options.role ? { role: options.role } : null) as T | null;
              }
              if (sql.includes("FROM app_setting")) {
                return ({ value: options.timezone ?? "UTC" }) as T;
              }
              if (sql.includes("FROM member_permission_grant")) {
                return {
                  grantSets: JSON.stringify(options.grantSets ?? []),
                  revision: options.revision ?? "",
                } as T;
              }
              if (sql.includes("FROM roster_assignment")) {
                return (options.onDuty ? { id: "duty-1" } : null) as T | null;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

describe("effective access", () => {
  it("merges validated grant permissions with base-role permissions", async () => {
    const access = await resolveEffectiveAccess(
      accessDb({
        role: "member",
        grantSets: [
          JSON.stringify(["rundown:edit", "rundown:control", "org:delete", "not-real"]),
        ],
        revision: "2026-08-21 12:00:00",
      }),
      "user-1",
      "org-1",
      "2026-08-21",
    );

    expect(access?.role).toBe("member");
    expect(access?.grantedPermissions).toEqual(["rundown:edit", "rundown:control"]);
    expect(access?.permissions).toContain("show:view");
    expect(access?.permissions).toContain("rundown:control");
    expect(access?.revision).toBe("2026-08-21 12:00:00");
  });

  it("rejects malformed and unknown serialized permissions", () => {
    expect(parseGrantedPermissions("not-json")).toEqual([]);
    expect(parseGrantedPermissions(JSON.stringify({ permission: "rundown:edit" }))).toEqual([]);
    expect(parseGrantedPermissions(JSON.stringify(["rundown:edit", "unknown"]))).toEqual([
      "rundown:edit",
    ]);
  });

  it("returns no access for a non-member", async () => {
    await expect(
      resolveEffectiveAccess(accessDb({ role: null }), "outsider", "org-1", "2026-08-21"),
    ).resolves.toBeNull();
  });
});

describe("weekly access authority", () => {
  it("uses the same Sunday-to-Saturday week as the duty roster", () => {
    expect(weekStartForAccess("2026-08-21")).toBe("2026-08-16");
    expect(addAccessDays("2026-08-16", 7)).toBe("2026-08-23");
  });

  it.each(["owner", "admin"])("gives %s permanent authority", async (role) => {
    const authority = await resolveAccessGrantAuthority(
      accessDb({ role }),
      "user-1",
      "org-1",
      "2026-08-21",
    );
    expect(authority).toMatchObject({
      canManage: true,
      kind: "permanent",
      weekStart: "2026-08-16",
      weekEndExclusive: "2026-08-23",
    });
  });

  it("gives the person assigned to the TM slot authority for that week", async () => {
    const authority = await resolveAccessGrantAuthority(
      accessDb({ role: "member", onDuty: true }),
      "user-1",
      "org-1",
      "2026-08-21",
    );
    expect(authority.kind).toBe("on-duty-tm");
    expect(authority.canManage).toBe(true);
  });

  it("does not give an off-duty TM grant authority", async () => {
    const authority = await resolveAccessGrantAuthority(
      accessDb({ role: "tm", onDuty: false }),
      "user-1",
      "org-1",
      "2026-08-21",
    );
    expect(authority).toMatchObject({ canManage: false, kind: "none" });
  });

  it("does not treat director-tier roles as permanent Owners/Admins", async () => {
    const authority = await resolveAccessGrantAuthority(
      accessDb({ role: "td" }),
      "user-1",
      "org-1",
      "2026-08-21",
    );
    expect(authority).toMatchObject({ canManage: false, kind: "none" });
  });
});
