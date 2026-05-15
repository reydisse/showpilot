import { DurableObject } from "cloudflare:workers";
import { getPrisma } from "@/lib/db";
import {
  appendWebhookEvent,
  sanitizePayloadSummary,
  type WebhookEventInput,
} from "@/lib/settings";

interface D1Database {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

interface Env {
  CHAT_RELAY: DurableObjectNamespace;
  DB: D1Database;
}

const normalizeTimerMode = (value: unknown): "count-up" | "count-down" | "clock" => {
  return value === "count-up" || value === "count-down" || value === "clock"
    ? value
    : "count-down";
};

export type ItemType =
  | "segment"
  | "song"
  | "prayer"
  | "announcement"
  | "offering"
  | "custom";

export type ItemStatus = "upcoming" | "live" | "complete";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number; // ms
  notes: string;
  assignee: string;
  cue: string;
  status: ItemStatus;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId?: string;
  actualStart?: string | null; // ISO timestamp
  actualEnd?: string | null;   // ISO timestamp
}

export interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number; // ms
  startedAt: number | null; // timestamp
  pausedAt: number | null;
  mode: "count-up" | "count-down" | "clock";
}

interface PPSlideState {
  text: string;
  notes: string;
  presentationName: string;
  isScripture: boolean;
  updatedAt: number;
}

interface RundownState {
  items: RundownItem[];
  timer: TimerState;
  ppSlide: PPSlideState | null;
  ppPreviewSlide: PPSlideState | null;
  serviceDate?: string;
}

const DEFAULT_TIMER: TimerState = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
};

export class RundownRelay extends DurableObject {
  private state: RundownState = {
    items: [],
    timer: { ...DEFAULT_TIMER },
    ppSlide: null,
    ppPreviewSlide: null,
  };
  private hydrated = false;
  private orgId = "";

  /** Load state from durable storage on first access */
  private async hydrateFromStorage(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;

    const stored = await this.ctx.storage.get<RundownState>("state");
    if (stored) {
      this.state = {
        items: stored.items ?? [],
        timer: stored.timer ?? { ...DEFAULT_TIMER },
        ppSlide: stored.ppSlide ?? null,
        ppPreviewSlide: stored.ppPreviewSlide ?? null,
      };
    }
  }

  /** Persist current state to durable storage (non-blocking) */
  private persistState(): void {
    // ctx.storage.put is automatically batched and doesn't block
    this.ctx.storage.put("state", this.state);
  }

  private async isProPresenterStageDisplayEnabled(): Promise<boolean> {
    if (!this.orgId) return false;

    try {
      const row = await this.env.DB.prepare(
        "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1"
      )
        .bind(this.orgId, "propresenter-stage-display")
        .first<{ value: string | null }>();

      return row?.value === "true";
    } catch {
      return false;
    }
  }

  private logWebhookEvent(event: WebhookEventInput): void {
    if (!this.orgId) return;

    try {
      const prisma = getPrisma();
      void appendWebhookEvent(prisma, this.orgId, event);
    } catch {
      // Intentionally non-blocking telemetry.
    }
  }

  /** Fire-and-forget D1 write for actualStart/actualEnd on a single item. */
  private persistItemTiming(itemId: string, field: "actualStart" | "actualEnd", value: string): void {
    if (!this.orgId || !this.state.serviceDate) return;
    const orgId = this.orgId;
    const serviceDate = this.state.serviceDate;
    const env = this.env as unknown as Env;
    this.ctx.waitUntil(
      env.DB.prepare(
        `UPDATE rundown_item SET ${field} = ? WHERE orgId = ? AND serviceDate = ? AND itemId = ?`
      )
        .bind(value, orgId, serviceDate, itemId)
        .first()
        .catch(() => null),
    );
  }

  async fetch(request: Request): Promise<Response> {
    await this.hydrateFromStorage();
    const url = new URL(request.url);
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;
    const serviceDate = url.searchParams.get("serviceDate");
    if (serviceDate) this.state.serviceDate = serviceDate;

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);

      // Hydrate with current state
      server.send(
        JSON.stringify({ type: "hydrate", state: this.getPublicState() })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      return Response.json(this.getPublicState());
    }

