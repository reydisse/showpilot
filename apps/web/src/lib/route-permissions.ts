import { redirect } from "@tanstack/react-router";
import {
  hasAnyPermission,
  hasPermission,
  isLowerThirdPermission,
  roleRequiresRundownPin,
  type Permission,
} from "@/lib/app-permissions";
import { checkRoutePermission } from "@/lib/rbac";

export async function withPermission(
  role: string | null | undefined,
  permission: Permission | Permission[],
  slug: string,
  orgId: string,
): Promise<void> {
  const allowed = Array.isArray(permission)
    ? hasAnyPermission(role, permission)
    : hasPermission(role, permission);

  if (!allowed) {
    throw redirect({
      to: "/$slug/board",
      params: { slug },
    });
  }

  const permissions = Array.isArray(permission) ? permission : [permission];
  const needsServerPolicyCheck =
    permissions.some(isLowerThirdPermission) ||
    (roleRequiresRundownPin(role) &&
      permissions.some((entry) => entry === "rundown:view" || entry === "rundown:edit"));

  // Membership and role were already resolved by the parent organization
  // route. Most pages have no additional server-side policy, so another
  // auth + D1 round trip here only makes every navigation wait twice.
  if (!needsServerPolicyCheck) return;

  const result = await checkRoutePermission({
    data: {
      orgId,
      permission,
    },
  });

  if (result.ok) {
    return;
  }

  if (result.reason === "unauthorized") {
    throw redirect({ to: "/login" });
  }

  if (result.reason === "pin_required") {
    throw redirect({
      to: "/$slug/rundown-pin",
      params: { slug },
    });
  }

  // Feature flag off (cloud lower thirds), not a permission denial — send the
  // operator to an explainer with an enable path instead of a silent /board
  // bounce that's indistinguishable from "you're not allowed".
  if (result.reason === "feature_disabled") {
    throw redirect({
      to: "/$slug/streaming/lower-thirds-disabled",
      params: { slug },
    });
  }

  throw redirect({
    to: "/$slug/board",
    params: { slug },
  });
}
