import { describe, it, expect } from "vitest";
import { resolveMemberRoleForOrg } from "../org-role";

// Regression tests for the multi-org role bug: role used to resolve from
// session.activeOrganizationId (with a silent "member" fallback), so an owner
// who created a second org lost owner permissions on their first org. Role
// must resolve from the URL's org, per membership row, with no fallback.

interface MemberRow {
  organizationId: string;
  userId: string;
  role: string;
}

function fakeDb(rows: MemberRow[]) {
  return {
    member: {
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string; userId: string };
        select: { role: true };
      }) => {
        const row = rows.find(
          (r) => r.organizationId === where.organizationId && r.userId === where.userId,
        );
        return row ? { role: row.role } : null;
      },
    },
  };
}

const USER = "user_1";
const ORG_A = "org_a";
const ORG_B = "org_b";

describe("resolveMemberRoleForOrg — role comes from the URL's org", () => {
  it("owner of org A who just created org B retains owner role when browsing A", async () => {
    // Creating org B made it the session-active org; that must not matter —
    // resolution takes the browsed org's id explicitly.
    const db = fakeDb([
      { organizationId: ORG_A, userId: USER, role: "owner" },
      { organizationId: ORG_B, userId: USER, role: "owner" },
    ]);
    expect(await resolveMemberRoleForOrg(db, ORG_A, USER)).toBe("owner");
    expect(await resolveMemberRoleForOrg(db, ORG_B, USER)).toBe("owner");
  });

  it("resolves per org, not per user: different roles in different orgs", async () => {
    const db = fakeDb([
      { organizationId: ORG_A, userId: USER, role: "owner" },
      { organizationId: ORG_B, userId: USER, role: "sm" },
    ]);
    expect(await resolveMemberRoleForOrg(db, ORG_A, USER)).toBe("owner");
    expect(await resolveMemberRoleForOrg(db, ORG_B, USER)).toBe("sm");
  });

  it("non-member resolves no role (null) — caller redirects, no member fallback", async () => {
    const db = fakeDb([{ organizationId: ORG_B, userId: USER, role: "owner" }]);
    expect(await resolveMemberRoleForOrg(db, ORG_A, USER)).toBeNull();
  });

  it("an unknown stored role resolves to null, not a quiet downgrade", async () => {
    const db = fakeDb([{ organizationId: ORG_A, userId: USER, role: "superuser" }]);
    expect(await resolveMemberRoleForOrg(db, ORG_A, USER)).toBeNull();
  });

  it("normalizes legacy role names from the membership row", async () => {
    const db = fakeDb([{ organizationId: ORG_A, userId: USER, role: "stageManager" }]);
    expect(await resolveMemberRoleForOrg(db, ORG_A, USER)).toBe("sm");
  });

  it("a lookup error propagates — it never falls back to a role", async () => {
    const db = {
      member: {
        findFirst: async () => {
          throw new Error("db unavailable");
        },
      },
    };
    await expect(resolveMemberRoleForOrg(db, ORG_A, USER)).rejects.toThrow("db unavailable");
  });
});
