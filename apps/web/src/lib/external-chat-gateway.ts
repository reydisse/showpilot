import type { ChatAttachment, MessageType } from "@/lib/adapters/chat-adapter";

export type ExternalChatPlatform = "mattermost" | "slack" | "discord" | "teams";

export type ExternalChatConfiguration =
  | { platform: "mattermost"; baseUrl: string; token: string; channelId: string }
  | { platform: "slack"; token: string; channelId: string }
  | { platform: "discord"; token: string; channelId: string }
  | { platform: "teams"; webhookUrl: string };

export interface ExternalChatMessage {
  externalId: string;
  senderId?: string;
  senderName: string;
  text: string;
  type: MessageType;
  timestamp: number;
  replyToExternalId?: string;
  /** Native identity echoed by an external event to prevent mirror loops. */
  sourceNativeId?: string;
  editedAt?: number;
  deletedAt?: number;
}

export interface ExternalChatHistory {
  messages: ExternalChatMessage[];
  nextCursor: string | null;
}

export interface ExternalChatOutboundMessage {
  id: string;
  senderName: string;
  text: string;
  type: MessageType;
  attachments?: ChatAttachment[];
  poll?: { question: string; options: Array<{ text: string }> };
}

const EXTERNAL_SETTING_KEYS = [
  "chat-adapter",
  "mattermost-url",
  "mattermost-token",
  "mattermost-channel",
  "slack-token",
  "slack-channel",
  "discord-bot-token",
  "discord-channel-id",
  "teams-webhook-url",
] as const;