    if (url.pathname === "/command" && request.method === "POST") {
      const body = (await request.json()) as {
        action: string;
        payload?: Record<string, unknown>;
      };
      await this.handleCommand(body.action, body.payload);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    await this.hydrateFromStorage();
    try {
      const parsed = JSON.parse(data as string) as {
        type: string;
        action?: string;
        payload?: Record<string, unknown>;
      };

      if (parsed.type === "ping") {
        // Keepalive — just receiving this prevents hibernation
        return;
      }

      if (parsed.type === "command" && parsed.action) {
        await this.handleCommand(parsed.action, parsed.payload);
      }
    } catch {
      // Ignore
    }
  }

  webSocketClose(_ws: WebSocket) {
    // No manual session tracking needed — using ctx.getWebSockets()
  }

  webSocketError(_ws: WebSocket) {
    // No manual session tracking needed
  }

  private async handleCommand(
    action: string,
    payload?: Record<string, unknown>
  ) {
    const previousPlayback = this.state.timer.playback;
    const previousItemId = this.state.timer.currentItemId;
    const shouldEmitAutomation = action !== "seed";

    switch (action) {
      case "seed": {
        // Seed DO with DB-loaded state
        // Only accept if DO is empty OR force flag is set (e.g. load template)
        const force = payload?.force as boolean;
        if ((this.state.items.length === 0 || force) && payload?.items) {
          this.state.items = payload.items as RundownItem[];
          const t = payload.timer as TimerState | undefined;
          if (t) {
            this.state.timer = {
              playback: t.playback ?? "stop",
              currentItemId: t.currentItemId ?? null,
              elapsed: t.elapsed ?? 0,
              startedAt: t.startedAt ?? null,
              pausedAt: t.pausedAt ?? null,
              mode: normalizeTimerMode(t.mode),
            };
          }
        }
        break;
      }

      case "add-item": {
        const item: RundownItem = {
          id: (payload?.id as string) ?? crypto.randomUUID(),
          title: (payload?.title as string) ?? "Untitled",
          type: (payload?.type as ItemType) ?? "segment",
          duration: (payload?.duration as number) ?? 300000,
          notes: (payload?.notes as string) ?? "",
          assignee: (payload?.assignee as string) ?? "",
          cue: (payload?.cue as string) ?? "",
          status: "upcoming",
          sortOrder: this.state.items.length,
          hardStop: (payload?.hardStop as boolean) ?? false,
          lowerThirdId: payload?.lowerThirdId as string | undefined,
        };
        this.state.items.push(item);
        break;
      }

      case "update-item": {
        const id = payload?.id as string;
        const updates = payload?.updates as Partial<RundownItem>;
        const idx = this.state.items.findIndex((i) => i.id === id);
        if (idx >= 0 && updates) {
          this.state.items[idx] = { ...this.state.items[idx], ...updates };
        }
        break;
      }

      case "remove-item": {
        const id = payload?.id as string;
        this.state.items = this.state.items.filter((i) => i.id !== id);
        break;
      }

      case "reorder": {
        const order = payload?.order as string[];
        if (order) {
          const map = new Map(this.state.items.map((i) => [i.id, i]));
          this.state.items = order
            .map((id) => map.get(id))
            .filter(Boolean) as RundownItem[];
          this.state.items.forEach((item, i) => {
            item.sortOrder = i;
          });
        }
        break;
      }

      case "timer-start": {
        const itemId =
          (payload?.itemId as string) ?? this.state.timer.currentItemId;
        if (itemId) {
          const now = Date.now();
          const nowIso = new Date(now).toISOString();

          if (
            this.state.timer.currentItemId &&
            this.state.timer.currentItemId !== itemId
          ) {
            const prev = this.state.items.find(
              (i) => i.id === this.state.timer.currentItemId
            );
            if (prev) {
              prev.status = "complete";
              if (!prev.actualEnd) {
                prev.actualEnd = nowIso;
                this.persistItemTiming(prev.id, "actualEnd", nowIso);
              }
            }
          }

          const item = this.state.items.find((i) => i.id === itemId);
          if (item) {
            item.status = "live";
            if (!item.actualStart) {
              item.actualStart = nowIso;
              this.persistItemTiming(item.id, "actualStart", nowIso);
            }
          }

          this.state.timer = {
            playback: "play",
            currentItemId: itemId,
            elapsed: this.state.timer.pausedAt
              ? this.state.timer.elapsed
              : 0,
            startedAt: now,
            pausedAt: null,
            mode: this.state.timer.mode,
          };
        }
        break;
      }

      case "timer-resume": {
        // Resume from pause — preserves accumulated elapsed, restarts clock
        if (this.state.timer.playback === "pause") {
          this.state.timer.playback = "play";
          this.state.timer.startedAt = Date.now();
          this.state.timer.pausedAt = null;
        }
        break;
      }

      case "timer-pause": {
        if (this.state.timer.playback === "play") {
          const now = Date.now();
          const additionalElapsed = this.state.timer.startedAt
            ? now - this.state.timer.startedAt
            : 0;
          this.state.timer.elapsed += additionalElapsed;
          this.state.timer.playback = "pause";
          this.state.timer.pausedAt = now;
          this.state.timer.startedAt = null;
        }
        break;
      }

      case "timer-stop": {
        if (this.state.timer.currentItemId) {
          const item = this.state.items.find(
            (i) => i.id === this.state.timer.currentItemId
          );
          if (item) {
            item.status = "complete";
            if (!item.actualEnd) {
              const nowIso = new Date().toISOString();
              item.actualEnd = nowIso;
              this.persistItemTiming(item.id, "actualEnd", nowIso);
            }
          }
        }
        this.state.timer = {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: this.state.timer.mode,
        };
        break;
      }

      case "timer-next": {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const currentIdx = this.state.items.findIndex(
          (i) => i.id === this.state.timer.currentItemId
        );
        if (currentIdx >= 0) {
          const curItem = this.state.items[currentIdx];
          curItem.status = "complete";
          if (!curItem.actualEnd) {
            curItem.actualEnd = nowIso;
            this.persistItemTiming(curItem.id, "actualEnd", nowIso);
          }
        }
        const nextItem = this.state.items.find(
          (_, i) => i > currentIdx && this.state.items[i].status !== "complete"
        );
        if (nextItem) {
          nextItem.status = "live";
          if (!nextItem.actualStart) {
            nextItem.actualStart = nowIso;
            this.persistItemTiming(nextItem.id, "actualStart", nowIso);
          }
          this.state.timer = {
            playback: "play",
            currentItemId: nextItem.id,
            elapsed: 0,
            startedAt: now,
            pausedAt: null,
            mode: this.state.timer.mode,
          };
        } else {
          this.state.timer = {
            playback: "stop",
            currentItemId: null,
            elapsed: 0,
            startedAt: null,
            pausedAt: null,
            mode: this.state.timer.mode,
          };
        }
        break;
      }

      case "timer-prev": {
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const curIdx = this.state.items.findIndex(
          (i) => i.id === this.state.timer.currentItemId
        );
        if (curIdx > 0) {
          if (curIdx >= 0) {
            const curItem = this.state.items[curIdx];
            curItem.status = "upcoming";
            // Clear actualStart so the item can be re-timed cleanly
            curItem.actualStart = null;
            curItem.actualEnd = null;
          }
          const prevItem = this.state.items[curIdx - 1];
          prevItem.status = "live";
          if (!prevItem.actualStart) {
            prevItem.actualStart = nowIso;
            this.persistItemTiming(prevItem.id, "actualStart", nowIso);
          }
          this.state.timer = {
            playback: "play",
            currentItemId: prevItem.id,
            elapsed: 0,
            startedAt: now,
            pausedAt: null,
            mode: this.state.timer.mode,
          };
        }
        break;
      }

      case "timer-adjust": {
        // Add/subtract time from running timer — syncs to all clients
        // Positive deltaMs = add time (reduce elapsed), negative = subtract time
        // Negative elapsed = extra time added beyond item duration
        const deltaMs = payload?.deltaMs as number;
        if (typeof deltaMs !== "number") break;

        if (this.state.timer.playback === "play" && this.state.timer.startedAt) {
          const currentElapsed = this.state.timer.elapsed + (Date.now() - this.state.timer.startedAt);
          this.state.timer.elapsed = currentElapsed - deltaMs;
          this.state.timer.startedAt = Date.now();
        } else if (this.state.timer.playback === "pause") {
          this.state.timer.elapsed = this.state.timer.elapsed - deltaMs;
        }
        break;
      }

      case "timer-mode": {
        this.state.timer.mode = normalizeTimerMode(payload?.mode);
        break;
      }

      case "pp-slide": {
        const slide = payload?.slide as PPSlideState | null;
        const enabled = await this.isProPresenterStageDisplayEnabled();
        this.state.ppSlide = enabled && slide ? { ...slide, updatedAt: Date.now() } : null;
        break;
      }

      case "pp-preview": {
        const slide = payload?.slide as PPSlideState | null;
        this.state.ppPreviewSlide = slide ? { ...slide, updatedAt: Date.now() } : null;
        break;
      }

      case "reset": {
        this.state.items.forEach((item) => {
          item.status = "upcoming";
          item.actualStart = null;
          item.actualEnd = null;
        });
        this.state.timer = {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: this.state.timer.mode,
        };
        break;
      }

      default:
        return;
    }

    this.persistState();
    this.broadcastState();

    const currentItemId = this.state.timer.currentItemId;
    if (shouldEmitAutomation && previousPlayback === "stop" && this.state.timer.playback === "play") {
      void this.sendAutomationChatMessage("Show is live", "system");
    }
    if (shouldEmitAutomation && currentItemId && currentItemId !== previousItemId) {
      const currentItem = this.state.items.find((item) => item.id === currentItemId);
      if (currentItem?.title?.trim()) {
        void this.sendAutomationChatMessage(`Now live: ${currentItem.title.trim()}`, "system");
      }
      if (currentItem?.cue?.trim()) {
        void this.sendAutomationChatMessage(currentItem.cue.trim(), "cue");
      }
    }
  }

