import { getRequestHeaders } from "@tanstack/react-start/server";
import { getD1 } from "@/lib/d1";
import {
  accessHasAnyPermission,
  resolveEffectiveAccess,
  type EffectiveAccess,
} from "@/lib/effective-access";
import type { Permission } from "@/lib/permissions";

export interface RequestOrgAccess {
  user: { id: string; name: string; email: string };
  access: EffectiveAccess;
}

export async function getRequestOrgAccess(orgId: string): Promise<RequestOrgAccess> {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");

  const access = await resolveEffectiveAccess(getD1(), session.user.id, orgId);
  if (!access) throw new Error("Forbidden");

  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    },
    access,
  };
}

export async function assertOrgPermission(
  orgId: string,
  required: Permission | readonly Permission[],
): Promise<RequestOrgAccess> {
  const requestAccess = await getRequestOrgAccess(orgId);
  const permissions = Array.isArray(required) ? required : [required];
  if (!accessHasAnyPermission(requestAccess.access, permissions)) {
    throw new Error("Forbidden");
  }
  return requestAccess;
}
