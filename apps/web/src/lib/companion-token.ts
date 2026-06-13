// Pure `cmp_`-prefixed companion token signing/verification. Dependency-free
// (delegates HMAC to kiosk-token.ts, Web Crypto only) so it is unit-testable
// without the Workers env or database. Consumed by companion.ts and
// companion-api.ts.

import { signToken, verifyToken } from "@/lib/kiosk-token";

/** All companion bearer tokens carry this prefix so they're distinguishable. */
export const COMPANION_TOKEN_PREFIX = "cmp_";

/** Sign a `cmp_`-prefixed companion token from a JWT payload. */
export async function signCompanionToken(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  return `${COMPANION_TOKEN_PREFIX}${await signToken(payload, secret)}`;
}

/**
 * Verify a `cmp_` bearer token: the prefix is mandatory (so a kiosk token can
 * never be replayed here), then HMAC signature + expiry are checked. Returns
 * the JWT payload, or null when invalid/expired/mis-prefixed.
 */
export async function verifyCompanionToken(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  if (!token.startsWith(COMPANION_TOKEN_PREFIX)) return null;
  const jwt = token.slice(COMPANION_TOKEN_PREFIX.length);
  return verifyToken(jwt, secret);
}
