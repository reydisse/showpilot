/**
 * Chat Proxy — Server-side functions for external chat platform APIs.
 *
 * All external API calls (Mattermost, Slack, Discord, Teams) go through
 * these server functions. Credentials are read from D1 per-org and never
 * exposed to the client.
 */

import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import type { ChatMessage } from "@/lib/adapters/chat-adapter";
import {
  appendWebhookEvent,
  sanitizePayloadSummary,
  type WebhookEventInput,
} from "@/lib/settings";

type Platform = "mattermost" | "slack" | "teams" | "discord";

function parseShowPilotFormattedMessage(message: string): {
  senderName?: string;
  text: string;
  type: ChatMessage["type"];
} {
  let remaining = message;
  let senderName: string | undefined;

  const senderMatch = remaining.match(/^\*\*(.+?)\*\*:\s*/);
  if (senderMatch) {
    senderName = senderMatch[1];
    remaining = remaining.slice(senderMatch[0].length);
  }

  let type: ChatMessage["type"] = "text";
  if (remaining.startsWith("[ALERT] ")) {
    type = "alert";
    remaining = remaining.slice(8);
  } else if (remaining.startsWith("[CUE] ")) {
    type = "cue";
    remaining = remaining.slice(6);
  }

  return { senderName, text: remaining, type };
}

type ChatMessageType = ChatMessage["type"];

function parseExternalChatType(value: unknown): ChatMessageType | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "text" || value === "alert" || value === "cue" || value === "system") {
    return value;
  }
  return undefined;
}

// ─── Credential resolution ──────────────────────────────────

const PLATFORM_KEYS: Record<Platform, string[]> = {
  mattermost: ["mattermost-url", "mattermost-token", "mattermost-channel"],
  slack: ["slack-token", "slack-channel"],
  discord: ["discord-bot-token", "discord-channel-id"],
  teams: ["teams-webhook-url"],
};

async function getChatCredentials(
  orgId: string,
  platform: Platform,
): Promise<Record<string, string>> {
  const prisma = getPrisma();
  const keys = PLATFORM_KEYS[platform];
  const settings = await prisma.appSetting.findMany({
    where: { orgId, key: { in: keys } },
  });
  const map: Record<string, string> = {};
  for (const s of settings) map[s.key] = s.value;
  return map;
}

// ─── Test Connection ────────────────────────────────────────