  private async sendAutomationChatMessage(text: string, type: "cue" | "system") {
    if (!this.orgId || !text.trim()) return;

    try {
      const env = this.env as unknown as Env;
      const settingsResult = await env.DB.prepare(
        "SELECT key, value FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          this.orgId,
          "chat-adapter",
          "mattermost-url",
          "mattermost-token",
          "mattermost-channel",
          "slack-token",
          "slack-channel",
          "discord-bot-token",
          "discord-channel-id",
          "teams-webhook-url",
          "api-key"
        )
        .all<{ key: string; value: string }>();

      const settings = Object.fromEntries(
        (settingsResult.results || []).map((row) => [row.key, row.value])
      ) as Record<string, string>;

      const adapter = settings["chat-adapter"] || "native";
      const senderName = "ShowPilot";
      const prefix = type === "cue" ? "[CUE] " : "";
      const formatted = `**${senderName}**: ${prefix}${text}`;
      const payloadSummary = sanitizePayloadSummary({
        source: senderName,
        type,
        text,
      });

        if (adapter === "mattermost") {
          const url = settings["mattermost-url"];
          const token = settings["mattermost-token"];
          const channel = settings["mattermost-channel"];
          if (url && token && channel) {
          const res = await fetch(`${url.replace(/\/$/, "")}/api/v4/posts`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              channel_id: channel,
              message: formatted,
              props: {
                override_username: senderName,
                showpilot_type: type,
              },
            }),
          });
          if (!res.ok) {
            this.logWebhookEvent({
              source: "rundown-relay",
              type: "mattermost-send",
              direction: "outgoing",
              status: "error",
              details: `Mattermost automation send failed with ${res.status}`,
              payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "mattermost-send",
            direction: "outgoing",
            status: "success",
            details: "Automation message sent to Mattermost.",
            payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "mattermost-send",
            direction: "outgoing",
            status: "warning",
            details: "Mattermost adapter enabled but credentials are incomplete. Falling back to native chat relay.",
            payloadSummary,
          });
        }

        if (adapter === "slack") {
          const token = settings["slack-token"];
          const channel = settings["slack-channel"];
          if (token && channel) {
          const res = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ channel, text: formatted }),
          });
          const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || body?.ok === false) {
            this.logWebhookEvent({
              source: "rundown-relay",
              type: "slack-send",
              direction: "outgoing",
              status: "error",
              details:
                body?.error ||
                `Slack automation send failed with ${res.status}`,
              payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "slack-send",
            direction: "outgoing",
            status: "success",
            details: "Automation message sent to Slack.",
            payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "slack-send",
            direction: "outgoing",
            status: "warning",
            details: "Slack adapter enabled but credentials are incomplete. Falling back to native chat relay.",
            payloadSummary,
          });
        }

        if (adapter === "discord") {
          const token = settings["discord-bot-token"];
          const channelId = settings["discord-channel-id"];
          if (token && channelId) {
          const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bot ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ content: formatted }),
          });
          if (!res.ok) {
            this.logWebhookEvent({
              source: "rundown-relay",
              type: "discord-send",
              direction: "outgoing",
              status: "error",
              details: `Discord automation send failed with ${res.status}`,
              payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "discord-send",
            direction: "outgoing",
            status: "success",
            details: "Automation message sent to Discord.",
            payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "discord-send",
            direction: "outgoing",
            status: "warning",
            details: "Discord adapter enabled but credentials are incomplete. Falling back to native chat relay.",
            payloadSummary,
          });
        }

        if (adapter === "teams") {
          const webhookUrl = settings["teams-webhook-url"];
          if (webhookUrl) {
          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: formatted }),
          });
          if (!res.ok) {
            this.logWebhookEvent({
              source: "rundown-relay",
              type: "teams-send",
              direction: "outgoing",
              status: "error",
              details: `Teams automation send failed with ${res.status}`,
              payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "teams-send",
            direction: "outgoing",
            status: "success",
            details: "Automation message sent to Teams.",
            payloadSummary,
            });
            return;
          }

          this.logWebhookEvent({
            source: "rundown-relay",
            type: "teams-send",
            direction: "outgoing",
            status: "warning",
            details: "Teams adapter enabled but webhook URL is missing. Falling back to native chat relay.",
            payloadSummary,
          });
        }

      const chatId = env.CHAT_RELAY.idFromName(this.orgId);
      const chatStub = env.CHAT_RELAY.get(chatId);
      const relayResponse = await chatStub.fetch(
        new Request("https://chat.local/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orgId: this.orgId,
            senderName,
            senderRole: "System",
            text,
            type,
          }),
        })
      );

      if (!relayResponse.ok) {
        this.logWebhookEvent({
          source: "rundown-relay",
          type: "chat-relay-send",
          direction: "outgoing",
          status: "error",
          details: `Native relay send failed with ${relayResponse.status}`,
          payloadSummary,
        });
        return;
      }

      this.logWebhookEvent({
        source: "rundown-relay",
        type: "chat-relay-send",
        direction: "outgoing",
        status: "success",
        details: "Automation message routed to native chat relay.",
        payloadSummary,
      });
    } catch (err) {
      console.error("[RundownRelay] failed to send automation chat message", err);
      this.logWebhookEvent({
        source: "rundown-relay",
        type: "automation-chat-error",
        direction: "outgoing",
        status: "error",
        details: err instanceof Error
          ? `Automation chat send failed: ${err.message}`
          : "Automation chat send failed.",
        payloadSummary: sanitizePayloadSummary({
          text,
          type,
        }),
      });
    }
  }

  private getPublicState() {
    return {
      items: this.state.items,
      timer: {
        ...this.state.timer,
        serverTime: Date.now(),
      },
      ppSlide: this.state.ppSlide,
      ppPreviewSlide: this.state.ppPreviewSlide,
    };
  }

  private broadcastState() {
    const data = JSON.stringify({
      type: "state",
      state: this.getPublicState(),
    });
    // Use ctx.getWebSockets() instead of manual Set — survives hibernation
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Dead socket — Cloudflare will clean it up
      }
    }
  }
}
