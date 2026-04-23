import {
  hasAnyPermission,
  hasPermission,
  isLowerThirdPermission,
  normalizeRole,
  roleRequiresRundownPin,
  type Permission,
  type Role,
} from "@/lib/permissions";

interface D1Statement {
  bind(...params: unknown[]): {
    first<T>(): Promise<T | null>;
  };
}

interface D1Database {
  prepare(sql: string): D1Statement;
}

interface PermissionEnv {
  DB: D1Database;
}

interface PermissionSession {
  userId: string;
  orgId: string;
}

export interface PermissionContext {
  request: Request;
  env: PermissionEnv;
  session: PermissionSession;
  params?: Record<string, string>;
  role?: Role;
}

export type PermissionHandler<T extends PermissionContext = PermissionContext> = (
  context: T,
) => Response | Promise<Response>;

interface OrgRoleRow {
  role: string;
}

interface CloudEnabledRow {
  cloud_enabled: number | null;
}

interface SettingRow {
  value: string | null;
}

const RUNDOWN_PIN_SETTING_KEY = "rundown-pin";
const RUNDOWN_PIN_HEADER = "x-showpilot-rundown-pin";
const RUNDOWN_PIN_COOKIE_PREFIX = "sp_rundown_pin_";

export function getRundownPinCookieName(orgId: string): string {
  return `${RUNDOWN_PIN_COOKIE_PREFIX}${orgId}`;
}

function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey !== name) continue;
    return decodeURIComponent(rawValue.join("="));
  }

  return null;
}

function forbidden(required: Permission | readonly Permission[]): Response {
  return Response.json(
    {
      error: "forbidden",
      required,
    },
    { status: 403 },
  );
}

function pinChallenge(): Response {
  return Response.json(
    {
      error: "pin_required",
      required: "rundown:pin_required",
      challenge: "rundown_pin",
    },
    { status: 401 },
  );
}

async function resolveRole(db: D1Database, userId: string, orgId: string): Promise<Role | null> {
  let orgMember: OrgRoleRow | null = null;
  try {
    orgMember = await db
      .prepare("SELECT role FROM org_member WHERE userId = ? AND orgId = ? LIMIT 1")
      .bind(userId, orgId)
      .first<OrgRoleRow>();
  } catch {
    // Older local databases may not have the additive org_member table yet.
    // Fall back to the legacy Better Auth member table instead of failing auth.
  }

  if (orgMember?.role) {
    return normalizeRole(orgMember.role);
  }

  const legacyMember = await db
    .prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ? LIMIT 1")
    .bind(userId, orgId)
    .first<OrgRoleRow>();

  return normalizeRole(legacyMember?.role ?? null);
}

async function isCloudEnabled(db: D1Database, orgId: string): Promise<boolean> {
  let row: CloudEnabledRow | null = null;
  try {
    row = await db
      .prepare("SELECT cloud_enabled FROM organization WHERE id = ? LIMIT 1")
      .bind(orgId)
      .first<CloudEnabledRow>();
  } catch {
    // Older local databases may not have the new cloud_enabled column yet.
    // Default to disabled rather than crashing route resolution.
    return false;
  }

  return row?.cloud_enabled === 1;
}

async function verifyRundownPin(request: Request, db: D1Database, orgId: string): Promise<boolean> {
  const configuredPin = await db
    .prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
    .bind(orgId, RUNDOWN_PIN_SETTING_KEY)
    .first<SettingRow>();

  const requiredPin = configuredPin?.value?.trim();
  if (!requiredPin) {
    return true;
  }

  const presentedPin = request.headers.get(RUNDOWN_PIN_HEADER)?.trim();
  if (presentedPin === requiredPin) {
    return true;
  }

  const cookiePin = getCookieValue(request, getRundownPinCookieName(orgId))?.trim();
  return cookiePin === requiredPin;
}

async function assertPermission(
  context: PermissionContext,
  required: Permission | readonly Permission[],
): Promise<Role | Response> {
  const role = await resolveRole(context.env.DB, context.session.userId, context.session.orgId);
  if (!role) {
    return forbidden(required);
  }

  const permissions = Array.isArray(required) ? required : [required];
  if (!hasAnyPermission(role, permissions)) {
    return forbidden(required);
  }

  if (permissions.some((permission) => isLowerThirdPermission(permission))) {
    const cloudEnabled = await isCloudEnabled(context.env.DB, context.session.orgId);
    if (!cloudEnabled) {
      return forbidden(required);
    }
  }

  if (
    permissions.some((permission) => permission === "rundown:view" || permission === "rundown:edit") &&
    roleRequiresRundownPin(role) &&
    hasPermission(role, "rundown:view") &&
    !(await verifyRundownPin(context.request, context.env.DB, context.session.orgId))
  ) {
    return pinChallenge();
  }

  return role;
}

export function withPermission<T extends PermissionContext>(
  required: Permission | readonly Permission[],
  handler: PermissionHandler<T>,
): PermissionHandler<T> {
  return async (context) => {
    const result = await assertPermission(context, required);
    if (result instanceof Response) {
      return result;
    }

    return handler({
      ...context,
      role: result,
    });
  };
}

export async function checkPermission(
  context: PermissionContext,
  required: Permission | readonly Permission[],
): Promise<Response | { role: Role }> {
  const result = await assertPermission(context, required);
  if (result instanceof Response) {
    return result;
  }
  return { role: result };
}
