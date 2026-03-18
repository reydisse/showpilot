/**
 * ShowPilot Push Notification Utilities
 *
 * Handles service worker registration, push subscription,
 * and notification permission management.
 */

/** Register the service worker if supported */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });

    // Wait for the service worker to be ready
    await navigator.serviceWorker.ready;
    return registration;
  } catch (err) {
    console.warn("[ShowPilot] Service worker registration failed:", err);
    return null;
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
