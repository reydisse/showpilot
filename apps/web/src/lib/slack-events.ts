import { parseExternalChatText, type ExternalChatMessage } from "@/lib/external-chat-gateway";

interface SlackEventMessage {
  type?: unknown;
  subtype?: unknown;
  channel?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  text?: unknown;
  user?: unknown;
  bot_id?: unknown;
  username?: unknown;
  metadata?: unknown;
  deleted_ts?: unknown;
  event_ts?: unknown;
  message?: unknown;
  previous_message?: unknown;
}

export type ParsedSlackEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "ignored" }
  | { kind: "message"; channelId: string; message: ExternalChatMessage };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export async function verifySlackSignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature?.startsWith("v0=")) return false;
  const timestampMs = Number(timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 5 * 60_000) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const expected = `v0=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return safeEqual(expected, signature);
}

function showPilotNativeId(metadata: unknown): string | undefined {
  if (!isRecord(metadata) || metadata.event_type !== "showpilot_message" || !isRecord(metadata.event_payload)) return undefined;
  const nativeId = metadata.event_payload.native_id;
  return typeof nativeId === "string" && nativeId.length <= 128 ? nativeId : undefined;
}

function parseMessageEvent(event: SlackEventMessage): ParsedSlackEvent {
  if (event.type === "message" && event.subtype === "message_changed" && typeof event.channel === "string" && isRecord(event.message)) {
    const changed = event.message;
    const parsed = parseMessageEvent({
      ...changed,
      type: "message",
      channel: event.channel,
      subtype: undefined,
    });
    if (parsed.kind !== "message") return parsed;
    const edited = isRecord(changed.edited) ? changed.edited : {};
    const editedTimestamp = typeof edited.ts === "string" ? Number.parseFloat(edited.ts) * 1_000 : Date.now();
    parsed.message.editedAt = Number.isFinite(editedTimestamp) ? Math.floor(editedTimestamp) : Date.now();
    return parsed;
  }
  if (event.type === "message" && event.subtype === "message_deleted" && typeof event.channel === "string" && typeof event.deleted_ts === "string") {
    const previous = isRecord(event.previous_message) ? event.previous_message : {};
    const eventTimestamp = typeof event.event_ts === "string" ? Number.parseFloat(event.event_ts) * 1_000 : Date.now();
    const originalTimestamp = Number.parseFloat(event.deleted_ts) * 1_000;
    if (!Number.isFinite(originalTimestamp)) return { kind: "ignored" };
    const parsed = parseExternalChatText(typeof previous.text === "string" ? previous.text : "");
    return {
      kind: "message",
      channelId: event.channel,
      message: {
        externalId: event.deleted_ts,
        senderId: typeof previous.user === "string" ? previous.user : typeof previous.bot_id === "string" ? previous.bot_id : undefined,
        senderName: parsed.senderName ?? (typeof previous.username === "string" ? previous.username : "Slack member"),
        text: "",
        type: parsed.type,
        timestamp: Math.floor(originalTimestamp),
        deletedAt: Number.isFinite(eventTimestamp) ? Math.floor(eventTimestamp) : Date.now(),
      },
    };
  }
  if (event.type !== "message"
    || typeof event.channel !== "string"
    || typeof event.ts !== "string"
    || typeof event.text !== "string") return { kind: "ignored" };
  if (event.subtype && event.subtype !== "bot_message") return { kind: "ignored" };
  const timestamp = Math.floor(Number.parseFloat(event.ts) * 1_000);
  if (!Number.isFinite(timestamp)) return { kind: "ignored" };
  const parsed = parseExternalChatText(event.text);

  return {
    kind: "message",
    channelId: event.channel,
    message: {
      externalId: event.ts,
      senderId: typeof event.user === "string" ? event.user : typeof event.bot_id === "string" ? event.bot_id : undefined,
      senderName: parsed.senderName ?? (typeof event.username === "string"
        ? event.username
        : typeof event.user === "string"
          ? event.user
          : "Slack member"),
      text: parsed.text,
      type: parsed.type,
      timestamp,
      replyToExternalId: typeof event.thread_ts === "string" && event.thread_ts !== event.ts ? event.thread_ts : undefined,
      sourceNativeId: showPilotNativeId(event.metadata),
    },
  };
}

export function parseSlackEventEnvelope(value: unknown): ParsedSlackEvent {
  if (!isRecord(value)) return { kind: "ignored" };
  if (value.type === "url_verification" && typeof value.challenge === "string") {
    return { kind: "challenge", challenge: value.challenge };
  }
  if (value.type !== "event_callback" || !isRecord(value.event)) return { kind: "ignored" };
  return parseMessageEvent(value.event);
}
