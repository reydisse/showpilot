import { sha256 } from "@noble/hashes/sha2.js";
import { THEME_BOOTSTRAP } from "./theme-bootstrap";
export const THEME_HASH = btoa(String.fromCharCode(...sha256(new TextEncoder().encode(THEME_BOOTSTRAP))));
const posthogOrigin = new URL(import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com").origin;
const contentSecurityPolicy = (nonce: string) => [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  `script-src 'self' 'nonce-${nonce}' 'sha256-${THEME_HASH}' https://js.stripe.com https://static.cloudflareinsights.com`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' ${posthogOrigin} https://api.stripe.com https://m.stripe.network https://cloudflareinsights.com ws:`,
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
  "worker-src 'self' blob:",
].join("; ");

export function withSecurityHeaders(request: Request, response: Response, nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))): Response {
  const upgraded = response as Response & { webSocket?: unknown };
  if (response.status === 101 || upgraded.webSocket) return response;

  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  const url = new URL(request.url);
  headers.set("Referrer-Policy", /^\/(timer|overlay|api\/overlay)\//.test(url.pathname) ? "no-referrer" : "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("X-Permitted-Cross-Domain-Policies", "none");
  if (new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
