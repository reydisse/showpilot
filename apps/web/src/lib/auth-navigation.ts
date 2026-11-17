// Auth redirects may carry app paths, never an external origin or an API action.
export function safeAuthReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return;
  // Fifty-recipient Planning passes can exceed a normal app path. Allow only
  // that bounded, query-free signed-link shape through the longer return path.
  if (value.length > 2048 && (value.length > 8192 || !/^\/join\/chat\/planning\/planning_chat_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))) return;
  try {
    const url = new URL(value, "https://auth-return.invalid");
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== "https://auth-return.invalid" || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) return;
    if (/^\/(?:api|_serverFn|login|verify-email|reset-password|forgot-password)(?:\/|$)/.test(path)) return;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return; }
}

export function safeSignupPlan(value: unknown): "starter" | "pro" | "founding" | undefined {
  return value === "starter" || value === "pro" || value === "founding" ? value : undefined;
}

export function withSignupPlan(destination: string, value: unknown): string {
  const plan = safeSignupPlan(value);
  if (!plan) return destination;
  const url = new URL(destination, "https://auth-return.invalid");
  url.searchParams.set("plan", plan);
  return url.pathname + url.search + url.hash;
}

export function verificationHref(returnTo?: string, value?: unknown): string {
  const destination = safeAuthReturnTo(returnTo);
  const plan = safeSignupPlan(value);
  const search = new URLSearchParams();
  if (destination) search.set("returnTo", destination);
  if (plan) search.set("plan", plan);
  return search.size ? `/verify-email?${search}` : "/verify-email";
}

// Email links always land on our status page, including after opening the link
// on another device. Preserve only a validated app destination from that page.
export function verificationEmailCallback(callback: string | null, baseURL: string): string {
  try {
    const url = new URL(callback ?? "/verify-email", baseURL);
    if (url.origin === new URL(baseURL).origin && url.pathname === "/verify-email") return verificationHref(safeAuthReturnTo(url.searchParams.get("returnTo")), url.searchParams.get("plan"));
  } catch { /* Invalid callback falls back to the verification page. */ }
  return "/verify-email";
}
