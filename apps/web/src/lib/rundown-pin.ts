const RUNDOWN_PIN_COOKIE_PREFIX = "sp_rundown_pin_";

export const RUNDOWN_PIN_SETTING_KEY = "rundown-pin";

/** Client-safe cookie name shared by the unlock screen and server verifier. */
export function getRundownPinCookieName(orgId: string): string {
  return `${RUNDOWN_PIN_COOKIE_PREFIX}${orgId}`;
}
