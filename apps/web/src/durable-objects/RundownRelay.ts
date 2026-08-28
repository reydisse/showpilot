import { DurableObject } from "cloudflare:workers";
import { chatRelayKey } from "../lib/chat-relay-key";
import { getPrisma } from "@/lib/db";
import {
  appendWebhookEvent,
  sanitizePayloadSummary,
  type WebhookEventInput,
} from "@/lib/settings";
import {
  canApplyRundownRelayAction,
  classifyRelayCommand,
  parseRundownRelayHttpCommand,
  type RundownRelayWriteAccess,
} from "@/lib/rundown-command-protocol";
import {
  inferRundownRelayInitialized,
  shouldAcceptRundownSeed,
} from "@/lib/rundown-relay-initialization";
import {
  parseExactRelayOrder,
  parseRelayItemUpdates,
  parseRelayPPSlide,
  parseRelayRundownItem,
  parseRelayRundownItems,
  parseRelayTimer,
} from "@/lib/rundown-relay-payload";
import { SerialCommandExecutor } from "@/lib/serial-command-executor";
import { persistedRundownStatus } from "@/lib/rundown-status";

interface D1BoundStatement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(sql: string): {
    bind(...params: unknown[]): D1BoundStatement;
  };
  batch(statements: D1BoundStatement[]): Promise<unknown[]>;
}