export const testChatConnection = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orgId: string; platform: Platform }) => data,
  )
  .handler(
    async ({ data }): Promise<{ ok: boolean; error?: string }> => {
      const creds = await getChatCredentials(data.orgId, data.platform);
      const prisma = getPrisma();
      const logEvent = (event: WebhookEventInput): void => {
        void appendWebhookEvent(prisma, data.orgId, event);
      };

      try {
        switch (data.platform) {
          case "mattermost": {
            const url = creds["mattermost-url"];
            const token = creds["mattermost-token"];
            if (!url || !token) {
              logEvent({
                source: "chat-proxy",
                type: "mattermost-connection-test",
                direction: "outgoing",
                status: "warning",
                details: "Mattermost connection test skipped: missing server URL or bot token.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "mattermost",
                  missingUrl: !url,
                  missingToken: !token,
                }),
              });
              return { ok: false, error: "Missing server URL or bot token" };
            }
            const res = await fetch(`${url.replace(/\/$/, "")}/api/v4/users/me`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              logEvent({
                source: "chat-proxy",
                type: "mattermost-connection-test",
                direction: "outgoing",
                status: "error",
                details: `Mattermost test failed with ${res.status}`,
                payloadSummary: sanitizePayloadSummary({ platform: "mattermost", status: "error" }),
              });
              return { ok: false, error: `Mattermost returned ${res.status}: ${body.slice(0, 200)}` };
            }
            logEvent({
              source: "chat-proxy",
              type: "mattermost-connection-test",
              direction: "outgoing",
              status: "success",
              details: "Mattermost test connection successful.",
              payloadSummary: sanitizePayloadSummary({ platform: "mattermost" }),
            });
            return { ok: true };
          }

          case "slack": {
            const token = creds["slack-token"];
            if (!token) {
              logEvent({
                source: "chat-proxy",
                type: "slack-connection-test",
                direction: "outgoing",
                status: "warning",
                details: "Slack connection test skipped: missing bot token.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "slack",
                  missingToken: true,
                }),
              });
              return { ok: false, error: "Missing bot token" };
            }
            const res = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              signal: AbortSignal.timeout(5000),
            });
            const body = await res.json() as { ok: boolean; error?: string };
            if (!body.ok) {
              logEvent({
                source: "chat-proxy",
                type: "slack-connection-test",
                direction: "outgoing",
                status: "error",
                details: body.error || "Slack auth test failed.",
                payloadSummary: sanitizePayloadSummary({ platform: "slack", error: body.error }),
              });
              return { ok: false, error: body.error || "Auth test failed" };
            }
            logEvent({
              source: "chat-proxy",
              type: "slack-connection-test",
              direction: "outgoing",
              status: "success",
              details: "Slack test connection successful.",
              payloadSummary: sanitizePayloadSummary({ platform: "slack" }),
            });
            return { ok: true };
          }

          case "discord": {
            const token = creds["discord-bot-token"];
            if (!token) {
              logEvent({
                source: "chat-proxy",
                type: "discord-connection-test",
                direction: "outgoing",
                status: "warning",
                details: "Discord connection test skipped: missing bot token.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "discord",
                  missingToken: true,
                }),
              });
              return { ok: false, error: "Missing bot token" };
            }
            const res = await fetch("https://discord.com/api/v10/users/@me", {
              headers: { Authorization: `Bot ${token}` },
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              logEvent({
                source: "chat-proxy",
                type: "discord-connection-test",
                direction: "outgoing",
                status: "error",
                details: `Discord test failed with ${res.status}`,
                payloadSummary: sanitizePayloadSummary({ platform: "discord", status: "error" }),
              });
              return { ok: false, error: `Discord returned ${res.status}` };
            }
            logEvent({
              source: "chat-proxy",
              type: "discord-connection-test",
              direction: "outgoing",
              status: "success",
              details: "Discord test connection successful.",
              payloadSummary: sanitizePayloadSummary({ platform: "discord" }),
            });
            return { ok: true };
          }

          case "teams": {
            const webhookUrl = creds["teams-webhook-url"];
            if (!webhookUrl) {
              logEvent({
                source: "chat-proxy",
                type: "teams-connection-test",
                direction: "outgoing",
                status: "warning",
                details: "Teams connection test skipped: missing webhook URL.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "teams",
                  missingWebhookUrl: true,
                }),
              });
              return { ok: false, error: "Missing webhook URL" };
            }
            // Teams webhooks don't have a test endpoint — send a test message
            const res = await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: "ShowPilot connection test — this message confirms your webhook is working.",
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              logEvent({
                source: "chat-proxy",
                type: "teams-connection-test",
                direction: "outgoing",
                status: "error",
                details: `Teams test failed with ${res.status}`,
                payloadSummary: sanitizePayloadSummary({ platform: "teams", test: true }),
              });
              return { ok: false, error: `Teams webhook returned ${res.status}` };
            }
            logEvent({
              source: "chat-proxy",
              type: "teams-connection-test",
              direction: "outgoing",
              status: "success",
              details: "Teams test message sent successfully.",
              payloadSummary: sanitizePayloadSummary({ platform: "teams", test: true }),
            });
            return { ok: true };
          }

          default:
            return { ok: false, error: "Unknown platform" };
        }
      } catch (err) {
        logEvent({
          source: "chat-proxy",
          type: `${data.platform}-connection-test`,
          direction: "outgoing",
          status: "error",
          details: err instanceof Error ? err.message : "Connection test failed",
        });
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Connection failed",
        };
      }
    },
  );

// ─── Send Message ───────────────────────────────────────────

