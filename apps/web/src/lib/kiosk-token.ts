// Pure HMAC-SHA256 token signing/verification for kiosk display tokens.
// Kept dependency-free (Web Crypto only) so it is unit-testable without
// the Workers env or database. Consumed by kiosk.ts and kiosk-api.ts.

export async function signToken(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const data = `${header}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${signature}`;
}

/** Authenticates bytes only. Callers must validate their own scope and expiry. */
export async function verifyTokenSignature(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const data = `${header}.${body}`;
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = Uint8Array.from(
      atob(signature.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(data));
    if (!valid) return null;
    const payload: unknown = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/"))
    );
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    return Object.fromEntries(Object.entries(payload));
  } catch {
    // Malformed base64 / JSON / crypto input → treat as an invalid token.
    return null;
  }
}

/** Existing kiosk callers retain their expiry policy; chat passes validate mandatory claims separately. */
export async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const payload = await verifyTokenSignature(token, secret);
  if (!payload || (payload.exp && Date.now() / 1000 > Number(payload.exp))) return null;
  return payload;
}
