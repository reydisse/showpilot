// ─────────────────────────────────────────────────────────────
// Minimal client-side PostHog capture. The repo has no analytics
// client; this is a dependency-free wrapper over PostHog's capture
// endpoint. Without VITE_POSTHOG_KEY every call is a silent no-op,
// so production behavior never depends on analytics being configured.
// ─────────────────────────────────────────────────────────────

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const POSTHOG_KEY = env.VITE_POSTHOG_KEY;
const POSTHOG_HOST = env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";

let distinctId: string | null = null;

/** Associate subsequent events with a stable user id. */
export function identifyAnalytics(id: string | null | undefined) {
  if (id) distinctId = id;
}

/** Fire-and-forget event capture. Never throws, never blocks the UI. */
export function track(event: string, properties: Record<string, unknown> = {}) {
  if (!POSTHOG_KEY || typeof window === "undefined") return;
  try {
    const body = JSON.stringify({
      api_key: POSTHOG_KEY,
      event,
      distinct_id: distinctId ?? "anonymous",
      properties: { ...properties, $current_url: window.location.href },
      timestamp: new Date().toISOString(),
    });
    const url = `${POSTHOG_HOST}/capture/`;
    if (!navigator.sendBeacon?.(url, body)) {
      void fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch {
    // Analytics must never break the product.
  }
}
