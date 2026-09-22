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

export function permissionsRequireRundownPin(
  role: string | null | undefined,
  permissions: Permission | readonly Permission[],
): boolean {
  const required = Array.isArray(permissions) ? permissions : [permissions];
  return roleRequiresRundownPin(role)
    && required.some((permission) =>
      permission === "rundown:view"
      || permission === "rundown:edit"
      || permission === "rundown:control");
}

export async function verifyRundownPin(
  request: Request,
  db: RundownPinDatabase,
  orgId: string,
): Promise<boolean> {
  const configuredPin = await db
    .prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1")
    .bind(orgId, RUNDOWN_PIN_SETTING_KEY)
    .first<SettingRow>();

  const presentedPin = getPresentedRundownPin(request, orgId);
  return verifyStoredRundownPin(presentedPin, configuredPin?.value);
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
