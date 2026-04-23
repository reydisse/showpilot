import { DurableObject } from "cloudflare:workers";

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
}

export interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number; // ms
  startedAt: number | null; // timestamp
  pausedAt: number | null;
  mode: "count-up" | "count-down";
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

  async fetch(request: Request): Promise<Response> {
    await this.hydrateFromStorage();
    const url = new URL(request.url);
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;

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
      this.handleCommand(body.action, body.payload);
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
        this.handleCommand(parsed.action, parsed.payload);
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

  private handleCommand(
    action: string,
    payload?: Record<string, unknown>
  ) {
    const previousPlayback = this.state.timer.playback;
    const previousItemId = this.state.timer.currentItemId;

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
              mode: t.mode ?? "count-down",
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
          if (
            this.state.timer.currentItemId &&
            this.state.timer.currentItemId !== itemId
          ) {
            const prev = this.state.items.find(
              (i) => i.id === this.state.timer.currentItemId
            );
            if (prev) prev.status = "complete";
          }

          const item = this.state.items.find((i) => i.id === itemId);
          if (item) item.status = "live";

          this.state.timer = {
            playback: "play",
            currentItemId: itemId,
            elapsed: this.state.timer.pausedAt
              ? this.state.timer.elapsed
              : 0,
            startedAt: Date.now(),
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
          if (item) item.status = "complete";
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
        const currentIdx = this.state.items.findIndex(
          (i) => i.id === this.state.timer.currentItemId
        );
        if (currentIdx >= 0) {
          this.state.items[currentIdx].status = "complete";
        }
        const nextItem = this.state.items.find(
          (_, i) => i > currentIdx && this.state.items[i].status !== "complete"
        );
        if (nextItem) {
          nextItem.status = "live";
          this.state.timer = {
            playback: "play",
            currentItemId: nextItem.id,
            elapsed: 0,
            startedAt: Date.now(),
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
        // Go back to previous item — reset current to "upcoming", start previous
        const curIdx = this.state.items.findIndex(
          (i) => i.id === this.state.timer.currentItemId
        );
        if (curIdx > 0) {
          // Reset current item to upcoming (not complete — we're going backward)
          if (curIdx >= 0) {
            this.state.items[curIdx].status = "upcoming";
          }
          const prevItem = this.state.items[curIdx - 1];
          prevItem.status = "live";
          this.state.timer = {
            playback: "play",
            currentItemId: prevItem.id,
            elapsed: 0,
            startedAt: Date.now(),
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
        this.state.timer.mode =
          (payload?.mode as "count-up" | "count-down") ?? "count-down";
        break;
      }

      case "pp-slide": {
        const slide = payload?.slide as PPSlideState | null;
        this.state.ppSlide = slide ? { ...slide, updatedAt: Date.now() } : null;
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
    if (previousPlayback === "stop" && this.state.timer.playback === "play") {
      void this.sendAutomationChatMessage("Show is live", "system");
    }
    if (currentItemId && currentItemId !== previousItemId) {
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

      if (adapter === "mattermost") {
        const url = settings["mattermost-url"];
        const token = settings["mattermost-token"];
        const channel = settings["mattermost-channel"];
        if (url && token && channel) {
          await fetch(`${url.replace(/\/$/, "")}/api/v4/posts`, {
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
          return;
        }
      }

      if (adapter === "slack") {
        const token = settings["slack-token"];
        const channel = settings["slack-channel"];
        if (token && channel) {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ channel, text: formatted }),
          });
          return;
        }
      }

      if (adapter === "discord") {
        const token = settings["discord-bot-token"];
        const channelId = settings["discord-channel-id"];
        if (token && channelId) {
          await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bot ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ content: formatted }),
          });
          return;
        }
      }

      if (adapter === "teams") {
        const webhookUrl = settings["teams-webhook-url"];
        if (webhookUrl) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: formatted }),
          });
          return;
        }
      }

      const chatId = env.CHAT_RELAY.idFromName(this.orgId);
      const chatStub = env.CHAT_RELAY.get(chatId);
      await chatStub.fetch(
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
    } catch (err) {
      console.error("[RundownRelay] failed to send automation chat message", err);
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
