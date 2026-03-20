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

type Platform = "mattermost" | "slack" | "teams" | "discord";

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

      try {
        switch (data.platform) {
          case "mattermost": {
            const url = creds["mattermost-url"];
            const token = creds["mattermost-token"];
            if (!url || !token) return { ok: false, error: "Missing server URL or bot token" };
            const res = await fetch(`${url.replace(/\/$/, "")}/api/v4/users/me`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              return { ok: false, error: `Mattermost returned ${res.status}: ${body.slice(0, 200)}` };
            }
            return { ok: true };
          }

          case "slack": {
            const token = creds["slack-token"];
            if (!token) return { ok: false, error: "Missing bot token" };
            const res = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              signal: AbortSignal.timeout(5000),
            });
            const body = await res.json() as { ok: boolean; error?: string };
            if (!body.ok) return { ok: false, error: body.error || "Auth test failed" };
            return { ok: true };
          }

          case "discord": {
            const token = creds["discord-bot-token"];
            if (!token) return { ok: false, error: "Missing bot token" };
            const res = await fetch("https://discord.com/api/v10/users/@me", {
              headers: { Authorization: `Bot ${token}` },
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
              return { ok: false, error: `Discord returned ${res.status}` };
            }
            return { ok: true };
          }

          case "teams": {
            const webhookUrl = creds["teams-webhook-url"];
            if (!webhookUrl) return { ok: false, error: "Missing webhook URL" };
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
              return { ok: false, error: `Teams webhook returned ${res.status}` };
            }
            return { ok: true };
          }

          default:
            return { ok: false, error: "Unknown platform" };
        }
      } catch (err) {
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
            if (!url || !token || !channel)
              return { ok: false, error: "Missing credentials" };
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
                }),
                signal: AbortSignal.timeout(5000),
              },
            );
            if (!res.ok) return { ok: false, error: `Send failed: ${res.status}` };
            return { ok: true };
          }

          case "slack": {
            const token = creds["slack-token"];
            const channel = creds["slack-channel"];
            if (!token || !channel)
              return { ok: false, error: "Missing credentials" };
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
            if (!body.ok) return { ok: false, error: body.error || "Send failed" };
            return { ok: true };
          }

          case "discord": {
            const token = creds["discord-bot-token"];
            const channelId = creds["discord-channel-id"];
            if (!token || !channelId)
              return { ok: false, error: "Missing credentials" };
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
            if (!res.ok) return { ok: false, error: `Send failed: ${res.status}` };
            return { ok: true };
          }

          case "teams": {
            const webhookUrl = creds["teams-webhook-url"];
            if (!webhookUrl)
              return { ok: false, error: "Missing webhook URL" };
            const res = await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: formatted }),
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return { ok: false, error: `Send failed: ${res.status}` };
            return { ok: true };
          }

          default:
            return { ok: false, error: "Unknown platform" };
        }
      } catch (err) {
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
            const messages: ChatMessage[] = (body.order || [])
              .map((id) => body.posts[id])
              .filter(Boolean)
              .map((post) => ({
                id: `mm-${post.id}`,
                orgId: data.orgId,
                senderId: post.user_id,
                senderName:
                  post.props?.override_username || post.user_id.slice(0, 8),
                text: post.message,
                type: "text" as const,
                timestamp: post.create_at,
              }))
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
