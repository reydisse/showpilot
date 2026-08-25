import { env } from "cloudflare:workers";
import webpush from "web-push";
import { getD1 } from "@/lib/d1";

type PushPayload = { title: string; body: string; url: string; tag: string };
type PushRow = { id: string; endpoint: string; p256dh: string; auth: string };

interface ExpoPushTicket {
  status?: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

function isExpoPushToken(endpoint: string) {
  return /^Expo(?:nent)?PushToken\[[^\]]+\]$/.test(endpoint);
}

async function deliverExpoPush(row: PushRow, payload: PushPayload) {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        to: row.endpoint,
        title: payload.title,
        body: payload.body,
        data: { url: payload.url, tag: payload.tag },
        sound: "default",
        priority: "high",
        channelId: "show-operations",
      }),
    });
    if (!response.ok) throw new Error(`Expo push service returned ${response.status}`);
    const result = await response.json() as { data?: ExpoPushTicket | ExpoPushTicket[] };
    const ticket = Array.isArray(result.data) ? result.data[0] : result.data;
    if (ticket?.status === "ok") return true;
    if (ticket?.details?.error === "DeviceNotRegistered") {
      await getD1().prepare("DELETE FROM push_subscription WHERE id = ?").bind(row.id).run();
      return false;
    }
    console.error("[Push] Expo delivery failed", ticket?.details?.error ?? ticket?.message ?? "unknown error");
  } catch (error) {
    console.error("[Push] Expo request failed", error);
  }
  return false;
}

export async function deliverPushToUser(orgId: string, userId: string, payload: PushPayload) {
  const publicKey = String(env.VAPID_PUBLIC_KEY ?? "");
  const privateKey = String(env.VAPID_PRIVATE_KEY ?? "");
  const subject = String(env.VAPID_SUBJECT ?? "mailto:support@showpilot.tech");
  const rows = await getD1().prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE orgId = ? AND userId = ?`,
  ).bind(orgId, userId).all<PushRow>();
  let sent = 0;
  await Promise.all((rows.results ?? []).map(async (row) => {
    if (isExpoPushToken(row.endpoint)) {
      if (await deliverExpoPush(row, payload)) sent += 1;
      return;
    }
    if (!publicKey || !privateKey) return;
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), { TTL: 300, urgency: "high" });
      sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await getD1().prepare("DELETE FROM push_subscription WHERE id = ?").bind(row.id).run();
      } else {
        console.error("[Push] delivery failed", statusCode ?? error);
      }
    }
  }));
  const hasExpoSubscription = (rows.results ?? []).some((row) => isExpoPushToken(row.endpoint));
  return { sent, configured: hasExpoSubscription || Boolean(publicKey && privateKey) };
}
