/**
 * ShowPilot Push Notification Utilities
 *
 * Handles service worker registration, push subscription,
 * and notification permission management.
 */

/** Remove any existing service worker and cached assets. */
export async function clearServiceWorkerState(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // Existing SW cache has been causing stale HTML to be served for JS assets.
    // Unregister any prior workers and clear caches so the app can hydrate cleanly.
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((reg) => reg.unregister()));
    }

    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (err) {
    console.warn("[ShowPilot] Service worker cleanup failed:", err);
  }
}

/** Request notification permission and return the result */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "denied";
  }

  if (Notification.permission === "granted") {
    return "granted";
  }

  if (Notification.permission === "denied") {
    return "denied";
  }

  const result = await Notification.requestPermission();
  return result;
}

/**
 * Subscribe to push notifications.
 * Returns the PushSubscription object which should be sent to the server.
 *
 * Note: VAPID public key should come from server/env.
 * For now we store it as an app setting that can be configured in settings.
 */
export async function subscribeToPush(
  registration: ServiceWorkerRegistration,
  vapidPublicKey?: string
): Promise<PushSubscription | null> {
  if (!vapidPublicKey) {
    console.warn("[ShowPilot] No VAPID public key configured — push subscription skipped");
    return null;
  }

  try {
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    });

    return subscription;
  } catch (err) {
    console.warn("[ShowPilot] Push subscription failed:", err);
    return null;
  }
}

/** Check if push notifications are supported and permission is granted */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Show a local notification (when the app is in the foreground) */
export function showLocalNotification(
  title: string,
  body: string,
  options?: { type?: string; url?: string }
) {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }

  const registration = navigator.serviceWorker?.controller;
  if (!registration) {
    // Fallback to basic Notification API
    new Notification(title, {
      body,
      icon: "/logo192.png",
      tag: options?.type || "default",
    });
    return;
  }

  // Use service worker to show notification (works when backgrounded)
  navigator.serviceWorker.ready.then((reg) => {
    reg.showNotification(title, {
      body,
      icon: "/logo192.png",
      badge: "/logo192.png",
      tag: options?.type || "default",
      data: { url: options?.url || "/", type: options?.type },
    } as NotificationOptions);
  });
}

// ─── Helpers ───────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
