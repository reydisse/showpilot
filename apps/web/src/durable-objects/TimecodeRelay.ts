import { DurableObject } from "cloudflare:workers";
import { getPrisma } from "@/lib/db";
import type {
  TimecodeState,
  TimecodeFormat,
  TimecodeValue,
  AutomationEvent,
  LyricsDisplayState,
  TimecodeCommand,
  TimecodeWsMessage,
  TimecodeDisplayState,
} from "@/types/timecode";
import { crossedTriggerFrame, isSafeAutomationWebhookUrl, isValidTimecode, isValidTimecodeFormat, replaceAutomationEventGroup, timecodeToFrames, timecodeToString } from "@/lib/timecode";
import {
  appendWebhookEvent,
  sanitizePayloadSummary,
  type WebhookEventInput,
} from "@/lib/webhook-events";
import { getActiveRundownRelayTarget } from "@/lib/active-rundown-relay";
import { projectTimecodeDisplayState } from "@/lib/timecode-display";
import {
  hasLivePermissionAuthority,
  type LiveSessionAuthorityClaim,
} from "@/lib/live-rundown-authority.server";
import { resolveTimecodeDeviceAction } from "@/lib/timecode-device-actions";
import { z } from "zod";
import { AutomationExecutor, automationOutput } from "@/lib/automation-execution";

interface Env {
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
  RUNDOWN_RELAY: DurableObjectNamespace;
  BRIDGE_RELAY: DurableObjectNamespace<import("@/durable-objects/BridgeRelay").BridgeRelay>;
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
}

const SUPPORTED_ACTIONS = new Set<AutomationEvent["action"]>([
  "lower-third-show",
  "lower-third-clear",
  "rundown-advance",
  "rundown-start-item",
  "rundown-previous",
  "rundown-pause",
  "rundown-resume",
  "rundown-stop",
  "rundown-adjust",
  "stage-message",
  "stage-clear",
  "device-action",
  "lighting-scene",
  "lyrics-goto",
  "lyrics-clear",
  "pp-trigger-slide",
  "pp-trigger-next",
  "pp-trigger-clear",
  "custom-webhook",
]);

// Server-owned acknowledgement and retry fields cannot be patched by clients.
const eventUpdateSchema = z.object({
  action: z.enum([...SUPPORTED_ACTIONS]).optional(),
  label: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  triggerTimecode: z.object({
    hours: z.number().int().min(0).max(23), minutes: z.number().int().min(0).max(59),
    seconds: z.number().int().min(0).max(59), frames: z.number().int().min(0).max(29),
  }).optional(),
  toleranceFrames: z.number().int().min(0).max(9000).optional(),
  targetDeviceId: z.string().max(200).optional(),
  targetActionId: z.string().max(200).optional(),
  rundownItemId: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
});

class AutomationRejection extends Error {
  readonly retryable: boolean;
  constructor(action: string, status: number) {
    super(`${action} failed with ${status}`);
    this.retryable = status === 429 || status === 503;
  }
}

class AutomationCancelled extends Error {}

