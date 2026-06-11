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

export async function verifyToken(
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
    const payload = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/"))
    );
    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    // Malformed base64 / JSON / crypto input → treat as an invalid token.
    return null;
  }
}
