import { normalizeRole, type Role } from "@/lib/permissions";

// Role resolution for org routes. The role MUST come from the membership row
// of the org in the URL — never from session.activeOrganizationId, which
// silently downgraded multi-org users (an owner browsing org A while org B
// was session-active resolved as "member" on A). See $slug.tsx beforeLoad.

interface MemberLookup {
  member: {
    findFirst(args: {
      where: { organizationId: string; userId: string };
      select: { role: true };
    }): Promise<{ role: string } | null>;
  };
}

/**
 * Resolve the caller's role in a specific org. Returns null for non-members
 * (caller redirects away). A lookup error propagates — it must surface as an
 * error, never as a quiet privilege downgrade.
 */
export async function resolveMemberRoleForOrg(
  db: MemberLookup,
  orgId: string,
  userId: string,
): Promise<Role | null> {
  const member = await db.member.findFirst({
    where: { organizationId: orgId, userId },
    select: { role: true },
  });
  return normalizeRole(member?.role ?? null);
}
