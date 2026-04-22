import { redirect } from "@tanstack/react-router";
import {
  hasAnyPermission,
  hasPermission,
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

  throw redirect({
    to: "/$slug/board",
    params: { slug },
  });
}
