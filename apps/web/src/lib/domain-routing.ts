export const APP_ORIGIN = "https://app.showpilot.tech";
export const LANDING_ORIGIN = "https://www.showpilot.tech";

/** Keep the old origin usable by installed apps, outputs and integrations. */
export function landingRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname !== "showpilot.tech" || url.pathname !== "/") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return null;
  // Desktop 0.1.3 and earlier only grant native capabilities to this origin.
  // Their main window must keep loading the app here, including at its root.
  if (/\bShowPilotDesktop\//i.test(request.headers.get("user-agent") ?? "")) return null;
  const target = new URL(LANDING_ORIGIN);
  target.search = url.search;
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.href,
      "Cache-Control": "private, no-store",
      Vary: "User-Agent",
    },
  });
}
