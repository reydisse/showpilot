import { env } from "cloudflare:workers";
import webpush from "web-push";
import { getD1 } from "@/lib/d1";

type PushPayload = { title: string; body: string; url: string; tag: string };
type PushRow = { id: string; endpoint: string; p256dh: string; auth: string };

export async function deliverPushToUser(orgId: string, userId: string, payload: PushPayload) {
  const publicKey = String(env.VAPID_PUBLIC_KEY ?? "");
  const privateKey = String(env.VAPID_PRIVATE_KEY ?? "");
  const subject = String(env.VAPID_SUBJECT ?? "mailto:support@showpilot.tech");
  if (!publicKey || !privateKey) return { sent: 0, configured: false };

  webpush.setVapidDetails(subject, publicKey, privateKey);
  const rows = await getD1().prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE orgId = ? AND userId = ?`,
  ).bind(orgId, userId).all<PushRow>();
  let sent = 0;
  await Promise.all((rows.results ?? []).map(async (row) => {
    try {
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
  return { sent, configured: true };
}
