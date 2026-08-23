import { DurableObject } from "cloudflare:workers";
import { chatRelayKey } from "../lib/chat-relay-key";
import { getPrisma } from "@/lib/db";
import {
  appendWebhookEvent,
  sanitizePayloadSummary,
  type WebhookEventInput,
} from "@/lib/settings";
import { classifyRelayCommand } from "@/lib/rundown-command-protocol";

interface D1Database {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
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
  | "header"
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
  stageMessage: string;
  serviceDate?: string;
  showId?: string;
  revision: number;
  recentCommandIds: string[];
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
    stageMessage: "",
    revision: 0,
    recentCommandIds: [],
  };
  private hydrated = false;
  private hydrationPromise: Promise<void> | null = null;
  private orgId = "";

  /** Load state from durable storage on first access */
  private async hydrateFromStorage(): Promise<void> {
    if (this.hydrated) return;
    if (!this.hydrationPromise) {
      this.hydrationPromise = (async () => {
        const stored = await this.ctx.storage.get<RundownState>("state");
        if (stored) {
          this.state = {
            items: stored.items ?? [],
            timer: stored.timer ?? { ...DEFAULT_TIMER },
            ppSlide: stored.ppSlide ?? null,
            ppPreviewSlide: stored.ppPreviewSlide ?? null,
            stageMessage: stored.stageMessage ?? "",
            serviceDate: stored.serviceDate,
            showId: stored.showId,
            revision: Number.isFinite(stored.revision) ? stored.revision : 0,
            recentCommandIds: Array.isArray(stored.recentCommandIds)
              ? stored.recentCommandIds.slice(-100)
              : [],
          };
        }
        this.hydrated = true;
      })().finally(() => {
        this.hydrationPromise = null;
      });
    }
    await this.hydrationPromise;
  }

  /** Persist the authoritative state before any client sees the revision. */
  private async persistState(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  private persistRuntimeSnapshot(action: string): void {
    if (!this.orgId || (!this.state.showId && !this.state.serviceDate)) return;
    const key = `rundown-timer:${this.state.showId ?? this.state.serviceDate}`;
    const value = JSON.stringify({ ...this.state.timer, serverTime: Date.now() });
    const env = this.env as unknown as Env;
    const writes: Promise<unknown>[] = [
      env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      )
        .bind(crypto.randomUUID(), this.orgId, key, value)
        .run(),
    ];

    if (action === "clear-all") {
      writes.push(
        (this.state.showId
          ? env.DB.prepare(
              "DELETE FROM rundown_item WHERE orgId = ? AND showId = ?",
            ).bind(this.orgId, this.state.showId)
          : env.DB.prepare(
              "DELETE FROM rundown_item WHERE orgId = ? AND showId IS NULL AND serviceDate = ?",
            ).bind(this.orgId, this.state.serviceDate))
          .run(),
      );
    } else {
      for (const item of this.state.items) {
        writes.push(
          (this.state.showId
            ? env.DB.prepare(
                `UPDATE rundown_item
                    SET status = ?, actualStart = ?, actualEnd = ?, updatedAt = CURRENT_TIMESTAMP
                  WHERE orgId = ? AND showId = ? AND itemId = ?`,
              ).bind(
                item.status,
                item.actualStart ?? null,
                item.actualEnd ?? null,
                this.orgId,
                this.state.showId,
                item.id,
              )
            : env.DB.prepare(
                `UPDATE rundown_item
                    SET status = ?, actualStart = ?, actualEnd = ?, updatedAt = CURRENT_TIMESTAMP
                  WHERE orgId = ? AND showId IS NULL AND serviceDate = ? AND itemId = ?`,
              ).bind(
                item.status,
                item.actualStart ?? null,
                item.actualEnd ?? null,
                this.orgId,
                this.state.serviceDate,
                item.id,
              ))
            .run(),
        );
      }
    }

    this.ctx.waitUntil(
      Promise.all(writes).catch((error) =>
        console.error("[RundownRelay] runtime persistence failed", error),
      ),
    );
  }

  private persistActiveShow(): void {
    if (!this.orgId || !this.state.serviceDate) return;
    const env = this.env as unknown as Env;
    const writes = [
      env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, 'active-service-date', ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(crypto.randomUUID(), this.orgId, this.state.serviceDate).run(),
    ];
    if (this.state.showId) {
      writes.push(
        env.DB.prepare(
          `INSERT INTO app_setting (id, orgId, key, value)
           VALUES (?, ?, 'active-show-id', ?)
           ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
        ).bind(crypto.randomUUID(), this.orgId, this.state.showId).run(),
      );
    }
    this.ctx.waitUntil(
      Promise.all(writes).catch((error) =>
        console.error("[RundownRelay] active show persistence failed", error),
      ),
    );
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
    if (!this.orgId || (!this.state.showId && !this.state.serviceDate)) return;
    const orgId = this.orgId;
    const serviceDate = this.state.serviceDate;
    const showId = this.state.showId;
    const env = this.env as unknown as Env;
    this.ctx.waitUntil(
      (showId
        ? env.DB.prepare(
            `UPDATE rundown_item SET ${field} = ? WHERE orgId = ? AND showId = ? AND itemId = ?`,
          ).bind(value, orgId, showId, itemId)
        : env.DB.prepare(
            `UPDATE rundown_item SET ${field} = ? WHERE orgId = ? AND serviceDate = ? AND itemId = ?`,
          ).bind(value, orgId, serviceDate, itemId))
        .first()
        .catch(() => null),
    );
  }

  async fetch(request: Request): Promise<Response> {
    await this.hydrateFromStorage();
    const url = new URL(request.url);
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;
    const serviceDate = url.searchParams.get("serviceDate");
    const showId = url.searchParams.get("showId");
    const access = url.searchParams.get("access");
    if (
      access === "write" &&
      ((showId && showId !== this.state.showId) ||
        (!showId && serviceDate && serviceDate !== this.state.serviceDate))
    ) {
      // A room is active for one service at a time. Relabelling the old
      // rows as a newly opened date made the cue sheet show a hybrid of
      // two services. Empty first; the editor then seeds this date's D1 rows.
      this.state.serviceDate = serviceDate ?? undefined;
      this.state.showId = showId ?? undefined;
      this.state.items = [];
      this.state.timer = { ...DEFAULT_TIMER };
      this.state.revision += 1;
      this.state.recentCommandIds = [];
      await this.persistState();
    }

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({
        canWrite: access === "write",
        canObserve: access === "observe",
        orgId: this.orgId,
        serviceDate: serviceDate ?? null,
        showId: showId ?? null,
      });

      // Hydrate with current state
      server.send(
        JSON.stringify({
          type: "hydrate",
          state: access === "write" || access === "observe"
            ? this.getPublicState()
            : this.getDisplayState(),
        })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      return Response.json(
        access === "read" ? this.getDisplayState() : this.getPublicState(),
      );
    }

    if (url.pathname === "/command" && request.method === "POST") {
      if (url.searchParams.get("access") === "read") {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = (await request.json()) as {
        action: string;
        payload?: Record<string, unknown>;
      };
      const accepted = await this.handleCommand(body.action, body.payload);
      return Response.json(
        { ok: accepted, revision: this.state.revision },
        { status: accepted ? 200 : 400 },
      );
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    await this.hydrateFromStorage();
    try {
      const parsed = JSON.parse(data as string) as {
        type: string;
        id?: string;
        expectedRevision?: number;
        action?: string;
        payload?: Record<string, unknown>;
      };

      if (parsed.type === "ping") {
        // Keepalive — just receiving this prevents hibernation
        return;
      }

      if (parsed.type === "command" && parsed.action) {
        const attachment = ws.deserializeAttachment?.() as {
          canWrite?: boolean;
          orgId?: string;
        } | null;
        if (!attachment?.canWrite) return;
        if (attachment.orgId) this.orgId = attachment.orgId;

        const decision = classifyRelayCommand(
          this.state.revision,
          this.state.recentCommandIds,
          parsed.id,
          parsed.expectedRevision,
        );
        if (decision === "duplicate") {
          ws.send(JSON.stringify({
            type: "command-result",
            id: parsed.id,
            accepted: true,
            duplicate: true,
            revision: this.state.revision,
          }));
          return;
        }

        if (decision === "revision-conflict") {
          this.sendStateToSocket(ws);
          ws.send(JSON.stringify({
            type: "command-result",
            id: parsed.id,
            accepted: false,
            reason: "revision-conflict",
            revision: this.state.revision,
          }));
          return;
        }

        const accepted = await this.handleCommand(parsed.action, parsed.payload, parsed.id);
        ws.send(JSON.stringify({
          type: "command-result",
          id: parsed.id,
          accepted,
          reason: accepted ? undefined : "invalid-command",
          revision: this.state.revision,
        }));
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
    payload?: Record<string, unknown>,
    commandId?: string,
  ): Promise<boolean> {
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
        const requestedItem = this.state.items.find((item) => item.id === itemId);
        if (itemId && requestedItem?.type !== "header") {
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
        // Section bands are not running order — advancing onto one would
        // put a heading "live" and stop the clock on a real segment.
        const nextItem = this.state.items.find(
          (item, i) =>
            i > currentIdx && item.status !== "complete" && item.type !== "header"
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
        // Step back over any section bands sitting between the two
        // segments, for the same reason as timer-next.
        let prevIdx = curIdx - 1;
        while (prevIdx >= 0 && this.state.items[prevIdx].type === "header") prevIdx--;
        if (curIdx > 0 && prevIdx >= 0) {
          if (curIdx >= 0) {
            const curItem = this.state.items[curIdx];
            curItem.status = "upcoming";
            // Clear actualStart so the item can be re-timed cleanly
            curItem.actualStart = null;
            curItem.actualEnd = null;
          }
          const prevItem = this.state.items[prevIdx];
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

      case "clear-all": {
        this.state.items = [];
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

      case "stage-message": {
        const msg = payload?.message;
        this.state.stageMessage = typeof msg === "string" ? msg : "";
        break;
      }

      case "stage-clear": {
        this.state.stageMessage = "";
        break;
      }

      default:
        return false;
    }

    this.state.revision += 1;
    if (commandId) {
      this.state.recentCommandIds = [...this.state.recentCommandIds, commandId].slice(-100);
    }
    await this.persistState();
    this.broadcastState();

    if (action.startsWith("timer-") || action === "reset" || action === "clear-all" || action === "seed") {
      this.persistRuntimeSnapshot(action);
    }
    if (previousPlayback === "stop" && this.state.timer.playback === "play") {
      this.persistActiveShow();
    }

    const currentItemId = this.state.timer.currentItemId;
    if (shouldEmitAutomation && previousPlayback === "stop" && this.state.timer.playback === "play") {
      void this.sendAutomationChatMessage("Show is live", "system");
    }
    if (shouldEmitAutomation && currentItemId && currentItemId !== previousItemId) {
      const currentItem = this.state.items.find((item) => item.id === currentItemId);
      if (currentItem?.title?.trim()) {
        void this.sendAutomationChatMessage(`Now live: ${currentItem.title.trim()}`, "system");
      }
    }
    return true;
  }

  private async sendAutomationChatMessage(text: string, type: "system") {
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
      const formatted = `**${senderName}**: ${text}`;
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

			const chatId = env.CHAT_RELAY.idFromName(chatRelayKey(this.orgId, "production"));
      const chatStub = env.CHAT_RELAY.get(chatId);
      const relayResponse = await chatStub.fetch(
        new Request("https://chat.local/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						orgId: this.orgId,
						roomId: "production",
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
      // Which service these items belong to. The room is per org, not
      // per date, so anything reading it without also driving it — the
      // cue sheet — has to be able to tell whether the state on the wire
      // is even about the service on screen.
      serviceDate: this.state.serviceDate ?? null,
      showId: this.state.showId ?? null,
      revision: this.state.revision,
      items: this.state.items,
      timer: {
        ...this.state.timer,
        serverTime: Date.now(),
      },
      ppSlide: this.state.ppSlide,
      ppPreviewSlide: this.state.ppPreviewSlide,
      stageMessage: this.state.stageMessage,
    };
  }

  /** Minimum state needed by the intentionally public confidence timer. */
  private getDisplayState() {
    return {
      serviceDate: this.state.serviceDate ?? null,
      showId: this.state.showId ?? null,
      revision: this.state.revision,
      items: this.state.items.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        duration: item.duration,
        status: item.status,
        sortOrder: item.sortOrder,
        hardStop: item.hardStop,
      })),
      timer: { ...this.state.timer, serverTime: Date.now() },
      ppSlide: this.state.ppSlide,
      stageMessage: this.state.stageMessage,
    };
  }

  private sendStateToSocket(ws: WebSocket) {
    const attachment = ws.deserializeAttachment?.() as {
      canWrite?: boolean;
      canObserve?: boolean;
    } | null;
    ws.send(JSON.stringify({
      type: "state",
      state: attachment?.canWrite || attachment?.canObserve
        ? this.getPublicState()
        : this.getDisplayState(),
    }));
  }

  private broadcastState() {
    // Use ctx.getWebSockets() instead of manual Set — survives hibernation
    for (const ws of this.ctx.getWebSockets()) {
      try {
        this.sendStateToSocket(ws);
      } catch {
        // Dead socket — Cloudflare will clean it up
      }
    }
  }
}
