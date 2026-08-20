/**
 * ShowPilot Push Notification Utilities
 *
 * Handles service worker registration, push subscription,
 * and notification permission management.
 */

import {
  getDesktopNotificationPermission,
  isDesktopNotificationSupported,
  requestDesktopNotificationPermission,
  showDesktopNotification,
} from "@/lib/desktop-runtime";

/** Request notification permission and return the result */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (isDesktopNotificationSupported()) {
    return requestDesktopNotificationPermission();
  }
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

/** Register the network-only service worker used for persistent notifications. */
export async function registerNotificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (error) {
    console.warn("[ShowPilot] Service worker registration failed:", error);
    return null;
  }
}

/** Enable and persist Web Push for the current signed-in member/device. */
export async function enablePushForOrg(orgId: string, requestPermission = true): Promise<NotificationPermission> {
  if (isDesktopNotificationSupported()) {
    if (!requestPermission) return getDesktopNotificationPermission();
    return requestDesktopNotificationPermission();
  }
  if (!isPushSupported()) return "denied";
  const permission = requestPermission ? await requestNotificationPermission() : Notification.permission;
  if (permission !== "granted") return permission;
  const registration = await registerNotificationWorker();
  if (!registration) return "denied";
  const { getPushConfiguration, savePushSubscription } = await import("@/lib/push-notifications");
  const config = await getPushConfiguration({ data: { orgId } });
  if (!config.supported || !config.publicKey) throw new Error("Push delivery is not configured on this environment");
  const subscription = await subscribeToPush(registration, config.publicKey);
  const json = subscription?.toJSON();
  if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("This device could not create a push subscription");
  await savePushSubscription({ data: {
    orgId,
    endpoint: json.endpoint,
    expirationTime: json.expirationTime,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  } });
  return permission;
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
  if (isDesktopNotificationSupported()) return true;
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
  if (isDesktopNotificationSupported()) {
    void showDesktopNotification(title, body);
    return;
  }
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