export class TimecodeRelay extends DurableObject {
  private state: TimecodeState = {
    timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
    display: "00:00:00:00",
    source: "internal-freerun",
    format: { frameRate: 30, dropFrame: "ndf" },
    running: false,
    triggersEnabled: true,
    serverTime: Date.now(),
    totalFrames: 0,
    lyrics: null,
  };
  private events: AutomationEvent[] = [];
  private orgId = "";
  private previousFeedFrame: number | null = null;
  private masterSessionId: string | null = null;
  private lastPersistedAt = 0;
  private readonly executor = new AutomationExecutor();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<{ state: TimecodeState; events: AutomationEvent[] }>("timecode");
      if (stored) {
        this.state = {
          ...stored.state,
          triggersEnabled: stored.state.triggersEnabled ?? true,
          running: false,
          serverTime: Date.now(),
          lyrics: stored.state.lyrics ?? null,
        };
        this.events = (stored.events ?? []).map((event) => ({
          ...event,
          enabled: event.enabled ?? true,
          // A process restart cannot prove that an in-flight device command
          // did not execute. Require the operator to decide whether to retry.
          ...(event.executionStatus === "dispatching" ? {
            fired: false, executionStatus: "failed" as const,
            executionError: "Acknowledgement interrupted. Check the output before retrying.",
            executionAttempts: 3,
          } : {}),
        }));
      }
    });
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("timecode", { state: this.state, events: this.events });
    this.lastPersistedAt = Date.now();
  }

  private sendMasterStatus(sessionId: string | undefined, granted: boolean): void {
    if (!sessionId) return;
    for (const ws of this.ctx.getWebSockets()) {
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
      this.ctx.waitUntil(appendWebhookEvent(prisma, this.orgId, event).catch(() => {
        // Telemetry must never fail a live automation command.
      }));
    } catch {
      // Non-blocking telemetry.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract orgId from query param or path
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;

    if (url.pathname === "/internal/purge-org" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Organization deleted");
      await this.ctx.storage.deleteAll();
      this.state = {
        timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
        display: "00:00:00:00",
        source: "internal-freerun",
        format: { frameRate: 30, dropFrame: "ndf" },
        running: false,
        triggersEnabled: true,
        serverTime: Date.now(),
        totalFrames: 0,
        lyrics: null,
      };
      this.events = [];
      this.masterSessionId = null;
      this.previousFeedFrame = null;
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({
        canWrite: url.searchParams.get("access") === "write",
        sessionId: crypto.randomUUID(),
        orgId: this.orgId,
        authClaim: this.readAuthorityClaim(url),
      });

      // Hydrate
      const hydrate: TimecodeWsMessage = url.searchParams.get("access") === "write"
        ? { type: "hydrate", state: this.state, events: this.events }
        : { type: "hydrate", state: this.getDisplayState() };
      server.send(JSON.stringify(hydrate));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      return Response.json(
        url.searchParams.get("access") === "write" ? this.state : this.getDisplayState(),
      );
    }

    if (url.pathname === "/events") {
      if (url.searchParams.get("access") !== "write") {
        return new Response("Unauthorized", { status: 401 });
      }
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
        const attachment = ws.deserializeAttachment?.() as {
          canWrite?: boolean;
          sessionId?: string;
          orgId?: string;
          authClaim?: LiveSessionAuthorityClaim | null;
        } | null;
        if (!attachment?.canWrite) return;
        if (
          attachment.authClaim
          && !(await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "timecode:access"))
        ) {
          ws.close(4403, "Timecode access changed");
          return;
        }
        if (attachment.orgId) this.orgId = attachment.orgId;
        await this.handleCommand(msg.action, msg.payload, attachment.sessionId);
      }
    } catch {
      // Ignore
    }
  }

  async webSocketClose(ws: WebSocket) {
    const attachment = ws.deserializeAttachment?.() as { sessionId?: string } | null;
    if (attachment?.sessionId && attachment.sessionId === this.masterSessionId) {
      this.masterSessionId = null;
      this.previousFeedFrame = null;
      this.state.running = false;
      await this.persist();
      await this.broadcastState();
    }
  }

  webSocketError() {}

  private readAuthorityClaim(url: URL): LiveSessionAuthorityClaim | null {
    const userId = url.searchParams.get("authUserId")?.trim();
    const sessionId = url.searchParams.get("authSessionId")?.trim();
    if (!userId || !sessionId || !this.orgId) return null;
    return { userId, sessionId, orgId: this.orgId };
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
        await this.broadcastState();
        break;

      case "stop":
        if (sessionId && this.masterSessionId && this.masterSessionId !== sessionId) break;
        this.masterSessionId = null;
        this.sendMasterStatus(sessionId, false);
        this.state.running = false;
        this.previousFeedFrame = null;
        await this.persist();
        await this.broadcastState();
        break;

      case "feed-tc": {
        if (sessionId && this.masterSessionId !== sessionId) break;
        if (!payload) break;
        const tc = payload.timecode as TimecodeValue;
        const format = (payload.format as TimecodeFormat) ?? this.state.format;
        if (!isValidTimecodeFormat(format) || !tc || !isValidTimecode(tc, format)) break;
        const formatChanged = format.frameRate !== this.state.format.frameRate
          || format.dropFrame !== this.state.format.dropFrame;
        if (formatChanged) {
          this.state.format = format;
          for (const event of this.events) {
            event.triggerFrame = timecodeToFrames(event.triggerTimecode, format);
            event.fired = false;
            event.executionStatus = "scheduled";
            delete event.executionError;
            delete event.executedAt;
          }
          this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
          this.previousFeedFrame = null;
          await this.broadcastEvents();
        }
        // The relay derives frame position from the accepted format instead of
        // trusting a stale client-side conversion.
        const totalFrames = timecodeToFrames(tc, format);

        this.state.timecode = tc;
        this.state.totalFrames = totalFrames;
        this.state.display = timecodeToString(tc, format.dropFrame === "df");
        this.state.format = format;
        if (!sessionId) this.state.source = "mtc";
        this.state.running = true;
        this.state.serverTime = Date.now();

        // Evaluate automation events
        const previousFrame = this.previousFeedFrame;
        this.previousFeedFrame = totalFrames;
        // Clock delivery cannot wait for device or webhook acknowledgement.
        await this.broadcastState();
        const eventFired = await this.evaluateEvents(previousFrame, totalFrames);

        // Persist automation results immediately; otherwise snapshot the
        // running clock at a modest cadence instead of writing at 10 Hz.
        if (eventFired || Date.now() - this.lastPersistedAt >= 5_000) {
          await this.persist();
        }
        await this.broadcastState();
        break;
      }

      case "bridge-disconnected":
        if (this.state.source !== "mtc") break;
        this.masterSessionId = null;
        this.state.running = false;
        this.previousFeedFrame = null;
        await this.persist();
        await this.broadcastState();
        break;

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
        await this.broadcastState();
        break;
      }

      case "set-source":
        if (payload?.source) {
          this.state.source = payload.source as TimecodeState["source"];
        }
        await this.persist();
        await this.broadcastState();
        break;

      case "set-format":
        if (isValidTimecodeFormat(payload?.format)) {
          this.state.format = payload.format as TimecodeFormat;
          for (const event of this.events) {
            event.triggerFrame = timecodeToFrames(event.triggerTimecode, this.state.format);
            event.fired = false;
            event.executionStatus = "scheduled";
            delete event.executionError;
            delete event.executedAt;
          }
          this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
          this.previousFeedFrame = null;
        }
        await this.persist();
        await this.broadcastState();
        await this.broadcastEvents();
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
        if (this.events.some((existing) => existing.id === event.id)) {
          // A save retry may follow a lost echo. Return the canonical timeline.
          await this.broadcastEvents();
          break;
        }
        event.enabled = event.enabled !== false;
        event.fired = false;
        event.executionAttempts = 0;
        delete event.executionId;
        delete event.executionStartedAt;
        delete event.executionDurationMs;
        delete event.executionRetryable;
        event.executionStatus = "scheduled";
        delete event.executionError;
        delete event.executedAt;
        event.toleranceFrames = event.toleranceFrames ?? 5;
        event.triggerFrame = timecodeToFrames(
          event.triggerTimecode,
          this.state.format
        );
        this.events.push(event);
        this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
        await this.persist();
        await this.broadcastEvents();
        break;
      }

      case "replace-event-group": {
        if (payload?.requireStopped === true && this.state.running) break;
        if (payload?.requireEmpty === true && this.events.length > 0) break;
        if (payload?.expectedFormat !== undefined && (
          !isValidTimecodeFormat(payload.expectedFormat)
          || payload.expectedFormat.frameRate !== this.state.format.frameRate
          || payload.expectedFormat.dropFrame !== this.state.format.dropFrame
        )) break;
        const sourceKey = typeof payload?.sourceKey === "string" ? payload.sourceKey.trim() : "";
        const rawEvents = Array.isArray(payload?.events) ? payload.events : [];
        if (!sourceKey || sourceKey.length > 240 || rawEvents.length > 1_000) break;
        const nextEvents: AutomationEvent[] = [];
        let valid = true;
        for (const raw of rawEvents) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            valid = false;
            break;
          }
          const candidate = raw as Partial<AutomationEvent>;
          if (
            !candidate.action
            || !SUPPORTED_ACTIONS.has(candidate.action)
            || !candidate.triggerTimecode
            || !isValidTimecode(candidate.triggerTimecode, this.state.format)
            || typeof candidate.label !== "string"
            || candidate.label.length > 200
            || !candidate.payload
            || typeof candidate.payload !== "object"
            || Array.isArray(candidate.payload)
          ) {
            valid = false;
            break;
          }
          nextEvents.push({
            ...(candidate as AutomationEvent),
            id: candidate.id || crypto.randomUUID(),
            fired: false,
            enabled: candidate.enabled !== false,
            executionAttempts: 0,
            executionId: undefined,
            executionStartedAt: undefined,
            executionDurationMs: undefined,
            executionRetryable: undefined,
            executionStatus: "scheduled",
            executionError: undefined,
            executedAt: undefined,
            toleranceFrames: candidate.toleranceFrames ?? 5,
            triggerFrame: timecodeToFrames(candidate.triggerTimecode, this.state.format),
            sourceKey,
          });
        }
        if (!valid) break;
        this.events = replaceAutomationEventGroup(this.events, sourceKey, nextEvents);
        await this.persist();
        await this.broadcastEvents();
        break;
      }

      case "update-event": {
        if (!payload?.id) break;
        const idx = this.events.findIndex(
          (e) => e.id === (payload.id as string)
        );
        if (idx >= 0) {
          if (this.events[idx].executionStatus === "dispatching") break;
          const parsed = eventUpdateSchema.safeParse(payload.updates ?? {});
          if (!parsed.success) break;
          const updates = parsed.data;
          if (updates.triggerTimecode && !isValidTimecode(updates.triggerTimecode, this.state.format)) break;
          Object.assign(this.events[idx], updates);
          // Recalculate triggerFrame if timecode changed
          if (updates.triggerTimecode) {
            this.events[idx].triggerFrame = timecodeToFrames(
              this.events[idx].triggerTimecode,
              this.state.format
            );
          }
          this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
          await this.persist();
          await this.broadcastEvents();
        }
        break;
      }

      case "remove-event": {
        if (!payload?.id) break;
        this.events = this.events.filter(
          (e) => e.id !== (payload.id as string)
        );
        await this.persist();
        await this.broadcastEvents();
        break;
      }

      case "set-triggers-enabled":
        if (typeof payload?.enabled !== "boolean") break;
        this.state.triggersEnabled = payload.enabled;
        await this.persist();
        await this.broadcastState();
        break;

      case "set-event-enabled": {
        if (typeof payload?.id !== "string" || typeof payload.enabled !== "boolean") break;
        const event = this.events.find((candidate) => candidate.id === payload.id);
        if (!event) break;
        event.enabled = payload.enabled;
        await this.persist();
        await this.broadcastEvents();
        break;
      }

      case "retry-event": {
        if (!this.state.triggersEnabled || typeof payload?.id !== "string") break;
        const event = this.events.find((candidate) => candidate.id === payload.id);
        if (!event?.enabled || event.executionStatus === "dispatching") break;
        event.fired = false;
        event.executionAttempts = 0;
        event.executionStatus = "scheduled";
        delete event.executionId;
        delete event.executionStartedAt;
        await this.runEvent(event);
        await this.persist();
        await this.broadcastState();
        break;
      }

      case "reset-events":
        if (this.events.some((event) => event.executionStatus === "dispatching")) break;
        for (const event of this.events) {
          event.fired = false;
          event.executionStatus = "scheduled";
          event.executionAttempts = 0;
          delete event.executionId;
          delete event.executionStartedAt;
          delete event.executionDurationMs;
          delete event.executionError;
          delete event.executedAt;
        }
        this.previousFeedFrame = null;
        await this.persist();
        await this.broadcastEvents();
        break;

      case "set-lyrics": {
        const required = ["songId", "songTitle", "sectionId", "sectionLabel", "lyrics"] as const;
        if (!payload || !required.every((key) => typeof payload[key] === "string")) break;
        this.state.lyrics = {
          songId: payload.songId as string,
          songTitle: payload.songTitle as string,
          sectionId: payload.sectionId as string,
          sectionLabel: payload.sectionLabel as string,
          lyrics: payload.lyrics as string,
          nextLabel: typeof payload.nextLabel === "string" ? payload.nextLabel : "",
          updatedAt: Date.now(),
          manual: true,
        };
        await this.persist();
        this.broadcastLyrics(this.state.lyrics);
        await this.broadcastState();
        break;
      }

      case "clear-lyrics":
        this.state.lyrics = null;
        await this.persist();
        this.broadcast(JSON.stringify({ type: "lyrics-clear" } satisfies TimecodeWsMessage));
        await this.broadcastState();
        break;
    }
  }

  // ─── Automation Engine ──────────────────────────────────

  private async evaluateEvents(previousFrame: number | null, totalFrames: number): Promise<boolean> {
    if (!this.state.triggersEnabled) return false;
    const executions: Promise<void>[] = [];
    for (const event of this.events) {
      if (!event.enabled || event.fired || event.executionStatus === "dispatching") continue;
      const attempts = event.executionAttempts ?? 0;
      const withinRetryWindow = event.executionStartedAt !== undefined
        && Date.now() - event.executionStartedAt <= event.toleranceFrames * 1000 / this.state.format.frameRate
        && totalFrames >= event.triggerFrame
        && totalFrames <= event.triggerFrame + event.toleranceFrames;
      const shouldRun = event.executionStatus === "failed"
        ? event.executionRetryable === true && attempts < 3 && withinRetryWindow
        : crossedTriggerFrame(previousFrame, totalFrames, event.triggerFrame, event.toleranceFrames);
      if (!shouldRun) continue;
      executions.push(this.runEvent(event));
    }
    await Promise.allSettled(executions);
    return executions.length > 0;
  }

  private async runEvent(event: AutomationEvent): Promise<void> {
    // Reserve before yielding, so concurrent feed messages cannot dispatch twice.
    event.executionStatus = "dispatching";
    event.executionAttempts = (event.executionAttempts ?? 0) + 1;
    event.executionStartedAt ??= Date.now();
    event.executionId ??= crypto.randomUUID();
    const startedAt = Date.now();
    delete event.executionError;
    try {
      // Reserve output order before the first await. Persist the dispatch
      // before external effects so restart recovery can detect uncertainty.
      await this.executor.run(
        automationOutput(event),
        event.action === "custom-webhook" ? 5000 : 10000,
        async (signal) => {
          await this.persist();
          await this.broadcastEvents();
          await this.executeEventAction(event, signal);
        },
      );
      event.fired = true;
      event.executionStatus = "acknowledged";
    } catch (error) {
      if (error instanceof AutomationCancelled) {
        event.executionStatus = "scheduled";
        await this.broadcastEvents();
        return;
      }
      const message = error instanceof Error ? error.message : "Automation action failed.";
      event.fired = false;
      event.executionStatus = "failed";
      event.executionError = message;
      // A timeout or connection loss cannot prove the remote action did not
      // run. Leave uncertain outcomes for an explicit operator retry.
      event.executionRetryable = error instanceof AutomationRejection && error.retryable;
      this.logWebhookEvent({
        source: "timecode-relay", type: event.action, direction: "outgoing", status: "error",
        details: message,
        payloadSummary: sanitizePayloadSummary({ action: event.action, label: event.label }),
      });
    }
    event.executedAt = Date.now();
    event.executionDurationMs = event.executedAt - startedAt;
    await this.broadcastEventFired(event);
    await this.broadcastEvents();
    await this.broadcastState();
  }

  private async executeEventAction(event: AutomationEvent, signal: AbortSignal): Promise<void> {
    const env = this.env as unknown as Env;
    const assertCanDispatch = () => {
      signal.throwIfAborted();
      if (!this.state.triggersEnabled || !event.enabled || !this.events.includes(event)) {
        throw new AutomationCancelled("Automation was disabled or removed before dispatch.");
      }
    };
    assertCanDispatch();
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

    const executeRundownCommand = async (
      action: "timer-start" | "timer-next" | "timer-prev" | "timer-pause" | "timer-resume" | "timer-stop" | "timer-adjust" | "stage-message" | "stage-clear",
      type: string,
      payload?: Record<string, unknown>,
    ) => {
      const target = await getActiveRundownRelayTarget(env.DB, this.orgId);
      assertCanDispatch();
      const rdStub = env.RUNDOWN_RELAY.get(env.RUNDOWN_RELAY.idFromName(target.key));
      const response = await rdStub.fetch(
        new Request(`https://internal/command?orgId=${encodeURIComponent(this.orgId)}&serviceDate=${encodeURIComponent(target.serviceDate)}${target.showId ? `&showId=${encodeURIComponent(target.showId)}` : ""}&access=control`, {
          method: "POST",
          signal,
          body: JSON.stringify({ id: event.executionId, action, ...(payload ? { payload } : {}) }),
        }),
      );
      signal.throwIfAborted();
      await response.body?.cancel();
      if (!response.ok) throw new AutomationRejection(type, response.status);
      logResult(type, "success", `${type} action executed.`);
    };

    const executeProPresenterCommand = async (
      command: "trigger-slide" | "next" | "clear",
    ) => {
      const relay = env.BRIDGE_RELAY.get(env.BRIDGE_RELAY.idFromName(this.orgId));
      const status = await relay.getBridgeStatus();
      assertCanDispatch();
      const target = typeof event.payload.target === "string"
        ? event.payload.target
        : status.connectedTargets.find((candidate) => candidate.startsWith("propresenter:"));
      if (!target) throw new Error("ProPresenter is not connected through Venue Bridge.");
      const result = await relay.dispatchBridgeMessage({
        type: "command",
        id: event.executionId ?? crypto.randomUUID(),
        protocol: "propresenter",
        target,
        command: JSON.stringify({ action: command, ...event.payload }),
      });
      signal.throwIfAborted();
      if (!result.success) throw new Error(result.error ?? "ProPresenter command failed.");
    };

    const executeDeviceCommand = async () => {
      const resolved = await resolveTimecodeDeviceAction(env.DB, this.orgId, event);
      assertCanDispatch();
      const relay = env.BRIDGE_RELAY.get(env.BRIDGE_RELAY.idFromName(this.orgId));
      const status = await relay.getBridgeStatus();
      assertCanDispatch();
      if (!status.bridgeOnline) throw new Error("Venue Bridge is offline.");
      if (!status.connectedTargets.includes(resolved.target)) {
        const connected = await relay.dispatchBridgeMessage({
          type: "connect-device",
          protocol: resolved.protocol,
          target: resolved.target,
          settings: resolved.connectionSettings,
        });
        assertCanDispatch();
        if (!connected.success) {
          throw new Error(connected.error ?? `Could not connect to ${resolved.deviceName}.`);
        }
      }
      const result = await relay.dispatchBridgeMessage({
        type: "command",
        id: event.executionId ?? crypto.randomUUID(),
        protocol: resolved.protocol,
        target: resolved.target,
        command: resolved.command,
      });
      signal.throwIfAborted();
      if (!result.success) throw new Error(result.error ?? `Command to ${resolved.deviceName} failed.`);
      logResult(event.action, "success", `${event.label} acknowledged by ${resolved.deviceName}.`);
    };

    switch (event.action) {
      case "lower-third-show":
      case "lower-third-clear": {
        const ltStub = env.LOWER_THIRDS_RELAY.get(env.LOWER_THIRDS_RELAY.idFromName(this.orgId));
        const show = event.action === "lower-third-show";
        const response = await ltStub.fetch(new Request(`https://internal/${show ? "trigger" : "clear"}`, {
          method: "POST",
          signal,
          ...(show ? { body: JSON.stringify(event.payload) } : {}),
        }));
        signal.throwIfAborted();
        await response.body?.cancel();
        if (!response.ok) throw new AutomationRejection(event.action, response.status);
        logResult(event.action, "success", `${event.action} action acknowledged.`);
        break;
      }

      case "rundown-advance":
      case "rundown-start-item":
      case "rundown-previous":
      case "rundown-pause":
      case "rundown-resume":
      case "rundown-stop":
      case "rundown-adjust":
      case "stage-message":
      case "stage-clear": {
        const actions = {
          "rundown-advance": "timer-next",
          "rundown-start-item": "timer-start",
          "rundown-previous": "timer-prev",
          "rundown-pause": "timer-pause",
          "rundown-resume": "timer-resume",
          "rundown-stop": "timer-stop",
          "rundown-adjust": "timer-adjust",
          "stage-message": "stage-message",
          "stage-clear": "stage-clear",
        } as const;
        await executeRundownCommand(actions[event.action], event.action, event.payload);
        break;
      }

      case "device-action":
      case "lighting-scene":
        await executeDeviceCommand();
        break;

      case "lyrics-goto": {
        const required = ["songId", "songTitle", "sectionId", "sectionLabel", "lyrics"] as const;
        if (!required.every((key) => typeof event.payload[key] === "string")) {
          throw new Error("Lyrics cue is missing its song or section content.");
        }
        this.state.lyrics = {
          songId: event.payload.songId as string,
          songTitle: event.payload.songTitle as string,
          sectionId: event.payload.sectionId as string,
          sectionLabel: event.payload.sectionLabel as string,
          lyrics: event.payload.lyrics as string,
          nextLabel: typeof event.payload.nextLabel === "string" ? event.payload.nextLabel : "",
          updatedAt: Date.now(),
          manual: event.payload.manual === true,
          generationKey: event.sourceKey,
        } satisfies LyricsDisplayState;
        this.broadcastLyrics(this.state.lyrics);
        break;
      }

      case "lyrics-clear": {
        const generationKey = typeof event.payload.generationKey === "string"
          ? event.payload.generationKey
          : null;
        if (generationKey && this.state.lyrics?.generationKey !== generationKey) break;
        this.state.lyrics = null;
        this.broadcast(JSON.stringify({ type: "lyrics-clear" } satisfies TimecodeWsMessage));
        break;
      }

      case "pp-trigger-slide":
        await executeProPresenterCommand("trigger-slide");
        break;

      case "pp-trigger-next":
        await executeProPresenterCommand("next");
        break;

      case "pp-trigger-clear":
        await executeProPresenterCommand("clear");
        break;

      case "custom-webhook": {
        const url = event.payload.url;
        if (!isSafeAutomationWebhookUrl(url)) {
          throw new Error("Custom webhook target must be a public HTTPS URL.");
        }
        const response = await fetch(url, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: event.label,
            timecode: this.state.display,
            payload: event.payload,
            firedAt: Date.now(),
          }),
        });
        signal.throwIfAborted();
        await response.body?.cancel();
        if (!response.ok) throw new AutomationRejection("Custom webhook", response.status);
        logResult(event.action, "success", "Custom webhook acknowledged.");
        break;
      }
      default: {
        const unsupported: never = event.action;
        throw new Error(`Unsupported automation action: ${unsupported}`);
      }
    }
  }

  // ─── Broadcasting ───────────────────────────────────────

  private async broadcastState(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment?.() as {
        canWrite?: boolean;
        authClaim?: LiveSessionAuthorityClaim | null;
      } | null;
      if (!(await this.socketMayReceive(ws, attachment))) continue;
      const msg: TimecodeWsMessage = {
        type: "tc-update",
        state: attachment?.canWrite ? this.state : this.getDisplayState(),
      };
      this.send(ws, JSON.stringify(msg));
    }
  }

  private async broadcastEvents(): Promise<void> {
    const msg: TimecodeWsMessage = {
      type: "events-update",
      events: this.events,
    };
    await this.broadcastToWriters(JSON.stringify(msg));
  }

  private async broadcastEventFired(event: AutomationEvent): Promise<void> {
    const msg: TimecodeWsMessage = {
      type: "event-fired",
      event,
      firedAt: Date.now(),
    };
    await this.broadcastToWriters(JSON.stringify(msg));
  }

  private broadcastLyrics(lyrics: LyricsDisplayState): void {
    this.broadcast(JSON.stringify({ type: "lyrics-update", lyrics } satisfies TimecodeWsMessage));
  }

  private broadcast(data: string): void {
    // getWebSockets() is the authoritative list after hibernation wakes.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        try { ws.close(1011, "Broadcast failed"); } catch {}
      }
    }
  }

  private async broadcastToWriters(data: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment?.() as {
        canWrite?: boolean;
        authClaim?: LiveSessionAuthorityClaim | null;
      } | null;
      if (attachment?.canWrite && await this.socketMayReceive(ws, attachment)) this.send(ws, data);
    }
  }

  private async socketMayReceive(
    ws: WebSocket,
    attachment: { canWrite?: boolean; authClaim?: LiveSessionAuthorityClaim | null } | null,
  ): Promise<boolean> {
    if (!attachment?.canWrite || !attachment.authClaim) return true;
    if (await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "timecode:access")) return true;
    ws.close(4403, "Timecode access changed");
    return false;
  }

  private send(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      try { ws.close(1011, "Broadcast failed"); } catch {}
    }
  }

  private getDisplayState(): TimecodeDisplayState {
    return projectTimecodeDisplayState(this.state, Date.now(), this.events);
  }
}