export const sendExternalChatMessage = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      platform: Platform;
      text: string;
      senderName: string;
      type?: string;
    }) => data,
  )
  .handler(
    async ({ data }): Promise<{ ok: boolean; error?: string }> => {
      const creds = await getChatCredentials(data.orgId, data.platform);
      const prisma = getPrisma();
      const logEvent = (event: WebhookEventInput): void => {
        void appendWebhookEvent(prisma, data.orgId, event);
      };
      const prefix =
        data.type === "alert"
          ? "[ALERT] "
          : data.type === "cue"
            ? "[CUE] "
            : "";
      const formatted = `**${data.senderName}**: ${prefix}${data.text}`;

      try {
        switch (data.platform) {
          case "mattermost": {
            const url = creds["mattermost-url"];
            const token = creds["mattermost-token"];
            const channel = creds["mattermost-channel"];
            if (!url || !token || !channel) {
              logEvent({
                source: "chat-proxy",
                type: "mattermost-send",
                direction: "outgoing",
                status: "warning",
                details: "Mattermost send skipped: missing credentials.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "mattermost",
                  missingUrl: !url,
                  missingToken: !token,
                  missingChannel: !channel,
                }),
              });
              return { ok: false, error: "Missing credentials" };
            }
            const res = await fetch(
              `${url.replace(/\/$/, "")}/api/v4/posts`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  channel_id: channel,
                  message: formatted,
                  props: {
                    override_username: data.senderName,
                    showpilot_type: data.type || "text",
                  },
                }),
                signal: AbortSignal.timeout(5000),
              },
            );
            if (!res.ok) {
              logEvent({
                source: "chat-proxy",
                type: "mattermost-send",
                direction: "outgoing",
                status: "error",
                details: `Mattermost send failed with ${res.status}`,
                payloadSummary: sanitizePayloadSummary(formatted),
              });
              return { ok: false, error: `Send failed: ${res.status}` };
            }
            logEvent({
              source: "chat-proxy",
              type: "mattermost-send",
              direction: "outgoing",
              status: "success",
              details: "Message sent to Mattermost.",
              payloadSummary: sanitizePayloadSummary(formatted),
            });
            return { ok: true };
          }

          case "slack": {
            const token = creds["slack-token"];
            const channel = creds["slack-channel"];
            if (!token || !channel) {
              logEvent({
                source: "chat-proxy",
                type: "slack-send",
                direction: "outgoing",
                status: "warning",
                details: "Slack send skipped: missing credentials.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "slack",
                  missingToken: !token,
                  missingChannel: !channel,
                }),
              });
              return { ok: false, error: "Missing credentials" };
            }
            const res = await fetch(
              "https://slack.com/api/chat.postMessage",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ channel, text: formatted }),
                signal: AbortSignal.timeout(5000),
              },
            );
            const body = await res.json() as { ok: boolean; error?: string };
            if (!body.ok) {
              logEvent({
                source: "chat-proxy",
                type: "slack-send",
                direction: "outgoing",
                status: "error",
                details: body.error || "Slack send failed.",
                payloadSummary: sanitizePayloadSummary(formatted),
              });
              return { ok: false, error: body.error || "Send failed" };
            }
            logEvent({
              source: "chat-proxy",
              type: "slack-send",
              direction: "outgoing",
              status: "success",
              details: "Message sent to Slack.",
              payloadSummary: sanitizePayloadSummary(formatted),
            });
            return { ok: true };
          }

          case "discord": {
            const token = creds["discord-bot-token"];
            const channelId = creds["discord-channel-id"];
            if (!token || !channelId) {
              logEvent({
                source: "chat-proxy",
                type: "discord-send",
                direction: "outgoing",
                status: "warning",
                details: "Discord send skipped: missing credentials.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "discord",
                  missingToken: !token,
                  missingChannel: !channelId,
                }),
              });
              return { ok: false, error: "Missing credentials" };
            }
            const res = await fetch(
              `https://discord.com/api/v10/channels/${channelId}/messages`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bot ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ content: formatted }),
                signal: AbortSignal.timeout(5000),
              },
            );
            if (!res.ok) {
              logEvent({
                source: "chat-proxy",
                type: "discord-send",
                direction: "outgoing",
                status: "error",
                details: `Discord send failed with ${res.status}`,
                payloadSummary: sanitizePayloadSummary(formatted),
              });
              return { ok: false, error: `Send failed: ${res.status}` };
            }
            logEvent({
              source: "chat-proxy",
              type: "discord-send",
              direction: "outgoing",
              status: "success",
              details: "Message sent to Discord.",
              payloadSummary: sanitizePayloadSummary(formatted),
            });
            return { ok: true };
          }

          case "teams": {
            const webhookUrl = creds["teams-webhook-url"];
            if (!webhookUrl) {
              logEvent({
                source: "chat-proxy",
                type: "teams-send",
                direction: "outgoing",
                status: "warning",
                details: "Teams send skipped: missing webhook URL.",
                payloadSummary: sanitizePayloadSummary({
                  platform: "teams",
                  missingWebhookUrl: true,
                }),
              });
              return { ok: false, error: "Missing webhook URL" };
            }
            const res = await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: formatted }),
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              logEvent({
                source: "chat-proxy",
                type: "teams-send",
                direction: "outgoing",
                status: "error",
                details: `Teams send failed with ${res.status}`,
                payloadSummary: sanitizePayloadSummary(formatted),
              });
              return { ok: false, error: `Send failed: ${res.status}` };
            }
            logEvent({
              source: "chat-proxy",
              type: "teams-send",
              direction: "outgoing",
              status: "success",
              details: "Message sent to Teams.",
              payloadSummary: sanitizePayloadSummary(formatted),
            });
            return { ok: true };
          }

          default:
            return { ok: false, error: "Unknown platform" };
        }
      } catch (err) {
        logEvent({
          source: "chat-proxy",
          type: `${data.platform}-send`,
          direction: "outgoing",
          status: "error",
          details: err instanceof Error ? err.message : "Send failed",
          payloadSummary: sanitizePayloadSummary(data.text),
        });
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Send failed",
        };
      }
    },
  );

// ─── Get History / Poll ─────────────────────────────────────

