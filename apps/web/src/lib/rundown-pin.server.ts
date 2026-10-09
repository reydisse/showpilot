import { roleRequiresRundownPin, type Permission } from "./permissions";
import { getRundownPinCookieName, RUNDOWN_PIN_SETTING_KEY } from "./rundown-pin";
import { verifyStoredRundownPin } from "./rundown-pin-crypto";

export { getRundownPinCookieName, RUNDOWN_PIN_SETTING_KEY } from "./rundown-pin";

interface RundownPinStatement {
  bind(...params: unknown[]): {
    first<T>(): Promise<T | null>;
  };
}

export interface RundownPinDatabase {
  prepare(sql: string): RundownPinStatement;
}

interface SettingRow {
  value: string | null;
}

export const RUNDOWN_PIN_HEADER = "x-showpilot-rundown-pin";
function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const cookie of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return null;
    }
  }

  return null;
}

export function getPresentedRundownPin(request: Request, orgId: string): string | null {
  return request.headers.get(RUNDOWN_PIN_HEADER)?.trim()
    ?? getCookieValue(request, getRundownPinCookieName(orgId))?.trim()
    ?? null;
}

const WRITE_PERMISSIONS: readonly Permission[] = ["rundown:edit", "rundown:control"];

export interface RundownAccess {
  permissions: Permission[];
  pin: "unprotected" | "locked" | "unlocked";
}

// A configured PIN grants TMs editing and transport access for this request.
// Viewing never needs the PIN, and knowing it does not elevate other roles.
export async function resolveRundownAccess(
  db: RundownPinDatabase,
  orgId: string,
  access: { role: string; permissions: readonly Permission[] },
  presentedPin: string | null,
): Promise<RundownAccess> {
  if (!roleRequiresRundownPin(access.role)) {
    return { permissions: [...access.permissions], pin: "unprotected" };
  }
  const setting = await db
    .prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
    .bind(orgId, RUNDOWN_PIN_SETTING_KEY)
    .first<SettingRow>();
  if (!setting?.value?.trim()) {
    return { permissions: [...access.permissions], pin: "unprotected" };
  }
  const unlocked = await verifyStoredRundownPin(presentedPin, setting.value);
  return {
    permissions: unlocked
      ? [...new Set([...access.permissions, ...WRITE_PERMISSIONS])]
      : access.permissions.filter((permission) => !WRITE_PERMISSIONS.includes(permission)),
    pin: unlocked ? "unlocked" : "locked",
  };
}

export function rundownPermissionError(
  access: RundownAccess,
  required: Permission | readonly Permission[],
): "pin_required" | "forbidden" | null {
  const permissions = typeof required === "string" ? [required] : required;
  // Permission arrays are alternatives: a permitted read must stay readable.
  if (permissions.some((permission) => access.permissions.includes(permission))) return null;
  return access.pin === "locked" && permissions.some((permission) => WRITE_PERMISSIONS.includes(permission))
    ? "pin_required"
    : "forbidden";
}

export function rundownPinChallenge(): Response {
  return Response.json(
    {
      error: "pin_required",
      required: "rundown:pin_required",
      challenge: "rundown_pin",
    },
    { status: 401 },
  );
}
