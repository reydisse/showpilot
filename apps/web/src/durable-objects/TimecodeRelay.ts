import { DurableObject } from "cloudflare:workers";
import { displaySocketMayReceive } from "@/lib/display-access.server";
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
import { resolveTimecodeTarget, timecodeRelayKey, type TimecodeTarget } from "@/lib/timecode-target.server";
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
class TimecodeCommandRejection extends Error {}

interface TimecodeSnapshot { state: TimecodeState; events: AutomationEvent[]; target?: TimecodeTarget }
interface LegacyTimecodeExport { target: TimecodeTarget; snapshot: TimecodeSnapshot | null }

function recoverInterruptedEvents(events: AutomationEvent[]): AutomationEvent[] {
  return events.map(event => ({ ...event, enabled: event.enabled ?? true,
    ...(event.executionStatus === "dispatching" ? {
      fired: false, executionStatus: "failed" as const,
      executionError: "Acknowledgement interrupted. Check the output before retrying.", executionAttempts: 3,
    } : {}),
  }));
}

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
  private target: TimecodeTarget | null = null;
  private legacyExport: LegacyTimecodeExport | null = null;
  private hasSnapshot = false;
  private retired = false;
  private previousFeedFrame: number | null = null;
  private masterSessionId: string | null = null;
  private lastPersistedAt = 0;
  private readonly executor = new AutomationExecutor();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<TimecodeSnapshot>("timecode");
      this.retired = await ctx.storage.get<boolean>("retired") ?? false;
      this.legacyExport = await ctx.storage.get<LegacyTimecodeExport>("legacy-export") ?? null;
      this.hasSnapshot = Boolean(stored);
      if (stored) {
        this.target = stored.target ?? null;
        this.orgId = this.target?.orgId ?? this.legacyExport?.target.orgId ?? "";
        this.state = {
          ...stored.state,
          triggersEnabled: stored.state.triggersEnabled ?? true,
          running: false,
          serverTime: Date.now(),
          lyrics: stored.state.lyrics ?? null,
        };
        this.events = recoverInterruptedEvents(stored.events ?? []);
      }
    });
  }

  private async persist(): Promise<void> {
    if (this.retired) return;
    await this.ctx.storage.put("timecode", { state: this.state, events: this.events, ...(this.target ? { target: this.target } : {}) } satisfies TimecodeSnapshot);
    this.hasSnapshot = true;
    this.lastPersistedAt = Date.now();
  }

  /** Internal RPC: one durable room owns one stable show for its lifetime. */
  async bindShow(target: TimecodeTarget, refreshMetadata = false): Promise<{ ok: true } | { ok: false; error: string }> {
    const error = await this.ctx.blockConcurrencyWhile(async () => {
      if (this.retired) return "This show's timecode has been retired";
      if (this.target) {
        if (target.orgId !== this.target.orgId || target.showId !== this.target.showId) return "Timecode room belongs to another show";
        // Only a freshly resolved Worker target may refresh the date. A Bridge
        // connection can hold an older date after the same show is rescheduled.
        if (refreshMetadata && target.serviceDate !== this.target.serviceDate) {
          this.target = target;
          this.state.serviceDate = target.serviceDate;
          await this.persist();
        }
        return null;
      }
      if (this.legacyExport) return "Legacy timecode room cannot become a show room";
      const resolved = await resolveTimecodeTarget(this.env.DB, target.orgId, target.showId);
      if (!resolved) return "This show is unavailable";
      const legacy = this.env.TIMECODE_RELAY.getByName(target.orgId);
      // Cue payloads are JSON data, not RPC capabilities. Stream the stored
      // snapshot through the internal Response contract during this one-time move.
      const exported = await legacy.exportLegacyForShow(resolved);
      const snapshot = await exported.json<TimecodeSnapshot | null>();
      this.target = resolved;
      this.orgId = resolved.orgId;
      if (snapshot) {
        // Preserve cue history, but never resume imported automation implicitly.
        this.state = { ...snapshot.state, running: false, triggersEnabled: false, serverTime: Date.now() };
        this.events = recoverInterruptedEvents(snapshot.events);
      }
      this.state.showId = resolved.showId;
      this.state.serviceDate = resolved.serviceDate;
      await this.persist();
      return null;
    });
    return error ? { ok: false, error } : { ok: true };
  }

  /** Internal RPC: atomically assign the old timeline to exactly one show. */
  async exportLegacyForShow(requested: TimecodeTarget): Promise<Response> {
    if (this.target) throw new Error("A show room is not a legacy timeline");
    if (this.orgId && this.orgId !== requested.orgId) throw new Error("Organization mismatch");
    const snapshot = await this.ctx.blockConcurrencyWhile(async () => {
      this.orgId = requested.orgId;
      if (!this.legacyExport) {
        const owner = await resolveTimecodeTarget(this.env.DB, requested.orgId);
        if (!owner) return null;
        this.legacyExport = {
          target: owner,
          snapshot: this.hasSnapshot ? structuredClone({ state: { ...this.state, running: false, triggersEnabled: false }, events: this.events }) : null,
        };
        await this.ctx.storage.put("legacy-export", this.legacyExport);
        this.state.running = false;
        this.state.triggersEnabled = false;
        this.masterSessionId = null;
        for (const socket of this.ctx.getWebSockets()) socket.close(4409, "Timecode now belongs to a show. Reconnect.");
      }
      return this.legacyExport.target.showId === requested.showId ? this.legacyExport.snapshot : null;
    });
    return Response.json(snapshot);
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

    if ((url.pathname === "/internal/purge-org" || url.pathname === "/internal/purge-show") && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/internal/purge-show" && this.target && (
        url.searchParams.get("orgId") !== this.target.orgId || url.searchParams.get("showId") !== this.target.showId
      )) return new Response("Timecode show mismatch", { status: 409 });
      // A Bridge may still hold this room's identity. Retire it permanently so
      // a late feed or a retry cannot resurrect a deleted show or its timeline.
      this.retired = true;
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Timecode show deleted");
      await this.ctx.storage.transaction(async storage => {
        const keys = await storage.list();
        await storage.delete([...keys.keys()]);
        await storage.put("retired", true);
      });
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
      this.target = null;
      this.legacyExport = null;
      this.hasSnapshot = false;
      return Response.json({ ok: true });
    }

    if (this.retired) return Response.json({ error: "This show's timecode has been retired" }, { status: 410 });
    if (!this.target || this.legacyExport) return Response.json({ error: "Choose a show for timecode." }, { status: 409 });
    if (this.target && (url.searchParams.get("orgId") !== this.target.orgId || url.searchParams.get("showId") !== this.target.showId)) {
      return Response.json({ error: "Timecode show mismatch" }, { status: 409 });
    }
    this.orgId = this.target?.orgId ?? url.searchParams.get("orgId") ?? this.orgId;

    if (url.pathname === "/internal/bridge-feed" || url.pathname === "/internal/bridge-disconnected") {
      if (request.method !== "POST" || !this.target || !this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/internal/bridge-disconnected") {
        if (!this.masterSessionId) await this.handleCommand("bridge-disconnected");
      } else {
        if (this.masterSessionId) return Response.json({ error: "An operator controls this clock" }, { status: 409 });
        const body = await request.json<{ payload?: Record<string, unknown> }>();
        const format = body.payload?.format;
        const tc = eventUpdateSchema.shape.triggerTimecode.safeParse(body.payload?.timecode);
        if (!isValidTimecodeFormat(format) || !tc.success || !tc.data || !isValidTimecode(tc.data, format)) {
          return Response.json({ error: "Invalid Bridge timecode" }, { status: 400 });
        }
        this.state.source = "mtc";
        await this.handleCommand("feed-tc", body.payload);
      }
      return Response.json({ ok: true, showId: this.target.showId, serviceDate: this.target.serviceDate });
    }

    const authClaim = this.readAuthorityClaim(url);
    const canWrite = url.searchParams.get("access") === "write"
      && authClaim !== null
      && await hasLivePermissionAuthority(this.env.DB, authClaim, "timecode:access");

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({
        canWrite,
        sessionId: crypto.randomUUID(),
        orgId: this.orgId,
        showId: this.target?.showId,
        authClaim,
        displayExpiresAt: url.searchParams.has("authDisplayExpiresAt") ? Number(url.searchParams.get("authDisplayExpiresAt")) : undefined,
      });

      // Hydrate
      const hydrate: TimecodeWsMessage = canWrite
        ? { type: "hydrate", state: this.state, events: this.events }
        : { type: "hydrate", state: this.getDisplayState() };
      server.send(JSON.stringify(hydrate));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      return Response.json(
        canWrite ? this.state : this.getDisplayState(),
      );
    }

    if (url.pathname === "/events") {
      if (!canWrite) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json(this.events);
    }

    if (url.pathname === "/command" && request.method === "POST") {
      if (!canWrite) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = (await request.json()) as {
        action: TimecodeCommand;
        payload?: Record<string, unknown>;
      };
      try { await this.handleCommand(body.action, body.payload); }
      catch (error) {
        if (error instanceof TimecodeCommandRejection) return Response.json({ ok: false, error: error.message }, { status: 400 });
        throw error;
      }
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (this.retired || !this.target || this.legacyExport) { ws.close(4409, "Timecode show unavailable. Reconnect."); return; }
    try {
      const msg = JSON.parse(data as string) as TimecodeWsMessage;
      if (msg.type === "command") {
        const attachment = ws.deserializeAttachment?.() as {
          canWrite?: boolean;
          sessionId?: string;
          orgId?: string;
          showId?: string;
          authClaim?: LiveSessionAuthorityClaim | null;
        } | null;
        if (!attachment?.canWrite) { ws.close(4403, "Timecode write access required"); return; }
        if (this.target && (attachment.orgId !== this.target.orgId || attachment.showId !== this.target.showId)) { ws.close(4409, "Timecode show mismatch"); return; }
        if (
          !attachment.authClaim
          || !(await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "timecode:access"))
        ) {
          ws.close(4403, "Timecode access changed");
          return;
        }
        if (attachment.orgId) this.orgId = attachment.orgId;
        try { await this.handleCommand(msg.action, msg.payload, attachment.sessionId); }
        catch (error) {
          if (!(error instanceof TimecodeCommandRejection)) throw error;
          ws.send(JSON.stringify({ type: "command-rejected", action: msg.action, error: error.message } satisfies TimecodeWsMessage));
        }
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
            // Reformatting never re-arms an acknowledged cue. Only Reset/Retry may do that.
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
        // These are the only sources with an actual producer today. Extend
        // this boundary when LTC/network/rundown producers are implemented.
        if (payload?.source !== "internal-freerun" && payload?.source !== "mtc") {
          throw new TimecodeCommandRejection("This timecode source is not implemented.");
        }
        this.state.source = payload.source;
        await this.persist();
        await this.broadcastState();
        break;

      case "set-format":
        if (isValidTimecodeFormat(payload?.format)) {
          this.state.format = payload.format as TimecodeFormat;
          for (const event of this.events) {
            event.triggerFrame = timecodeToFrames(event.triggerTimecode, this.state.format);
            // Reformatting never re-arms an acknowledged cue. Only Reset/Retry may do that.
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
      if (this.retired || !this.target || !this.state.triggersEnabled || !event.enabled || !this.events.includes(event)) {
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
      if (!this.target) throw new AutomationCancelled("Choose a show before running automation.");
      const target = { ...this.target, key: timecodeRelayKey(this.target) };
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
      if (!displaySocketMayReceive(ws)) continue;
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
    if (!attachment?.canWrite) return true;
    if (attachment.authClaim && await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "timecode:access")) return true;
    ws.close(4403, "Timecode access changed");
    return false;
  }

  private send(ws: WebSocket, data: string): void {
    if (!displaySocketMayReceive(ws)) return;
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