export const getExternalChatHistory = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      orgId: string;
      platform: Platform;
      limit?: number;
      since?: string;
    }) => data,
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: boolean; messages: ChatMessage[]; error?: string }> => {
      const creds = await getChatCredentials(data.orgId, data.platform);
      const limit = data.limit ?? 50;

      try {
        switch (data.platform) {
          case "mattermost": {
            const url = creds["mattermost-url"];
            const token = creds["mattermost-token"];
            const channel = creds["mattermost-channel"];
            if (!url || !token || !channel)
              return { ok: false, messages: [], error: "Missing credentials" };

            let endpoint = `${url.replace(/\/$/, "")}/api/v4/channels/${channel}/posts?per_page=${limit}`;
            if (data.since) endpoint += `&since=${data.since}`;

            const res = await fetch(endpoint, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok)
              return { ok: false, messages: [], error: `${res.status}` };

            const body = (await res.json()) as {
              order: string[];
              posts: Record<string, { id: string; message: string; create_at: number; user_id: string; props?: { override_username?: string } }>;
            };
            const userIds = Array.from(
              new Set((body.order || []).map((id) => body.posts[id]?.user_id).filter(Boolean))
            );
            let userMap = new Map<string, string>();

            if (userIds.length > 0) {
              const usersRes = await fetch(`${url.replace(/\/$/, "")}/api/v4/users/ids`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(userIds),
                signal: AbortSignal.timeout(5000),
              });

              if (usersRes.ok) {
                const users = (await usersRes.json()) as Array<{
                  id: string;
                  username: string;
                  first_name?: string;
                  last_name?: string;
                  nickname?: string;
                }>;
                userMap = new Map(
                  users.map((user) => {
                    const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
                    return [user.id, user.nickname || fullName || user.username];
                  })
                );
              }
            }

            const messages: ChatMessage[] = (body.order || [])
            .map((id) => body.posts[id])
            .filter(Boolean)
            .map((post) => {
                const parsed = parseShowPilotFormattedMessage(post.message);
               const postType = parseExternalChatType((post.props as Record<string, unknown>)?.showpilot_type);
                return {
                  id: `mm-${post.id}`,
                  orgId: data.orgId,
                  senderId: post.user_id,
                  senderName:
                    post.props?.override_username ||
                    parsed.senderName ||
                    userMap.get(post.user_id) ||
                    post.user_id.slice(0, 8),
                  text: parsed.text,
                  type: postType || parsed.type,
                  timestamp: post.create_at,
                };
              })
              .reverse(); // oldest first
            return { ok: true, messages };
          }

          case "slack": {
            const token = creds["slack-token"];
            const channel = creds["slack-channel"];
            if (!token || !channel)
              return { ok: false, messages: [], error: "Missing credentials" };

            let endpoint = `https://slack.com/api/conversations.history?channel=${channel}&limit=${limit}`;
            if (data.since) endpoint += `&oldest=${data.since}`;

            const res = await fetch(endpoint, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(5000),
            });
            const body = (await res.json()) as {
              ok: boolean;
              messages?: { ts: string; text: string; user?: string; bot_id?: string }[];
              error?: string;
            };
            if (!body.ok)
              return { ok: false, messages: [], error: body.error || "Fetch failed" };

            const messages: ChatMessage[] = (body.messages || [])
              .map((msg) => ({
                id: `slack-${msg.ts}`,
                orgId: data.orgId,
                senderId: msg.user || msg.bot_id,
                senderName: msg.user || "Bot",
                text: msg.text,
                type: "text" as const,
                timestamp: Math.floor(parseFloat(msg.ts) * 1000),
              }))
              .reverse(); // oldest first
            return { ok: true, messages };
          }

          case "discord": {
            const token = creds["discord-bot-token"];
            const channelId = creds["discord-channel-id"];
            if (!token || !channelId)
              return { ok: false, messages: [], error: "Missing credentials" };

            let endpoint = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`;
            if (data.since) endpoint += `&after=${data.since}`;

            const res = await fetch(endpoint, {
              headers: { Authorization: `Bot ${token}` },
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok)
              return { ok: false, messages: [], error: `${res.status}` };

            const body = (await res.json()) as {
              id: string;
              content: string;
              author: { id: string; username: string };
              timestamp: string;
            }[];
            const messages: ChatMessage[] = (body || [])
              .map((msg) => ({
                id: `discord-${msg.id}`,
                orgId: data.orgId,
                senderId: msg.author?.id,
                senderName: msg.author?.username || "Unknown",
                text: msg.content,
                type: "text" as const,
                timestamp: new Date(msg.timestamp).getTime(),
              }))
              .reverse(); // oldest first
            return { ok: true, messages };
          }

          case "teams":
            // Teams webhook is send-only — no history
            return { ok: true, messages: [] };

          default:
            return { ok: false, messages: [], error: "Unknown platform" };
        }
      } catch (err) {
        return {
          ok: false,
          messages: [],
          error: err instanceof Error ? err.message : "Fetch failed",
        };
      }
    },
  );
