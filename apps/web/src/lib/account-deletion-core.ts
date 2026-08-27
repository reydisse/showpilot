export interface AccountMembershipForDeletion {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  role: string;
  otherMemberRoles: string[];
}
export interface AccountDeletionOwnershipBlocker {
  id: string;
  name: string;
  slug: string;
}

export function hasOrganizationRole(role: string, expectedRole: string): boolean {
  return role
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(expectedRole.toLowerCase());
}

export function findAccountDeletionOwnershipBlockers(
  memberships: AccountMembershipForDeletion[],
): AccountDeletionOwnershipBlocker[] {
  return memberships.flatMap((membership) => {
    if (!hasOrganizationRole(membership.role, "owner")) return [];
    if (membership.otherMemberRoles.some((role) => hasOrganizationRole(role, "owner"))) {
      return [];
    }
    return [membership.organization];
  });
}
