// Auth redirects may carry app paths, never an external origin or an API action.
export function safeAuthReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value, "https://auth-return.invalid");
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== "https://auth-return.invalid" || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) return;
    if (/^\/(?:api|_serverFn|login|verify-email|reset-password|forgot-password)(?:\/|$)/.test(path)) return;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return; }
}

export function verificationHref(returnTo?: string): string {
  const destination = safeAuthReturnTo(returnTo);
  return destination ? `/verify-email?${new URLSearchParams({ returnTo: destination })}` : "/verify-email";
}

// Email links always land on our status page, including after opening the link
// on another device. Preserve only a validated app destination from that page.
export function verificationEmailCallback(callback: string | null, baseURL: string): string {
  try {
    const url = new URL(callback ?? "/verify-email", baseURL);
    if (url.origin === new URL(baseURL).origin && url.pathname === "/verify-email") return verificationHref(safeAuthReturnTo(url.searchParams.get("returnTo")));
  } catch { /* Invalid callback falls back to the verification page. */ }
  return "/verify-email";
}
