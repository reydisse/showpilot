import type { getPrisma } from "@/lib/db";

export const WEBHOOK_EVENTS_KEY = "webhook-events";
export const MAX_WEBHOOK_EVENTS = 50;

interface StoredWebhookEvent {
  id?: string;
  timestamp?: string;
  source?: string;
  type?: string;
  direction?: "incoming" | "outgoing" | "system";
  status?: "success" | "error" | "info" | "warning";
  details?: string;
  payloadSummary?: string;
}

export interface WebhookEventLogItem {
  id: string;
  timestamp: string;
  source: string;
  type: string;
  direction: "incoming" | "outgoing" | "system";
  status: "success" | "error" | "info" | "warning";
  details: string;
  payloadSummary?: string;
}

export interface WebhookEventInput
  extends Omit<WebhookEventLogItem, "id" | "timestamp"> {}

export function sanitizePayloadSummary(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    if (!payload.trim()) return undefined;
    return payload.length > 180 ? `${payload.slice(0, 177)}...` : payload;
  }
  if (payload == null) return undefined;
  try {
    const json = JSON.stringify(payload);
    if (!json) return undefined;
    return json.length > 180 ? `${json.slice(0, 177)}...` : json;
  } catch {
    return undefined;
  }
}

export function normalizeWebhookEvent(raw: unknown, fallbackIndex: number): WebhookEventLogItem | null {
  const event = raw as StoredWebhookEvent | null;
  if (!event || typeof event !== "object") return null;
  const direction = event.direction === "incoming" || event.direction === "outgoing" || event.direction === "system"
    ? event.direction : "system";
  const status = event.status === "success" || event.status === "error" || event.status === "warning"
    ? event.status : "info";
  const timestamp = typeof event.timestamp === "string" && !Number.isNaN(Date.parse(event.timestamp))
    ? event.timestamp : new Date().toISOString();
  return {
    id: event.id && event.id.length > 0 ? event.id : `webhook-event-${Date.now()}-${fallbackIndex}`,
    timestamp,
    source: event.source && event.source.trim().length > 0 ? event.source : "system",
    type: event.type && event.type.trim().length > 0 ? event.type : "webhook-event",
    direction,
    status,
    details: event.details?.trim() ? event.details : "No details provided.",
    payloadSummary: event.payloadSummary || sanitizePayloadSummary((event as Record<string, unknown>).payload),
  };
}

export async function appendWebhookEvent(
  prisma: ReturnType<typeof getPrisma>,
  orgId: string,
  event: WebhookEventInput,
) {
  const existing = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: WEBHOOK_EVENTS_KEY } },
  });
  const parsed = existing?.value ? (() => {
    try { return JSON.parse(existing.value); } catch { return []; }
  })() : [];
  const previousEvents = Array.isArray(parsed) ? (parsed as unknown[]) : [];
  const normalizedEvents = previousEvents
    .map((entry, index) => normalizeWebhookEvent(entry, index))
    .filter((entry): entry is WebhookEventLogItem => Boolean(entry));
  const nextEvents: WebhookEventLogItem[] = [{
    ...event,
    id: `webhook-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  }, ...normalizedEvents];
  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key: WEBHOOK_EVENTS_KEY } },
    update: { value: JSON.stringify(nextEvents.slice(0, MAX_WEBHOOK_EVENTS)) },
    create: { orgId, key: WEBHOOK_EVENTS_KEY, value: JSON.stringify(nextEvents.slice(0, MAX_WEBHOOK_EVENTS)) },
  });
}
