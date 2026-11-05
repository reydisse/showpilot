/** For Worker-owned automation after its caller has verified the acting authority. */
export function rundownInternalRequest(url: string | URL, secret: string | undefined, init?: RequestInit): Request {
  if (!secret) throw new Error("Internal rundown authority is not configured.");
  const target = new URL(url);
  if (target.pathname !== "/command" && target.pathname !== "/state" && target.pathname !== "/activate") throw new Error("Unsupported internal rundown operation.");
  target.pathname = `/internal${target.pathname}`;
  const headers = new Headers(init?.headers);
  headers.set("x-showpilot-internal-secret", secret);
  return new Request(target, { ...init, headers });
}
