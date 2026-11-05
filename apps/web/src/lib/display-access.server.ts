import { signToken, verifyToken } from "./kiosk-token";

export type DisplaySurface = "timer" | "overlay";
export interface DisplayAuthority { orgId: string; surface: DisplaySurface; expiresAt: number }
export const DISPLAY_PASS_LIFETIME_MS = 8 * 60 * 60_000;
const purpose = "showpilot-display-v1";

export function displayCookieName(orgId: string, surface: DisplaySurface): string {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(orgId)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `sp_display_${surface}_${encoded}`;
}

export async function issueDisplayPass(orgId: string, surface: DisplaySurface, secret: string, now = Date.now()) {
  if (!secret) throw new Error("Display access is unavailable.");
  const iat = Math.floor(now / 1000);
  const exp = iat + DISPLAY_PASS_LIFETIME_MS / 1000;
  const token = await signToken({ purpose, orgId, surface, iat, exp, nonce: crypto.randomUUID() }, secret);
  return { token, authority: { orgId, surface, expiresAt: exp * 1000 } };
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const entry = part.trim();
    if (entry.startsWith(`${name}=`)) {
      try { return decodeURIComponent(entry.slice(name.length + 1)); } catch { return null; }
    }
  }
  return null;
}

/** A display credential never grants a member claim or a write permission. */
export async function authenticateDisplayRequest(
  db: D1Database, request: Request, orgId: string, surface: DisplaySurface, secret: string | undefined,
  now = Date.now(),
): Promise<DisplayAuthority | null> {
  if (!secret) return null;
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const token = request.headers.get("x-showpilot-display-pass")
    ?? url.searchParams.get("displayPass") ?? url.searchParams.get("kioskToken")
    ?? bearer ?? cookieValue(request, displayCookieName(orgId, surface));
  if (!token || token.length > 4096) return null;
  const payload = await verifyToken(token, secret);
  if (!payload || payload.orgId !== orgId) return null;
  if (payload.purpose === purpose) {
    if (payload.surface !== surface || typeof payload.exp !== "number" || typeof payload.iat !== "number"
      || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
      || payload.iat * 1000 > now || payload.exp * 1000 <= now
      || payload.exp <= payload.iat || (payload.exp - payload.iat) * 1000 > DISPLAY_PASS_LIFETIME_MS) return null;
    return { orgId, surface, expiresAt: payload.exp * 1000 };
  }
  // Existing kiosk tokens are signed, view-scoped, and revocable in D1.
  if (payload.purpose !== undefined || payload.view !== surface) return null;
  if (payload.exp !== undefined && (typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= now)) return null;
  const row = await db.prepare("SELECT view, expiresAt, revokedAt FROM kiosk_token WHERE orgId = ? AND token = ?")
    .bind(orgId, token).first<{ view: string; expiresAt: string | number | null; revokedAt: unknown }>();
  if (!row || row.view !== surface || row.revokedAt !== null) return null;
  const rowExpiry = row.expiresAt === null ? Infinity : typeof row.expiresAt === "number" ? row.expiresAt : Date.parse(row.expiresAt);
  if (!(rowExpiry > now)) return null;
  return { orgId, surface, expiresAt: Math.min(now + DISPLAY_PASS_LIFETIME_MS, rowExpiry, typeof payload.exp === "number" ? payload.exp * 1000 : Infinity) };
}

export async function requireDisplayAccess(db: D1Database, request: Request, orgId: string, surface: DisplaySurface, secret: string | undefined) {
  const authority = await authenticateDisplayRequest(db, request, orgId, surface, secret);
  if (!authority) throw new Error("A valid display pass is required.");
  return authority;
}

/** Socket attachments carry only the deadline supplied by the Worker, never a pass. */
export function displaySocketMayReceive(ws: WebSocket, now = Date.now()): boolean {
  const attachment: unknown = ws.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object" || !("displayExpiresAt" in attachment) || attachment.displayExpiresAt === undefined) return true;
  if (typeof attachment.displayExpiresAt === "number" && Number.isFinite(attachment.displayExpiresAt) && attachment.displayExpiresAt > now) return true;
  try { ws.close(4403, "Display pass expired"); } catch { /* The socket may already be closed. */ }
  return false;
}
