import { DurableObject } from "cloudflare:workers";
import { getPrisma } from "@/lib/db";
import type {
  TimecodeState,
  TimecodeFormat,
  TimecodeValue,
  AutomationEvent,
  TimecodeCommand,
  TimecodeWsMessage,
} from "@/types/timecode";
import { crossedTriggerFrame, isSafeAutomationWebhookUrl, isValidTimecode, isValidTimecodeFormat, timecodeToFrames, timecodeToString } from "@/lib/timecode";
import {
  appendWebhookEvent,
  sanitizePayloadSummary,
  type WebhookEventInput,
} from "@/lib/settings";
import { getActiveRundownRelayTarget } from "@/lib/active-rundown-relay";

interface Env {
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
  RUNDOWN_RELAY: DurableObjectNamespace;
  DB: D1Database;
}

const SUPPORTED_ACTIONS = new Set<AutomationEvent["action"]>([
  "lower-third-show",
  "lower-third-clear",
  "rundown-advance",
  "rundown-start-item",
  "custom-webhook",
]);

export class TimecodeRelay extends DurableObject {
  private sessions: Set<WebSocket> = new Set();
  private state: TimecodeState = {
    timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
    display: "00:00:00:00",
    source: "internal-freerun",
    format: { frameRate: 30, dropFrame: "ndf" },
    running: false,
    serverTime: Date.now(),
    totalFrames: 0,
  };
  private events: AutomationEvent[] = [];
  private orgId = "";
  private previousFeedFrame: number | null = null;
  private masterSessionId: string | null = null;
  private lastPersistedAt = 0;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<{ state: TimecodeState; events: AutomationEvent[] }>("timecode");
      if (stored) {
        this.state = { ...stored.state, running: false, serverTime: Date.now() };
        this.events = stored.events ?? [];
      }
    });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("timecode", { state: this.state, events: this.events });
    this.lastPersistedAt = Date.now();
  }

  private sendMasterStatus(sessionId: string | undefined, granted: boolean): void {
    if (!sessionId) return;
    for (const ws of this.sessions) {
      const attachment = ws.deserializeAttachment?.() as { sessionId?: string } | null;
      if (attachment?.sessionId === sessionId) {
        ws.send(JSON.stringify({ type: "master-status", granted } satisfies TimecodeWsMessage));
        return;
      }
    }
  }

  private logWebhookEvent(event: WebhookEventInput): void {
    if (!this.orgId) return;

    try {
      const prisma = getPrisma();
      void appendWebhookEvent(prisma, this.orgId, event);
    } catch {
      // Non-blocking telemetry.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract orgId from query param or path
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({
        canWrite: url.searchParams.get("access") === "write",
        sessionId: crypto.randomUUID(),
      });
      this.sessions.add(server);

      // Hydrate
      const hydrate: TimecodeWsMessage = {
        type: "hydrate",
        state: this.state,
        events: this.events,
      };
      server.send(JSON.stringify(hydrate));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      return Response.json(this.state);
    }

    if (url.pathname === "/events") {
      return Response.json(this.events);
    }

    if (url.pathname === "/command" && request.method === "POST") {
      if (url.searchParams.get("access") === "read") {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = (await request.json()) as {
        action: TimecodeCommand;
        payload?: Record<string, unknown>;
      };
      await this.handleCommand(body.action, body.payload);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const msg = JSON.parse(data as string) as TimecodeWsMessage;
      if (msg.type === "command") {
        const attachment = ws.deserializeAttachment?.() as { canWrite?: boolean; sessionId?: string } | null;
        if (!attachment?.canWrite) return;
        await this.handleCommand(msg.action, msg.payload, attachment.sessionId);
      }
    } catch {
      // Ignore
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
    const attachment = ws.deserializeAttachment?.() as { sessionId?: string } | null;
    if (attachment?.sessionId && attachment.sessionId === this.masterSessionId) {
      this.masterSessionId = null;
      this.previousFeedFrame = null;
      this.state.running = false;
      await this.persist();
      this.broadcastState();
    }
  }

  webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  // ─── Command Handler ────────────────────────────────────

  private async handleCommand(
    action: TimecodeCommand,
    payload?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<void> {
    switch (action) {
      case "start":
        if (sessionId && this.masterSessionId && this.masterSessionId !== sessionId) {
          this.sendMasterStatus(sessionId, false);
          break;
        }
        if (sessionId) this.masterSessionId = sessionId;
        this.sendMasterStatus(sessionId, true);
        this.state.running = true;
        await this.persist();
        this.broadcastState();
        break;

      case "stop":
        if (sessionId && this.masterSessionId && this.masterSessionId !== sessionId) break;
        this.masterSessionId = null;
        this.sendMasterStatus(sessionId, false);
        this.state.running = false;
        this.previousFeedFrame = null;
        await this.persist();
        this.broadcastState();
        break;

      case "feed-tc": {
        if (sessionId && this.masterSessionId !== sessionId) break;
        if (!payload) break;
        const tc = payload.timecode as TimecodeValue;
        const format = (payload.format as TimecodeFormat) ?? this.state.format;
        if (!isValidTimecodeFormat(format) || !tc || !isValidTimecode(tc, format)) break;
        const totalFrames =
          (payload.totalFrames as number) ?? timecodeToFrames(tc, format);

        this.state.timecode = tc;
        this.state.totalFrames = totalFrames;
        this.state.display = timecodeToString(tc, format.dropFrame === "df");
        this.state.format = format;
        this.state.running = true;
        this.state.serverTime = Date.now();

        // Evaluate automation events
        const eventFired = await this.evaluateEvents(this.previousFeedFrame, totalFrames);
        this.previousFeedFrame = totalFrames;

        // Persist automation results immediately; otherwise snapshot the
        // running clock at a modest cadence instead of writing at 10 Hz.
        if (eventFired || Date.now() - this.lastPersistedAt >= 5_000) {
          await this.persist();
        }
        this.broadcastState();
        break;
      }

      case "set-timecode": {
        if (!payload) break;
        const tc = payload.timecode as TimecodeValue;
        if (!tc || !isValidTimecode(tc, this.state.format)) break;
        this.state.timecode = tc;
        this.state.totalFrames = timecodeToFrames(tc, this.state.format);
        this.state.display = timecodeToString(
          tc,
          this.state.format.dropFrame === "df"
        );
        this.state.serverTime = Date.now();
        this.previousFeedFrame = null;
        await this.persist();
        this.broadcastState();
        break;
      }

      case "set-source":
        if (payload?.source) {
          this.state.source = payload.source as TimecodeState["source"];
        }
        await this.persist();
        this.broadcastState();
        break;

      case "set-format":
        if (isValidTimecodeFormat(payload?.format)) {
          this.state.format = payload.format as TimecodeFormat;
          for (const event of this.events) {
            event.triggerFrame = timecodeToFrames(event.triggerTimecode, this.state.format);
            event.fired = false;
          }
          this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
          this.previousFeedFrame = null;
        }
        await this.persist();
        this.broadcastState();
        this.broadcastEvents();
        break;

      case "add-event": {
        if (!payload) break;
        const event = payload as unknown as AutomationEvent;
        if (
          !SUPPORTED_ACTIONS.has(event.action) ||
          !event.triggerTimecode ||
          !isValidTimecode(event.triggerTimecode, this.state.format) ||
          typeof event.label !== "string" || event.label.length > 200 ||
          !event.payload || typeof event.payload !== "object"
        ) break;
        event.id = event.id || crypto.randomUUID();
        event.fired = false;
        event.toleranceFrames = event.toleranceFrames ?? 2;
        event.triggerFrame = timecodeToFrames(
          event.triggerTimecode,
          this.state.format
        );
        this.events.push(event);
        this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
        await this.persist();
        this.broadcastEvents();
        break;
      }

      case "update-event": {
        if (!payload?.id) break;
        const idx = this.events.findIndex(
          (e) => e.id === (payload.id as string)
        );
        if (idx >= 0) {
          const updates = (payload.updates ?? {}) as Partial<AutomationEvent>;
          if (updates.action && !SUPPORTED_ACTIONS.has(updates.action)) break;
          if (updates.triggerTimecode && !isValidTimecode(updates.triggerTimecode, this.state.format)) break;
          Object.assign(this.events[idx], payload.updates ?? payload);
          // Recalculate triggerFrame if timecode changed
          if ((payload.updates as Record<string, unknown>)?.triggerTimecode || payload.triggerTimecode) {
            this.events[idx].triggerFrame = timecodeToFrames(
              this.events[idx].triggerTimecode,
              this.state.format
            );
          }
          this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
          await this.persist();
          this.broadcastEvents();
        }
        break;
      }

      case "remove-event": {
        if (!payload?.id) break;
        this.events = this.events.filter(
          (e) => e.id !== (payload.id as string)
        );
        await this.persist();
        this.broadcastEvents();
        break;
      }

      case "reset-events":
        for (const event of this.events) {
          event.fired = false;
        }
        this.previousFeedFrame = null;
        await this.persist();
        this.broadcastEvents();
        break;
    }
  }

  // ─── Automation Engine ──────────────────────────────────

  private async evaluateEvents(previousFrame: number | null, totalFrames: number): Promise<boolean> {
    let fired = false;
    for (const event of this.events) {
      if (event.fired) continue;

      if (crossedTriggerFrame(previousFrame, totalFrames, event.triggerFrame, event.toleranceFrames)) {
        event.fired = true;
        fired = true;
        await this.executeEventAction(event);
        this.broadcastEventFired(event);
      }
    }
    return fired;
  }

  private async executeEventAction(event: AutomationEvent): Promise<void> {
    const env = this.env as unknown as Env;
    const actionSummary = sanitizePayloadSummary({
      action: event.action,
      label: event.label,
      trigger: event.triggerTimecode,
    });

    const logResult = (
      type: string,
      status: "success" | "error" | "warning",
      details: string,
    ) => {
      this.logWebhookEvent({
        source: "timecode-relay",
        type,
        direction: "outgoing",
        status,
        details,
        payloadSummary: actionSummary,
      });
    };

    try {
      switch (event.action) {
        case "lower-third-show": {
          const ltId = env.LOWER_THIRDS_RELAY.idFromName(this.orgId);
          const ltStub = env.LOWER_THIRDS_RELAY.get(ltId);
          try {
            const response = await ltStub.fetch(
              new Request("https://internal/trigger", {
                method: "POST",
                body: JSON.stringify(event.payload),
              })
            );
            if (!response.ok) {
              logResult(
                "lower-third-show",
                "error",
                `Lower-third show failed with ${response.status}`
              );
            } else {
              logResult(
                "lower-third-show",
                "success",
                "Lower-third show action executed."
              );
            }
          } catch {
            logResult(
              "lower-third-show",
              "error",
              "Lower-third show action failed."
            );
          }
          break;
        }

        case "lower-third-clear": {
          const ltId = env.LOWER_THIRDS_RELAY.idFromName(this.orgId);
          const ltStub = env.LOWER_THIRDS_RELAY.get(ltId);
          try {
            const response = await ltStub.fetch(
              new Request("https://internal/clear", { method: "POST" })
            );
            if (!response.ok) {
              logResult(
                "lower-third-clear",
                "error",
                `Lower-third clear failed with ${response.status}`
              );
            } else {
              logResult(
                "lower-third-clear",
                "success",
                "Lower-third clear action executed."
              );
            }
          } catch {
            logResult(
              "lower-third-clear",
              "error",
              "Lower-third clear action failed."
            );
          }
          break;
        }

        case "rundown-advance": {
          const target = await getActiveRundownRelayTarget(env.DB, this.orgId);
          const rdId = env.RUNDOWN_RELAY.idFromName(target.key);
          const rdStub = env.RUNDOWN_RELAY.get(rdId);
          try {
            const response = await rdStub.fetch(
              new Request("https://internal/command", {
                method: "POST",
                body: JSON.stringify({ action: "timer-next" }),
              })
            );
            if (!response.ok) {
              logResult(
                "rundown-advance",
                "error",
                `Rundown advance failed with ${response.status}`
              );
            } else {
              logResult(
                "rundown-advance",
                "success",
                "Rundown advance action executed."
              );
            }
          } catch {
            logResult(
              "rundown-advance",
              "error",
              "Rundown advance action failed."
            );
          }
          break;
        }

        case "rundown-start-item": {
          const target = await getActiveRundownRelayTarget(env.DB, this.orgId);
          const rdId = env.RUNDOWN_RELAY.idFromName(target.key);
          const rdStub = env.RUNDOWN_RELAY.get(rdId);
          try {
            const response = await rdStub.fetch(
              new Request("https://internal/command", {
                method: "POST",
                body: JSON.stringify({
                  action: "timer-start",
                  payload: event.payload,
                }),
              })
            );
            if (!response.ok) {
              logResult(
                "rundown-start-item",
                "error",
                `Rundown start-item failed with ${response.status}`
              );
            } else {
              logResult(
                "rundown-start-item",
                "success",
                "Rundown start-item action executed."
              );
            }
          } catch {
            logResult(
              "rundown-start-item",
              "error",
              "Rundown start-item action failed."
            );
          }
          break;
        }

        case "device-action":
          // Device actions are forwarded to clients who execute them
          // via their local device module connections
          // The event-fired broadcast carries the action info
          break;

        case "custom-webhook": {
          const url = event.payload.url;
          if (!isSafeAutomationWebhookUrl(url)) {
            logResult(
              "custom-webhook",
              "warning",
              `Custom webhook skipped for event "${event.label}": target must be a public HTTPS URL.`
            );
            break;
          }

          try {
            const response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: event.label,
                timecode: this.state.display,
                payload: event.payload,
                firedAt: Date.now(),
              }),
            });

              if (!response.ok) {
                logResult(
                  "custom-webhook",
                  "error",
                  `Custom webhook for "${event.label}" failed with ${response.status}`
                );
                break;
              }

              logResult(
                "custom-webhook",
                "success",
                `Custom webhook for "${event.label}" dispatched successfully.`
              );
          } catch (err) {
            logResult(
              "custom-webhook",
              "error",
              err instanceof Error
                ? `Custom webhook for "${event.label}" failed: ${err.message}`
                : "Custom webhook dispatch failed."
            );
          }

          break;
        }
      }
    } catch (err) {
      console.error(
        `[TimecodeRelay] Failed to execute event "${event.label}":`,
        err
      );
    }
  }

  // ─── Broadcasting ───────────────────────────────────────

  private broadcastState(): void {
    const msg: TimecodeWsMessage = { type: "tc-update", state: this.state };
    this.broadcast(JSON.stringify(msg));
  }

  private broadcastEvents(): void {
    const msg: TimecodeWsMessage = {
      type: "events-update",
      events: this.events,
    };
    this.broadcast(JSON.stringify(msg));
  }

  private broadcastEventFired(event: AutomationEvent): void {
    const msg: TimecodeWsMessage = {
      type: "event-fired",
      event,
      firedAt: Date.now(),
    };
    this.broadcast(JSON.stringify(msg));
  }

  private broadcast(data: string): void {
    for (const ws of this.sessions) {
      try {
        ws.send(data);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }
}