interface Env {
  CHAT_RELAY: DurableObjectNamespace;
  DB: D1Database;
}

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
  scheduledStart?: string | null;
  expectedEnd?: string | null;
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
  initialized: boolean;
  items: RundownItem[];
  timer: TimerState;
  ppSlide: PPSlideState | null;
  ppPreviewSlide: PPSlideState | null;
  stageMessage: string;
  serviceDate?: string;
  showId?: string;
  serviceName?: string;
  scheduledStartTime?: string | null;
  location?: string;
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
    initialized: false,
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
  private readonly commands = new SerialCommandExecutor();

  /** Load state from durable storage on first access */
  private async hydrateFromStorage(): Promise<void> {
    if (this.hydrated) return;
    if (!this.hydrationPromise) {
      this.hydrationPromise = (async () => {
        const stored = await this.ctx.storage.get<RundownState>("state");
        if (stored) {
          this.state = {
            initialized: inferRundownRelayInitialized(stored),
            items: stored.items ?? [],
            timer: stored.timer ?? { ...DEFAULT_TIMER },
            ppSlide: stored.ppSlide ?? null,
            ppPreviewSlide: stored.ppPreviewSlide ?? null,
            stageMessage: stored.stageMessage ?? "",
            serviceDate: stored.serviceDate,
            showId: stored.showId,
            serviceName: stored.serviceName,
            scheduledStartTime: stored.scheduledStartTime,
            location: stored.location,
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

  private cloneState(): RundownState {
    return {
      ...this.state,
      items: this.state.items.map((item) => ({ ...item })),
      timer: { ...this.state.timer },
      ppSlide: this.state.ppSlide ? { ...this.state.ppSlide } : null,
      ppPreviewSlide: this.state.ppPreviewSlide ? { ...this.state.ppPreviewSlide } : null,
      recentCommandIds: [...this.state.recentCommandIds],
    };
  }

  /** Persist in the same serialized order in which relay commands are accepted. */
  private async persistAuthoritativeSnapshot(action: string, previousState: RundownState): Promise<void> {
    if (!this.orgId || (!this.state.showId && !this.state.serviceDate)) return;
    const persistsFullItems = action === "seed"
      || action === "add-item"
      || action === "update-item"
      || action === "remove-item"
      || action === "reorder"
      || action === "reset"
      || action === "clear-all";
    const persistsTimer = persistsFullItems || action.startsWith("timer-");
    const persistsMessage = action === "stage-message" || action === "stage-clear";
    const persistsMeta = action === "update-meta"
      || action === "seed" && this.state.serviceName !== undefined;
    if (!persistsTimer && !persistsMessage && !persistsMeta) return;

    const env = this.env as unknown as Env;
    const identity = this.state.showId ?? this.state.serviceDate;
    const statements: D1BoundStatement[] = [];

    if (persistsTimer) {
      statements.push(env.DB.prepare(
        `INSERT INTO app_setting (id, orgId, key, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
      ).bind(
        crypto.randomUUID(),
        this.orgId,
        `rundown-timer:${identity}`,
        JSON.stringify({ ...this.state.timer, serverTime: Date.now() }),
      ));
      if (this.state.showId) {
        statements.push(env.DB.prepare(
          "UPDATE rundown SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?",
        ).bind(
          persistedRundownStatus(this.state.timer.playback),
          this.state.showId,
          this.orgId,
        ));
      }
    }

    if (persistsFullItems) {
      const serializedItems = JSON.stringify(this.state.items);
      if (new TextEncoder().encode(serializedItems).byteLength > 1_500_000) {
        throw new Error("Rundown snapshot exceeds the durable storage boundary.");
      }
      statements.push(
        env.DB.prepare(
          `INSERT INTO app_setting (id, orgId, key, value)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
        ).bind(
          crypto.randomUUID(),
          this.orgId,
          `rundown-items:${identity}`,
          serializedItems,
        ),
        this.state.showId
          ? env.DB.prepare("DELETE FROM rundown_item WHERE orgId = ? AND showId = ?")
              .bind(this.orgId, this.state.showId)
          : env.DB.prepare(
              "DELETE FROM rundown_item WHERE orgId = ? AND showId IS NULL AND serviceDate = ?",
            ).bind(this.orgId, this.state.serviceDate),
      );

      if (this.state.items.length > 0) {
        const rowSql = `(${Array.from({ length: 19 }, () => "?").join(", ")}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
        // D1 permits 100 bound parameters per statement. Five 19-field rows
        // stay below that boundary while the surrounding batch remains atomic.
        for (let offset = 0; offset < this.state.items.length; offset += 5) {
          const chunk = this.state.items.slice(offset, offset + 5);
          const values = chunk.flatMap((item, chunkIndex) => [
            crypto.randomUUID(),
            this.orgId,
            this.state.showId ?? null,
            this.state.serviceDate,
            item.id,
            item.title,
            item.type,
            item.duration,
            item.notes,
            item.assignee,
            item.cue,
            item.status,
            offset + chunkIndex,
            item.hardStop,
            item.lowerThirdId ?? null,
            item.scheduledStart ?? null,
            item.expectedEnd ?? null,
            item.actualStart ?? null,
            item.actualEnd ?? null,
          ]);
          statements.push(env.DB.prepare(
            `INSERT INTO rundown_item (
               id, orgId, showId, serviceDate, itemId, title, type, duration,
               notes, assignee, cue, status, sortOrder, hardStop, lowerThirdId,
               scheduledStart, expectedEnd, actualStart, actualEnd, createdAt, updatedAt
             ) VALUES ${chunk.map(() => rowSql).join(", ")}`,
          ).bind(...values));
        }
      }
    } else if (action.startsWith("timer-")) {
      const previousItems = new Map(previousState.items.map((item) => [item.id, item]));
      for (const item of this.state.items) {
        const previous = previousItems.get(item.id);
        if (
          previous
          && previous.status === item.status
          && previous.actualStart === item.actualStart
          && previous.actualEnd === item.actualEnd
        ) continue;
        statements.push(
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
              )),
        );
      }
    }

    if (persistsMeta && this.state.showId) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (this.state.serviceName !== previousState.serviceName && this.state.serviceName !== undefined) {
        assignments.push("name = ?");
        values.push(this.state.serviceName);
      }
      if (this.state.scheduledStartTime !== previousState.scheduledStartTime && this.state.scheduledStartTime !== undefined) {
        assignments.push("scheduledStartTime = ?");
        values.push(this.state.scheduledStartTime);
      }
      if (this.state.location !== previousState.location && this.state.location !== undefined) {
        assignments.push("location = ?");
        values.push(this.state.location);
      }
      if (assignments.length > 0) {
        statements.push(env.DB.prepare(
          `UPDATE rundown SET ${assignments.join(", ")}, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND orgId = ?`,
        ).bind(...values, this.state.showId, this.orgId));
      }
    }

    if (persistsMessage) {
      if (this.state.stageMessage) {
        statements.push(env.DB.prepare(
          `INSERT INTO app_setting (id, orgId, key, value)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
        ).bind(
          crypto.randomUUID(),
          this.orgId,
          `rundown-message:${identity}`,
          this.state.stageMessage,
        ));
      } else {
        statements.push(env.DB.prepare(
          "DELETE FROM app_setting WHERE orgId = ? AND key = ?",
        ).bind(this.orgId, `rundown-message:${identity}`));
      }
    }

    // A metadata command can be valid yet make no durable change (for
    // example, saving an unchanged show title). Avoid depending on whether a
    // runtime accepts an empty D1 batch.
    if (statements.length === 0) return;
    await env.DB.batch(statements);
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

  async fetch(request: Request): Promise<Response> {
    await this.hydrateFromStorage();
    const url = new URL(request.url);
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;
    const serviceDate = url.searchParams.get("serviceDate");
    const showId = url.searchParams.get("showId");
    const access = url.searchParams.get("access");
    if (
      (access === "edit" || access === "control") &&
      ((showId && showId !== this.state.showId) ||
        (!showId && serviceDate && serviceDate !== this.state.serviceDate))
    ) {
      // A room is active for one service at a time. Relabelling the old
      // rows as a newly opened date made the cue sheet show a hybrid of
      // two services. Empty first; the editor then seeds this date's D1 rows.
      this.state.serviceDate = serviceDate ?? undefined;
      this.state.showId = showId ?? undefined;
      this.state.serviceName = undefined;
      this.state.scheduledStartTime = undefined;
      this.state.location = undefined;
      this.state.initialized = false;
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
        writeAccess: access === "edit" || access === "control" ? access : null,
        canObserve: access === "observe",
        orgId: this.orgId,
        serviceDate: serviceDate ?? null,
        showId: showId ?? null,
      });

      // Hydrate with current state
      server.send(
        JSON.stringify({
          type: "hydrate",
          state: access === "edit" || access === "control" || access === "observe"
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
      if (access !== "edit" && access !== "control") {
        return new Response("Unauthorized", { status: 401 });
      }
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return Response.json({ ok: false, reason: "invalid-command" }, { status: 400 });
      }
      const body = parseRundownRelayHttpCommand(rawBody);
      if (!body || !canApplyRundownRelayAction(access, body.action)) {
        return Response.json({ ok: false, reason: "invalid-command" }, { status: 400 });
      }
      return this.commands.run(async () => {
        const decision = classifyRelayCommand(
          this.state.revision,
          this.state.recentCommandIds,
          body.id,
          body.expectedRevision,
        );
        if (decision === "duplicate") {
          return Response.json({ ok: true, duplicate: true, revision: this.state.revision });
        }
        if (decision === "revision-conflict") {
          return Response.json({
            ok: false,
            reason: "revision-conflict",
            revision: this.state.revision,
            state: this.getPublicState(),
          }, { status: 409 });
        }
        const accepted = await this.handleCommand(body.action, body.payload, body.id);
        return Response.json(
          {
            ok: accepted,
            reason: accepted ? undefined : "invalid-command",
            revision: this.state.revision,
            state: accepted ? this.getPublicState() : undefined,
          },
          { status: accepted ? 200 : 400 },
        );
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    await this.hydrateFromStorage();
    try {
      const raw: unknown = JSON.parse(data as string);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      if ((raw as Record<string, unknown>).type === "ping") {
        // Keepalive — just receiving this prevents hibernation
        return;
      }
      if ((raw as Record<string, unknown>).type === "command") {
        // WebSocket messages cross the same untrusted boundary as HTTP
        // commands. Parse both through one envelope contract before touching
        // authoritative state.
        const parsed = parseRundownRelayHttpCommand(raw);
        if (!parsed) {
          ws.send(JSON.stringify({
            type: "command-result",
            accepted: false,
            reason: "invalid-command",
            revision: this.state.revision,
          }));
          return;
        }
        const attachment = ws.deserializeAttachment?.() as {
          writeAccess?: RundownRelayWriteAccess | null;
          orgId?: string;
        } | null;
        if (!attachment?.writeAccess) return;
        if (attachment.orgId) this.orgId = attachment.orgId;
        if (!canApplyRundownRelayAction(attachment.writeAccess, parsed.action)) {
          ws.send(JSON.stringify({
            type: "command-result",
            id: parsed.id,
            accepted: false,
            reason: "invalid-command",
            revision: this.state.revision,
          }));
          return;
        }

        await this.commands.run(async () => {
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
          if (!accepted) this.sendStateToSocket(ws);
          ws.send(JSON.stringify({
            type: "command-result",
            id: parsed.id,
            accepted,
            reason: accepted ? undefined : "invalid-command",
            revision: this.state.revision,
          }));
        });
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
    const previousState = this.cloneState();
    const previousPlayback = this.state.timer.playback;
    const previousItemId = this.state.timer.currentItemId;
    const shouldEmitAutomation = action !== "seed";

    switch (action) {
      case "seed": {
        const force = payload?.force === true;
        const items = parseRelayRundownItems(payload?.items);
        const timer = payload?.timer === undefined ? null : parseRelayTimer(payload.timer);
        const serviceName = payload?.serviceName;
        const scheduledStartTime = payload?.scheduledStartTime;
        const location = payload?.location;
        if (
          !items
          || (payload?.timer !== undefined && !timer)
          || (serviceName !== undefined && (typeof serviceName !== "string" || serviceName.length > 120))
          || (location !== undefined && (typeof location !== "string" || location.length > 240))
          || (
            scheduledStartTime !== undefined
            && scheduledStartTime !== null
            && (typeof scheduledStartTime !== "string" || !Number.isFinite(Date.parse(scheduledStartTime)))
          )
        ) return false;
        // Empty is valid, authoritative state after clear-all. Only a room
        // that has never been initialized may accept an ordinary loader seed.
        if (!shouldAcceptRundownSeed(this.state.initialized, force)) return true;
        this.state.items = items;
        this.state.initialized = true;
        if (timer) this.state.timer = timer;
        if (serviceName !== undefined) this.state.serviceName = serviceName;
        if (location !== undefined) this.state.location = location;
        if (scheduledStartTime !== undefined) {
          this.state.scheduledStartTime = scheduledStartTime === null
            ? null
            : new Date(scheduledStartTime).toISOString();
        }
        break;
      }

      case "add-item": {
        const item = parseRelayRundownItem({
          ...payload,
          status: "upcoming",
          sortOrder: this.state.items.length,
        }, this.state.items.length);
        if (!item || this.state.items.some((existing) => existing.id === item.id)) return false;
        this.state.initialized = true;
        this.state.items.push(item);
        break;
      }

      case "update-item": {
        const id = typeof payload?.id === "string" ? payload.id : "";
        const updates = parseRelayItemUpdates(payload?.updates);
        const idx = this.state.items.findIndex((i) => i.id === id);
        if (idx < 0 || !updates) return false;
        this.state.items[idx] = { ...this.state.items[idx], ...updates };
        break;
      }

      case "remove-item": {
        const id = typeof payload?.id === "string" ? payload.id : "";
        if (!this.state.items.some((item) => item.id === id)) return false;
        this.state.items = this.state.items.filter((i) => i.id !== id);
        break;
      }

      case "reorder": {
        const order = parseExactRelayOrder(payload?.order, this.state.items.map((item) => item.id));
        if (!order) return false;
        const map = new Map(this.state.items.map((item) => [item.id, item]));
        this.state.items = order.map((id, sortOrder) => ({ ...map.get(id)!, sortOrder }));
        break;
      }

      case "timer-start": {
        const itemId =
          (payload?.itemId as string) ?? this.state.timer.currentItemId;
        const requestedItem = this.state.items.find((item) => item.id === itemId);
        if (!itemId || !requestedItem || requestedItem.type === "header") return false;
        {
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
              }
            }
          }

          const item = this.state.items.find((i) => i.id === itemId);
          if (item) {
            item.status = "live";
            if (!item.actualStart) {
              item.actualStart = nowIso;
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
        const deltaMs = payload?.deltaMs;
        if (typeof deltaMs !== "number" || !Number.isFinite(deltaMs) || Math.abs(deltaMs) > 86_400_000) {
          return false;
        }
        if (this.state.timer.playback === "stop") return false;

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
        if (payload?.mode !== "count-up" && payload?.mode !== "count-down" && payload?.mode !== "clock") {
          return false;
        }
        this.state.timer.mode = payload.mode;
        break;
      }

      case "pp-slide": {
        const slide = payload?.slide === null ? null : parseRelayPPSlide(payload?.slide);
        if (payload?.slide !== null && !slide) return false;
        const enabled = await this.isProPresenterStageDisplayEnabled();
        this.state.ppSlide = enabled && slide ? { ...slide, updatedAt: Date.now() } : null;
        break;
      }

      case "pp-preview": {
        const slide = payload?.slide === null ? null : parseRelayPPSlide(payload?.slide);
        if (payload?.slide !== null && !slide) return false;
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
        this.state.initialized = true;
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
        if (typeof msg !== "string" || msg.length > 2_000) return false;
        this.state.stageMessage = msg;
        break;
      }

      case "stage-clear": {
        this.state.stageMessage = "";
        break;
      }

      case "update-meta": {
        const serviceName = payload?.serviceName;
        const scheduledStartTime = payload?.scheduledStartTime;
        const location = payload?.location;
        if (
          serviceName === undefined && scheduledStartTime === undefined && location === undefined
          || (serviceName !== undefined && (typeof serviceName !== "string" || serviceName.length > 120))
          || (location !== undefined && (typeof location !== "string" || location.length > 240))
          || (
            scheduledStartTime !== undefined
            && scheduledStartTime !== null
            && (typeof scheduledStartTime !== "string" || !Number.isFinite(Date.parse(scheduledStartTime)))
          )
        ) return false;
        if (serviceName !== undefined) this.state.serviceName = serviceName;
        if (location !== undefined) this.state.location = location;
        if (scheduledStartTime !== undefined) {
          this.state.scheduledStartTime = scheduledStartTime === null
            ? null
            : new Date(scheduledStartTime).toISOString();
        }
        break;
      }

      default:
        return false;
    }

    try {
      await this.persistAuthoritativeSnapshot(action, previousState);
    } catch (error) {
      this.state = previousState;
      console.error("[RundownRelay] authoritative persistence failed", error);
      return false;
    }

    this.state.revision += 1;
    if (commandId) {
      this.state.recentCommandIds = [...this.state.recentCommandIds, commandId].slice(-100);
    }
    await this.persistState();
    this.broadcastState();

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
      ...(this.state.serviceName === undefined ? {} : { serviceName: this.state.serviceName }),
      ...(this.state.scheduledStartTime === undefined
        ? {}
        : { scheduledStartTime: this.state.scheduledStartTime }),
      ...(this.state.location === undefined ? {} : { location: this.state.location }),
      initialized: this.state.initialized,
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
      initialized: this.state.initialized,
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
      writeAccess?: RundownRelayWriteAccess | null;
      canObserve?: boolean;
    } | null;
    ws.send(JSON.stringify({
      type: "state",
      state: attachment?.writeAccess || attachment?.canObserve
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
