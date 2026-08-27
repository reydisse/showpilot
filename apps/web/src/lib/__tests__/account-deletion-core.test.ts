import { describe, expect, it } from "vitest";
import {
  findAccountDeletionOwnershipBlockers,
  hasOrganizationRole,
  type AccountMembershipForDeletion,
} from "@/lib/account-deletion-core";

function membership(
  role: string,
  otherMemberRoles: string[],
  id = "org-1",
): AccountMembershipForDeletion {
  return {
    role,
    otherMemberRoles,
    organization: { id, name: `Organization ${id}`, slug: id },
  };
}

describe("account deletion ownership policy", () => {
  it("recognizes roles in Better Auth comma-separated role values", () => {
    expect(hasOrganizationRole("admin, owner", "owner")).toBe(true);
    expect(hasOrganizationRole("admin", "owner")).toBe(false);
  });

  it("does not block members who do not own the organization", () => {
    expect(findAccountDeletionOwnershipBlockers([membership("admin", [])])).toEqual([]);
  });

  it("blocks the last owner", () => {
    expect(findAccountDeletionOwnershipBlockers([membership("owner", ["admin", "member"])])).toEqual([
      { id: "org-1", name: "Organization org-1", slug: "org-1" },
    ]);
  });

  it("allows an owner to leave when another owner remains", () => {
    expect(findAccountDeletionOwnershipBlockers([membership("owner", ["owner", "admin"])])).toEqual([]);
  });

  it("returns every workspace that still needs an owner", () => {
    expect(findAccountDeletionOwnershipBlockers([
      membership("owner", [], "org-a"),
      membership("owner", ["owner"], "org-b"),
      membership("owner,admin", ["member"], "org-c"),
    ]).map((blocker) => blocker.id)).toEqual(["org-a", "org-c"]);
  });
});