export interface ExternalChatSettingsStore {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

function cleanBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Mattermost must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function required(settings: Record<string, string>, key: string, platform: string): string {
  const value = settings[key]?.trim();
  if (!value) throw new Error(`${platform} is selected but ${key} is missing`);
  return value;
}

export async function loadExternalChatConfiguration(
  db: ExternalChatSettingsStore,
  orgId: string,
): Promise<ExternalChatConfiguration | null> {
  const rows = await db.prepare(
    `SELECT key, value FROM app_setting
     WHERE orgId = ? AND key IN (${EXTERNAL_SETTING_KEYS.map(() => "?").join(", ")})`,
  ).bind(orgId, ...EXTERNAL_SETTING_KEYS).all<{ key: string; value: string }>();
  const settings = Object.fromEntries(rows.results.map((row) => [row.key, row.value]));
  const platform = settings["chat-adapter"]?.trim();

  switch (platform) {
    case "mattermost":
      return {
        platform,
        baseUrl: cleanBaseUrl(required(settings, "mattermost-url", "Mattermost")),
        token: required(settings, "mattermost-token", "Mattermost"),
        channelId: required(settings, "mattermost-channel", "Mattermost"),
      };
    case "slack":
      return {
        platform,
        token: required(settings, "slack-token", "Slack"),
        channelId: required(settings, "slack-channel", "Slack"),
      };
    case "discord":
      return {
        platform,
        token: required(settings, "discord-bot-token", "Discord"),
        channelId: required(settings, "discord-channel-id", "Discord"),
      };
    case "teams":
      return {
        platform,
        webhookUrl: required(settings, "teams-webhook-url", "Teams"),
      };
    default:
      return null;
  }
}

export function parseExternalChatText(value: string): { senderName?: string; text: string; type: MessageType } {
  let text = value;
  let senderName: string | undefined;
  const sender = text.match(/^\*\*(.{1,200}?)\*\*:\s*/);
  if (sender) {
    senderName = sender[1];
    text = text.slice(sender[0].length);
  }
  let type: MessageType = "text";
  if (text.startsWith("[ALERT] ")) {
    type = "alert";
    text = text.slice(8);
  } else if (text.startsWith("[CUE] ")) {
    type = "cue";
    text = text.slice(6);
  }
  return { senderName, text, type };
}

function outboundText(message: ExternalChatOutboundMessage): string {
  const prefix = message.type === "alert" ? "[ALERT] " : message.type === "cue" ? "[CUE] " : "";
  const extras = [
    ...(message.attachments ?? []).map((attachment) => attachment.url),
    ...(message.poll
      ? [`Poll: ${message.poll.question}`, ...message.poll.options.map((option) => `• ${option.text}`)]
      : []),
  ];
  return [`**${message.senderName.slice(0, 200)}**: ${prefix}${message.text}`, ...extras]
    .filter((part) => part.trim())
    .join("\n");
}

async function responseError(response: Response, platform: string): Promise<Error> {
  const detail = (await response.text().catch(() => "")).trim().slice(0, 240);
  return new Error(`${platform} returned ${response.status}${detail ? `: ${detail}` : ""}`);
}

export async function sendExternalChatMessage(
  config: ExternalChatConfiguration,
  message: ExternalChatOutboundMessage,
  replyToExternalId?: string,
): Promise<{ externalId: string | null }> {
  const formatted = outboundText(message);

  switch (config.platform) {
    case "mattermost": {
      const response = await fetch(`${config.baseUrl}/api/v4/posts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: config.channelId,
          message: formatted,
          ...(replyToExternalId ? { root_id: replyToExternalId } : {}),
          props: {
            override_username: message.senderName.slice(0, 200),
            showpilot_type: message.type,
            showpilot_message_id: message.id,
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw await responseError(response, "Mattermost");
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.id !== "string") throw new Error("Mattermost returned an invalid message");
      return { externalId: body.id };
    }
    case "slack": {
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          channel: config.channelId,
          text: formatted,
          ...(replyToExternalId ? { thread_ts: replyToExternalId } : {}),
          unfurl_links: false,
          unfurl_media: false,
          metadata: {
            event_type: "showpilot_message",
            event_payload: { native_id: message.id },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw await responseError(response, "Slack");
      const body: unknown = await response.json();
      if (!isRecord(body) || body.ok !== true || typeof body.ts !== "string") {
        throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "Slack returned an invalid message");
      }
      return { externalId: body.ts };
    }
    case "discord": {
      const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(config.channelId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: formatted.slice(0, 2_000),
          nonce: message.id.replaceAll("-", "").slice(0, 25),
          enforce_nonce: true,
          allowed_mentions: { parse: [] },
          ...(replyToExternalId
            ? { message_reference: { type: 0, message_id: replyToExternalId, fail_if_not_exists: false } }
            : {}),
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw await responseError(response, "Discord");
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.id !== "string") throw new Error("Discord returned an invalid message");
      return { externalId: body.id };
    }
    case "teams": {
      const response = await fetch(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: formatted }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw await responseError(response, "Teams");
      return { externalId: null };
    }
  }
}

export async function updateExternalChatMessage(
  config: ExternalChatConfiguration,
  externalId: string,
  message: ExternalChatOutboundMessage | null,
): Promise<void> {
  if (config.platform === "teams") return;
  const formatted = message ? outboundText(message) : null;
  let response: Response;

  if (config.platform === "mattermost") {
    response = await fetch(`${config.baseUrl}/api/v4/posts/${encodeURIComponent(externalId)}${message ? "/patch" : ""}`, {
      method: message ? "PUT" : "DELETE",
      headers: { Authorization: `Bearer ${config.token}`, ...(message ? { "Content-Type": "application/json" } : {}) },
      body: message ? JSON.stringify({ message: formatted }) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
  } else if (config.platform === "slack") {
    response = await fetch(`https://slack.com/api/${message ? "chat.update" : "chat.delete"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: config.channelId, ts: externalId, ...(message ? { text: formatted } : {}) }),
      signal: AbortSignal.timeout(8_000),
    });
  } else {
    response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(config.channelId)}/messages/${encodeURIComponent(externalId)}`, {
      method: message ? "PATCH" : "DELETE",
      headers: { Authorization: `Bot ${config.token}`, ...(message ? { "Content-Type": "application/json" } : {}) },
      body: message ? JSON.stringify({ content: formatted?.slice(0, 2_000), allowed_mentions: { parse: [] } }) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
  }

  if (!response.ok) throw await responseError(response, config.platform);
  if (config.platform === "slack") {
    const body: unknown = await response.json();
    if (!isRecord(body) || body.ok !== true) {
      throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "Slack returned an invalid update");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function messageType(value: unknown, fallback: MessageType): MessageType {
  return value === "alert" || value === "cue" || value === "system" || value === "text" ? value : fallback;
}

function byTimestamp(left: ExternalChatMessage, right: ExternalChatMessage): number {
  return left.timestamp - right.timestamp || left.externalId.localeCompare(right.externalId);
}

export async function fetchExternalChatHistory(
  config: ExternalChatConfiguration,
  cursor: string | null,
): Promise<ExternalChatHistory> {
  if (config.platform === "teams") return { messages: [], nextCursor: cursor };

  if (config.platform === "mattermost") {
    const endpoint = new URL(`${config.baseUrl}/api/v4/channels/${encodeURIComponent(config.channelId)}/posts`);
    endpoint.searchParams.set("per_page", "100");
    if (cursor) endpoint.searchParams.set("since", cursor);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw await responseError(response, "Mattermost");
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.order) || !isRecord(body.posts)) {
      throw new Error("Mattermost returned invalid history");
    }
    const posts = body.posts;
    const messages = body.order.flatMap((id) => {
      if (typeof id !== "string") return [];
      const post = posts[id];
      if (!isRecord(post) || typeof post.id !== "string" || typeof post.message !== "string" || typeof post.create_at !== "number") return [];
      const parsed = parseExternalChatText(post.message);
      const props = isRecord(post.props) ? post.props : {};
      return [{
        externalId: post.id,
        senderId: stringValue(post.user_id),
        senderName: stringValue(props.override_username) ?? parsed.senderName ?? stringValue(post.user_id)?.slice(0, 12) ?? "Mattermost member",
        text: parsed.text,
        type: messageType(props.showpilot_type, parsed.type),
        timestamp: post.create_at,
        replyToExternalId: stringValue(post.root_id),
        editedAt: typeof post.update_at === "number" && post.update_at > post.create_at ? post.update_at : undefined,
        deletedAt: typeof post.delete_at === "number" && post.delete_at > 0 ? post.delete_at : undefined,
      } satisfies ExternalChatMessage];
    }).sort(byTimestamp);
    const nextCursor = messages.length
      ? String(Math.max(Number(cursor) || 0, ...messages.map((message) => message.timestamp)))
      : cursor;
    return { messages, nextCursor };
  }

  if (config.platform === "slack") {
    const endpoint = new URL("https://slack.com/api/conversations.history");
    endpoint.searchParams.set("channel", config.channelId);
    endpoint.searchParams.set("limit", "100");
    endpoint.searchParams.set("include_all_metadata", "true");
    if (cursor) endpoint.searchParams.set("oldest", cursor);
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw await responseError(response, "Slack");
    const body: unknown = await response.json();
    if (!isRecord(body) || body.ok !== true || !Array.isArray(body.messages)) {
      throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "Slack returned invalid history");
    }
    const messages = body.messages.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.ts !== "string" || typeof candidate.text !== "string") return [];
      const parsed = parseExternalChatText(candidate.text);
      const externalId = candidate.ts;
      const threadTs = stringValue(candidate.thread_ts);
      const edited = isRecord(candidate.edited) ? candidate.edited : {};
      const editedAt = stringValue(edited.ts);
      return [{
        externalId,
        senderId: stringValue(candidate.user) ?? stringValue(candidate.bot_id),
        senderName: parsed.senderName ?? stringValue(candidate.username) ?? stringValue(candidate.user) ?? "Slack member",
        text: parsed.text,
        type: parsed.type,
        timestamp: Math.floor(Number.parseFloat(externalId) * 1_000),
        replyToExternalId: threadTs && threadTs !== externalId ? threadTs : undefined,
        editedAt: editedAt ? Math.floor(Number.parseFloat(editedAt) * 1_000) : undefined,
      } satisfies ExternalChatMessage];
    }).filter((message) => Number.isFinite(message.timestamp)).sort(byTimestamp);
    const nextCursor = messages.length
      ? messages.reduce((latest, message) => Number.parseFloat(message.externalId) > Number.parseFloat(latest) ? message.externalId : latest, cursor ?? "0")
      : cursor;
    return { messages, nextCursor };
  }

  const endpoint = new URL(`https://discord.com/api/v10/channels/${encodeURIComponent(config.channelId)}/messages`);
  endpoint.searchParams.set("limit", "100");
  if (cursor) endpoint.searchParams.set("after", cursor);
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bot ${config.token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw await responseError(response, "Discord");
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("Discord returned invalid history");
  const messages = body.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.content !== "string" || typeof candidate.timestamp !== "string") return [];
    const author = isRecord(candidate.author) ? candidate.author : {};
    const reference = isRecord(candidate.message_reference) ? candidate.message_reference : {};
    const parsed = parseExternalChatText(candidate.content);
    return [{
      externalId: candidate.id,
      senderId: stringValue(author.id),
      senderName: parsed.senderName ?? stringValue(author.global_name) ?? stringValue(author.username) ?? "Discord member",
      text: parsed.text,
      type: parsed.type,
      timestamp: Date.parse(candidate.timestamp),
      replyToExternalId: stringValue(reference.message_id),
      editedAt: typeof candidate.edited_timestamp === "string" ? Date.parse(candidate.edited_timestamp) : undefined,
    } satisfies ExternalChatMessage];
  }).filter((message) => Number.isFinite(message.timestamp)).sort(byTimestamp);
  return { messages, nextCursor: messages.at(-1)?.externalId ?? cursor };
}

export function externalChatPollInterval(platform: ExternalChatPlatform): number | null {
  switch (platform) {
    case "mattermost": return 3_000;
    case "discord": return 5_000;
    case "slack": return 60_000;
    case "teams": return null;
  }
}
