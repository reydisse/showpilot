import { redirect } from "@tanstack/react-router";

export {
  ASSIGNABLE_ROLES,
  ROLE_META,
  ROLE_PERMISSIONS,
  getPermissions,
  hasAnyPermission,
  hasPermission,
  isAdminTier,
  isLowerThirdPermission,
  normalizeRole,
  roleRequiresRundownPin,
} from "./permissions";
export type { Permission, Role } from "./permissions";

import { hasAnyPermission, hasPermission, type Permission } from "./permissions";

export function withPermission(
  role: string | null | undefined,
  permission: Permission | Permission[],
  slug: string,
): void {
  const allowed = Array.isArray(permission)
    ? hasAnyPermission(role, permission)
    : hasPermission(role, permission);

  if (!allowed) {
    throw redirect({
      to: "/$slug/board",
      params: { slug },
    });
  }
}
