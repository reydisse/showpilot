import {
  getPushConfiguration,
  savePushSubscription,
} from "@/lib/push-notifications";

/** Loaded only after notification permission and service-worker registration. */
export async function persistPushSubscription(
  orgId: string,
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const config = await getPushConfiguration({ data: { orgId } });
  if (!config.supported || !config.publicKey)
    throw new Error("Push delivery is not configured on this environment");
  const subscription = await subscribeToPush(registration, config.publicKey);
  const json = subscription?.toJSON();
  if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth)
    throw new Error("This device could not create a push subscription");
  await savePushSubscription({
    data: {
      orgId,
      endpoint: json.endpoint,
      expirationTime: json.expirationTime,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
  });
}

/** Reuse this browser's subscription or create one with the server's public VAPID key. */
async function subscribeToPush(
  registration: ServiceWorkerRegistration,
  vapidPublicKey?: string,
): Promise<PushSubscription | null> {
  if (!vapidPublicKey) {
    console.warn(
      "[ShowPilot] No VAPID public key configured — push subscription skipped",
    );
    return null;
  }

  try {
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });

    return subscription;
  } catch (err) {
    console.warn("[ShowPilot] Push subscription failed:", err);
    return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
