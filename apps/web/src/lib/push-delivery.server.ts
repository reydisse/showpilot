import { env } from "cloudflare:workers";
import webpush from "web-push";
import { getD1 } from "@/lib/d1";
import { expoPushHeaders } from "@/lib/expo-push-receipts.server";

type PushPayload = { title: string; body: string; url: string; tag: string };
type PushRow = { id: string; endpoint: string; p256dh: string; auth: string };

type ExpoPushTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; error: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expoError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}

function parseExpoPushTicket(value: unknown): ExpoPushTicket | null {
  if (!isRecord(value)) return null;
  if (value.status === "ok" && typeof value.id === "string" && value.id) {
    return { status: "ok", id: value.id };
  }
  if (value.status === "error") {
    return {
      status: "error",
      message: typeof value.message === "string" ? value.message : "Expo rejected the push request",
      error: expoError(value.details),
    };
  }
  return null;
}

function ticketFromResponse(value: unknown): ExpoPushTicket | null {
  if (!isRecord(value)) return null;
  const first = Array.isArray(value.data) ? value.data[0] : value.data;
  return parseExpoPushTicket(first);
}

function isExpoPushToken(endpoint: string): boolean {
  return /^Expo(?:nent)?PushToken\[[^\]]+\]$/.test(endpoint);
}

function statusCodeFromError(error: unknown): number | null {
  return isRecord(error) && typeof error.statusCode === "number" ? error.statusCode : null;
}

async function deliverExpoPush(row: PushRow, payload: PushPayload): Promise<boolean> {
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: expoPushHeaders(env.EXPO_ACCESS_TOKEN),
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
    const result: unknown = await response.json();
    const ticket = ticketFromResponse(result);
    if (ticket?.status === "ok") {
      await getD1().prepare(
        `INSERT INTO expo_push_receipt (id, ticketId, subscriptionId, createdAt, nextCheckAt)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, datetime('now', '+15 minutes'))
         ON CONFLICT(ticketId) DO NOTHING`,
      ).bind(crypto.randomUUID(), ticket.id, row.id).run();
      return true;
    }
    if (ticket?.status === "error" && ticket.error === "DeviceNotRegistered") {
      await getD1().prepare("DELETE FROM push_subscription WHERE id = ?").bind(row.id).run();
      return false;
    }
    console.error("[Push] Expo ticket rejected", {
      error: ticket?.error ?? "InvalidTicket",
      message: ticket?.status === "error" ? ticket.message : "Expo returned an invalid ticket",
    });
  } catch (error) {
    console.error("[Push] Expo request failed", { error });
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
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        { TTL: 300, urgency: "high" },
      );
      sent += 1;
    } catch (error) {
      const statusCode = statusCodeFromError(error);
      if (statusCode === 404 || statusCode === 410) {
        await getD1().prepare("DELETE FROM push_subscription WHERE id = ?").bind(row.id).run();
      } else {
        console.error("[Push] web delivery failed", { error, statusCode });
      }
    }
  }));
  const hasExpoSubscription = (rows.results ?? []).some((row) => isExpoPushToken(row.endpoint));
  return { sent, configured: hasExpoSubscription || Boolean(publicKey && privateKey) };
}
