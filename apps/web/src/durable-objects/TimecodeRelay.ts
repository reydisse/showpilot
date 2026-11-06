import { RelaySequenceStore } from "@/lib/relay-sequence.server";
import { renewSocketReadLease, socketReadLeaseAllows, refreshSocketReadLeases, scheduleSocketReadRefresh } from "@/lib/socket-read-authority.server";
import { rundownInternalRequest } from "@/lib/rundown-internal-request.server";
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
  TimecodeControlStatus,
} from "@/types/timecode";
import { sameTimecodeFormat, normalizeTimecodeForFormat, isLargeTimecodeJump, framesToTimecode, crossedTriggerFrame, isSafeAutomationWebhookUrl, isValidTimecode, isValidTimecodeFormat, replaceAutomationEventGroup, timecodeToFrames, timecodeToString } from "@/lib/timecode";
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
import { TIMECODE_COMMANDS } from "@/types/timecode";
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

interface TimecodeSocketAttachment {
  canWrite?: boolean;
  sessionId?: string;
  orgId?: string;
  showId?: string;
  authClaim?: LiveSessionAuthorityClaim | null;
  controlsTimecode?: boolean;
}
const commandSchema = z.object({ action: z.enum(TIMECODE_COMMANDS), payload: z.record(z.string(), z.unknown()).optional() });

interface TimecodeSnapshot { state: TimecodeState; events: AutomationEvent[]; target?: TimecodeTarget }
interface LegacyTimecodeExport { target: TimecodeTarget; snapshot: TimecodeSnapshot | null }

const FEED_STALL_MS = 500;
const FEED_LOST_MS = 2000;
const FORMAT_STABILITY_FEEDS = 5;
interface FormatCandidate { format: TimecodeFormat; count: number; receivedAt: number; producer: string | null }
interface BridgeFeed { timecode: TimecodeValue; format: TimecodeFormat; receivedAt: number }
/** Small durable journal; never rewrite the full event timeline at feed rate. */
interface ClockSnapshot {
  state: Pick<TimecodeState, "timecode" | "display" | "totalFrames" | "format" | "source" | "running" | "serverTime" | "signal" | "triggersEnabled" | "automationHold" | "incomingFormat">;
  previousFeedFrame: number | null;
  masterSessionId: string | null;
  expectedFeedSince: number | null;
  bridgeFeed: BridgeFeed | null;
  formatCandidate?: FormatCandidate | null;
}

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
    signal: { status: "idle", lastFeedAt: null },
  };
  private events: AutomationEvent[] = [];
  private orgId = "";
  private target: TimecodeTarget | null = null;
  private legacyExport: LegacyTimecodeExport | null = null;
  private hasSnapshot = false;
  private retired = false;
  private previousFeedFrame: number | null = null;
  // Invalidates queued scheduled work across Stop, disable, seek and large jumps.
  private automationGeneration = 0;
  private masterSessionId: string | null = null;
  private expectedFeedSince: number | null = null;
  private bridgeFeed: BridgeFeed | null = null;
  private formatCandidate: FormatCandidate | null = null;
  private lastPersistedAt = 0;
  private readonly executor = new AutomationExecutor();
  private readonly revisions: RelaySequenceStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.revisions = new RelaySequenceStore(ctx.storage.sql);
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
      const clock = await ctx.storage.get<ClockSnapshot>("clock");
      if (clock && !this.retired && !this.legacyExport) {
        this.state = { ...this.state, ...clock.state };
        this.previousFeedFrame = clock.previousFeedFrame;
        this.masterSessionId = clock.masterSessionId;
        if (this.masterSessionId) {
          const producer = ctx.getWebSockets().find(socket => socket.readyState === WebSocket.OPEN
            && (socket.deserializeAttachment() as TimecodeSocketAttachment | null)?.sessionId === this.masterSessionId);
          // A closing socket still needs webSocketClose to promote standby MTC.
          // An already-running generator from before control ownership existed
          // keeps control across deployment/hibernation. Viewing cannot steal it.
          if (producer && !this.controlOwner()) producer.serializeAttachment({ ...producer.deserializeAttachment(), controlsTimecode: true });
        }
        this.expectedFeedSince = clock.expectedFeedSince;
        this.bridgeFeed = clock.bridgeFeed;
        this.formatCandidate = clock.formatCandidate ?? null;
        if (this.updateSignalHealth()) {
          await this.persistClock();
          this.broadcastState();
        }
      }
    });
  }

  private async persist(): Promise<void> {
    if (this.retired) return;
    await this.ctx.storage.put({
      timecode: { state: this.state, events: this.events, ...(this.target ? { target: this.target } : {}) } satisfies TimecodeSnapshot,
      clock: this.clockSnapshot(),
    });
    await this.scheduleAlarm();
    this.hasSnapshot = true;
    this.lastPersistedAt = Date.now();
  }

  private clockSnapshot(): ClockSnapshot {
    const { timecode, display, totalFrames, format, source, running, serverTime, signal, triggersEnabled, automationHold, incomingFormat } = this.state;
    return { state: { timecode, display, totalFrames, format, source, running, serverTime, signal, triggersEnabled, automationHold, incomingFormat },
      previousFeedFrame: this.previousFeedFrame, masterSessionId: this.masterSessionId,
      expectedFeedSince: this.expectedFeedSince, bridgeFeed: this.bridgeFeed, formatCandidate: this.formatCandidate };
  }

  private async persistClock(): Promise<void> {
    if (this.retired) return;
    await this.ctx.storage.put("clock", this.clockSnapshot());
    await this.scheduleAlarm();
  }

  private feedDeadline(): number | null {
    const signal = this.state.signal;
    const last = signal?.lastFeedAt ?? this.expectedFeedSince;
    if (!signal || last === null || signal.status === "idle" || signal.status === "timecode-lost") return null;
    return last + (signal.status === "timecode-stalled" ? FEED_LOST_MS : FEED_STALL_MS);
  }

  private scheduleAlarm(): Promise<void> {
    return scheduleSocketReadRefresh(this.ctx, socket => this.socketNeedsReadLease(socket), this.feedDeadline());
  }

  private updateSignalHealth(): boolean {
    const signal = this.state.signal;
    const last = signal?.lastFeedAt ?? this.expectedFeedSince;
    if (!signal || signal.status === "idle" || last === null) return false;
    const age = Date.now() - last;
    if (age < FEED_STALL_MS) return false;
    const status = age >= FEED_LOST_MS ? "timecode-lost" : "timecode-stalled";
    if (signal.status === status) return false;
    this.automationGeneration++;
    this.state.signal = { ...signal, status };
    this.state.running = false;
    this.state.serverTime = Date.now();
    return true;
  }

  private holdClock(): void {
    this.formatCandidate = null;
    this.state.incomingFormat = null;
    this.automationGeneration++;
    this.state.running = false;
    this.state.signal = { status: "idle", lastFeedAt: this.state.signal?.lastFeedAt ?? null };
    this.expectedFeedSince = null;
    this.previousFeedFrame = null;
  }

  private holdForJump(previousFrame: number | null, currentFrame: number, format = this.state.format): void {
    if (!isLargeTimecodeJump(previousFrame, currentFrame, format) || previousFrame === null) return;
    this.automationGeneration++;
    this.state.triggersEnabled = false;
    this.state.automationHold = {
      id: crypto.randomUUID(), reason: "timecode-jump", detectedAt: Date.now(),
      from: timecodeToString(framesToTimecode(previousFrame, format), format.dropFrame === "df"),
      to: timecodeToString(framesToTimecode(currentFrame, format), format.dropFrame === "df"),
    };
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

  // Ownership lives with the hibernating socket attachment. A viewer never
  // locks the show, and a closed connection cannot leave a durable stale lock.
  // This is independent of masterSessionId, which selects the clock producer.
  private controlOwner(): { socket: WebSocket; attachment: TimecodeSocketAttachment } | null {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as TimecodeSocketAttachment | null;
      if (socket.readyState === WebSocket.OPEN && attachment?.controlsTimecode) return { socket, attachment };
    }
    return null;
  }

  private controlStatus(socket: WebSocket): TimecodeControlStatus {
    const owner = this.controlOwner();
    return !owner ? "available" : owner.socket === socket ? "yours" : "other";
  }

  private broadcastControl(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as TimecodeSocketAttachment | null;
      if (!attachment?.canWrite || socket.readyState !== WebSocket.OPEN || !socketReadLeaseAllows(socket, true)) continue;
      try { socket.send(JSON.stringify({ type: "control-status", control: this.controlStatus(socket) } satisfies TimecodeWsMessage)); }
      catch { socket.close(1011, "Control status unavailable"); }
    }
  }

  private authorizeControl(socket: WebSocket, action: TimecodeCommand): boolean {
    if (action === "bridge-disconnected") throw new TimecodeCommandRejection("Bridge status requires the internal feed endpoint.");
    const attachment = socket.deserializeAttachment() as TimecodeSocketAttachment;
    const owner = this.controlOwner();
    if (owner && owner.socket !== socket) throw new TimecodeCommandRejection("Another operator controls timecode. Ask them to release control first.");
    if (action === "feed-tc" && (!owner || this.masterSessionId !== attachment.sessionId)) {
      throw new TimecodeCommandRejection("Start the local timecode source before sending a feed.");
    }
    if (action === "release-control") {
      if (this.masterSessionId === attachment.sessionId) throw new TimecodeCommandRejection("Stop the local timecode source before releasing control.");
      socket.serializeAttachment({ ...attachment, controlsTimecode: false });
      this.broadcastControl();
      return false;
    }
    if (!owner) {
      // An explicit edit/start takes free control synchronously, before any I/O.
      // Merely opening the screen, syncing or receiving MTC does not claim it.
      socket.serializeAttachment({ ...attachment, controlsTimecode: true });
      this.broadcastControl();
    }
    return action !== "claim-control";
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
        this.bridgeFeed = null;
        await this.persistClock();
        if (!this.masterSessionId) await this.handleCommand("bridge-disconnected");
      } else {
        const body = await request.json<{ payload?: Record<string, unknown> }>();
        const format = body.payload?.format;
        const tc = eventUpdateSchema.shape.triggerTimecode.safeParse(body.payload?.timecode);
        if (!isValidTimecodeFormat(format) || !tc.success || !tc.data || !isValidTimecode(tc.data, format)) {
          return Response.json({ error: "Invalid Bridge timecode" }, { status: 400 });
        }
        this.bridgeFeed = { timecode: tc.data, format, receivedAt: Date.now() };
        if (this.masterSessionId) await this.persistClock();
        else {
          this.state.source = "mtc";
          await this.handleCommand("feed-tc", body.payload);
        }
      }
      return Response.json({ ok: true, showId: this.target.showId, serviceDate: this.target.serviceDate });
    }

    const authClaim = this.readAuthorityClaim(url);
    const canWrite = url.searchParams.get("access") === "write"
      && authClaim !== null
      && await hasLivePermissionAuthority(this.env.DB, authClaim, "timecode:access");

    if (url.pathname === "/ws") {
      if (authClaim && !canWrite) return new Response("Unauthorized", { status: 401 });
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

      if (canWrite) renewSocketReadLease(server);
      await this.scheduleAlarm();

      this.hydrate(server);

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
      const body = commandSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return Response.json({ error: "Invalid timecode command" }, { status: 400 });
      const owner = this.controlOwner();
      if (!owner || owner.attachment.authClaim?.sessionId !== authClaim?.sessionId
        || owner.attachment.authClaim?.userId !== authClaim?.userId) {
        return Response.json({ ok: false, error: "Claim timecode control in a connected operator window first." }, { status: 409 });
      }
      if (["claim-control", "release-control", "bridge-disconnected"].includes(body.data.action)) {
        return Response.json({ error: "This command requires its dedicated connection." }, { status: 400 });
      }
      try { await this.handleCommand(body.data.action, body.data.payload, owner.attachment.sessionId); }
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
      if (msg.type === "sync") { this.hydrate(ws); return; }
      if (msg.type === "command") {
        const attachment = ws.deserializeAttachment?.() as TimecodeSocketAttachment | null;
        if (!attachment?.canWrite) { ws.close(4403, "Timecode write access required"); return; }
        if (this.target && (attachment.orgId !== this.target.orgId || attachment.showId !== this.target.showId)) { ws.close(4409, "Timecode show mismatch"); return; }
        if (
          !attachment.authClaim
          || !(await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "timecode:access"))
        ) {
          ws.close(4403, "Timecode access changed");
          await this.webSocketClose(ws);
          return;
        }
        renewSocketReadLease(ws);
        if (attachment.orgId) this.orgId = attachment.orgId;
        const command = commandSchema.safeParse(msg);
        if (!command.success) { ws.close(4400, "Invalid timecode command"); return; }
        // Permission checks above may yield; reserve ownership only afterwards.
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          if (this.authorizeControl(ws, command.data.action)) {
            await this.handleCommand(command.data.action, command.data.payload, attachment.sessionId);
          }
        }
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
    const attachment = ws.deserializeAttachment?.() as TimecodeSocketAttachment | null;
    if (attachment?.controlsTimecode) {
      ws.serializeAttachment({ ...attachment, controlsTimecode: false });
      this.broadcastControl();
    }
    if (attachment?.sessionId && attachment.sessionId === this.masterSessionId) {
      this.automationGeneration++;
      this.masterSessionId = null;
      const previousFrame = this.previousFeedFrame;
      this.previousFeedFrame = null;
      const standby = this.bridgeFeed;
      if (standby && Date.now() - standby.receivedAt < FEED_STALL_MS) {
        if (sameTimecodeFormat(standby.format, this.state.format)) {
          this.holdForJump(previousFrame, timecodeToFrames(standby.timecode, standby.format));
        }
        this.state.running = false;
        this.state.signal = { status: "waiting", lastFeedAt: null };
        this.expectedFeedSince = Date.now();
        this.state.source = "mtc";
        await this.handleCommand("feed-tc", { timecode: standby.timecode, format: standby.format }, undefined, standby.receivedAt);
        return;
      }
      // Retain the loss deadline so a disconnected source reports loss rather
      // than looking like an intentional Stop. The held frame never advances.
      this.state.running = false;
      this.state.signal = { status: "timecode-stalled", lastFeedAt: this.state.signal?.lastFeedAt ?? null };
      this.expectedFeedSince ??= Date.now();
      await this.persist();
      this.broadcastState();
    }
  }

  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws); }

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
    feedReceivedAt = Date.now(),
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
        this.expectedFeedSince = Date.now();
        this.state.signal = { status: "waiting", lastFeedAt: null };
        await this.persist();
        this.broadcastState();
        break;

      case "stop":
        if (sessionId && this.masterSessionId && this.masterSessionId !== sessionId) break;
        this.masterSessionId = null;
        this.sendMasterStatus(sessionId, false);
        this.holdClock();
        await this.persist();
        this.broadcastState();
        break;

      case "feed-tc": {
        if (sessionId && this.masterSessionId !== sessionId) throw new TimecodeCommandRejection("Start the local timecode source before sending a feed.");
        if (!payload) break;
        const tc = payload.timecode as TimecodeValue;
        const format = (payload.format as TimecodeFormat) ?? this.state.format;
        if (!isValidTimecodeFormat(format) || !tc || !isValidTimecode(tc, format)) break;
        this.updateSignalHealth();
        if (!sameTimecodeFormat(format, this.state.format)) {
          const proposalChanged = this.state.incomingFormat && !sameTimecodeFormat(this.state.incomingFormat.format, format);
          if (proposalChanged) this.state.incomingFormat = null;
          const prior = this.formatCandidate;
          const sameInput = prior && prior.producer === (sessionId ?? null)
            && sameTimecodeFormat(prior.format, format) && feedReceivedAt - prior.receivedAt < FEED_STALL_MS;
          this.formatCandidate = { format, producer: sessionId ?? null, receivedAt: feedReceivedAt,
            count: sameInput ? Math.min(FORMAT_STABILITY_FEEDS, prior.count + 1) : 1 };
          if (this.formatCandidate.count >= FORMAT_STABILITY_FEEDS) {
            if (!this.state.incomingFormat || !sameTimecodeFormat(this.state.incomingFormat.format, format)) {
              this.state.incomingFormat = { id: crypto.randomUUID(), format };
              this.automationGeneration++;
            }
            this.state.triggersEnabled = false;
            this.state.running = false;
            this.state.signal = { status: "format-mismatch", lastFeedAt: feedReceivedAt };
            this.state.serverTime = Date.now();
            this.expectedFeedSince = null;
            if (!sessionId) this.state.source = "mtc";
          }
          // Keep the clock/timeline in their confirmed format. Never execute a
          // feed at the wrong rate or count a different producer's observations.
          await this.persistClock();
          if (this.state.incomingFormat || proposalChanged) this.broadcastState();
          break;
        }
        this.formatCandidate = null;
        this.state.incomingFormat = null;
        const previousPosition = this.previousFeedFrame;
        // The relay derives frame position from the accepted format instead of
        // trusting a stale client-side conversion.
        const totalFrames = timecodeToFrames(tc, format);
        this.holdForJump(previousPosition, totalFrames);

        const resuming = this.state.signal?.status === "timecode-stalled" || this.state.signal?.status === "timecode-lost"
          || this.state.signal?.status === "format-mismatch";
        this.state.timecode = tc;
        this.state.totalFrames = totalFrames;
        this.state.display = timecodeToString(tc, format.dropFrame === "df");
        this.state.format = format;
        if (!sessionId) this.state.source = "mtc";
        this.state.running = true;
        this.state.serverTime = Date.now();
        this.state.signal = { status: "live", lastFeedAt: feedReceivedAt };
        this.expectedFeedSince = null;

        // Evaluate automation events
        // A lost feed is a gap, never an instruction to catch up missed cues.
        // A resumed but unchanged frame is not a new startup match. This also
        // prevents a cue at the reviewed position from firing after re-arm.
        const previousFrame = resuming && totalFrames !== this.previousFeedFrame ? null : this.previousFeedFrame;
        this.previousFeedFrame = totalFrames;
        const feedGeneration = this.automationGeneration;
        await this.persistClock();
        // Clock delivery cannot wait for device or webhook acknowledgement.
        this.broadcastState();
        const eventFired = feedGeneration === this.automationGeneration
          && await this.evaluateEvents(previousFrame, totalFrames);

        // Persist automation results immediately; otherwise snapshot the
        // running clock at a modest cadence instead of writing at 10 Hz.
        if (eventFired || Date.now() - this.lastPersistedAt >= 5_000) {
          await this.persist();
        }
        this.broadcastState();
        break;
      }

      case "bridge-disconnected":
        if (this.state.source !== "mtc") break;
        this.automationGeneration++;
        this.masterSessionId = null;
        this.state.running = false;
        this.state.signal = { status: "timecode-stalled", lastFeedAt: this.state.signal?.lastFeedAt ?? null };
        this.expectedFeedSince ??= Date.now();
        await this.persist();
        this.broadcastState();
        break;

      case "set-timecode": {
        if (!payload) break;
        const tc = payload.timecode as TimecodeValue;
        if (!tc || !isValidTimecode(tc, this.state.format)) break;
        const totalFrames = timecodeToFrames(tc, this.state.format);
        this.holdForJump(this.state.totalFrames, totalFrames);
        this.automationGeneration++;
        this.state.timecode = tc;
        this.state.totalFrames = totalFrames;
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
        // These are the only sources with an actual producer today. Extend
        // this boundary when LTC/network/rundown producers are implemented.
        if (payload?.source !== "internal-freerun" && payload?.source !== "mtc") {
          throw new TimecodeCommandRejection("This timecode source is not implemented.");
        }
        this.state.source = payload.source;
        await this.persist();
        this.broadcastState();
        break;

      case "set-format": {
        const format = payload?.format;
        if (!isValidTimecodeFormat(format) || !isValidTimecodeFormat(payload?.expectedFormat) || payload?.confirmed !== true) {
          throw new TimecodeCommandRejection("Confirm Reformat timeline before changing the frame rate.");
        }
        if (!sameTimecodeFormat(payload.expectedFormat, this.state.format)) {
          throw new TimecodeCommandRejection("The timeline format changed. Review the new format before confirming.");
        }
        if (this.state.running) throw new TimecodeCommandRejection("Stop the clock before reformatting the timeline.");
        const incoming = this.state.incomingFormat;
        if (incoming ? payload.expectedIncomingFormatId !== incoming.id || !sameTimecodeFormat(incoming.format, format)
          : Boolean(payload.expectedIncomingFormatId)) {
          throw new TimecodeCommandRejection("The input format changed. Review the latest detected format.");
        }
        const invalid = this.events.find(event => !isValidTimecode(event.triggerTimecode, format));
        if (invalid) throw new TimecodeCommandRejection(`Cue “${invalid.label}” has a timecode that is invalid at the new frame rate. Correct or remove that cue before reformatting.`);
        this.automationGeneration++;
        this.state.triggersEnabled = false;
        this.state.format = format;
        this.state.timecode = normalizeTimecodeForFormat(this.state.timecode, format);
        this.state.totalFrames = timecodeToFrames(this.state.timecode, format);
        this.state.display = timecodeToString(this.state.timecode, format.dropFrame === "df");
        this.state.serverTime = Date.now();
        this.state.incomingFormat = null;
        this.formatCandidate = null;
        for (const event of this.events) event.triggerFrame = timecodeToFrames(event.triggerTimecode, format);
        this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
        // Preserve the baseline for jump detection when the newly formatted
        // input resumes. Neither fired cues nor review holds are re-armed here.
        this.previousFeedFrame = this.state.totalFrames;
        if (this.state.signal?.status === "format-mismatch") {
          this.state.signal = { status: "waiting", lastFeedAt: null };
          this.expectedFeedSince = Date.now();
        }
        await this.persist();
        this.broadcastState();
        this.broadcastEvents();
        break;
      }

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
          this.broadcastEvents();
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
        this.broadcastEvents();
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
        this.broadcastEvents();
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

      case "set-triggers-enabled":
        if (typeof payload?.enabled !== "boolean") break;
        if (payload.enabled && this.state.incomingFormat) throw new TimecodeCommandRejection("Confirm the input format before enabling automation.");
        if (payload.enabled && this.state.automationHold) {
          if (payload.confirmed !== true || payload.expectedHoldId !== this.state.automationHold.id) {
            throw new TimecodeCommandRejection("Review the latest timecode jump before resuming automation.");
          }
          this.state.automationHold = null;
          // Resume from the current frame. Never replay cues crossed while held.
          this.previousFeedFrame = this.state.totalFrames;
        } else if (payload.enabled && payload.expectedHoldId) {
          throw new TimecodeCommandRejection("Automation review changed. Refresh before resuming.");
        }
        if (!payload.enabled) this.automationGeneration++;
        this.state.triggersEnabled = payload.enabled;
        await this.persist();
        this.broadcastState();
        break;

      case "set-event-enabled": {
        if (typeof payload?.id !== "string" || typeof payload.enabled !== "boolean") break;
        const event = this.events.find((candidate) => candidate.id === payload.id);
        if (!event) break;
        event.enabled = payload.enabled;
        await this.persist();
        this.broadcastEvents();
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
        this.broadcastState();
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
        this.broadcastEvents();
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
        this.broadcastState();
        break;
      }

      case "clear-lyrics":
        this.state.lyrics = null;
        await this.persist();
        this.broadcast({ type: "lyrics-clear" });
        this.broadcastState();
        break;
    }
  }

  // ─── Automation Engine ──────────────────────────────────

  private async evaluateEvents(previousFrame: number | null, totalFrames: number): Promise<boolean> {
    if (!this.state.triggersEnabled || !this.state.running) return false;
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
      executions.push(this.runEvent(event, true));
    }
    await Promise.allSettled(executions);
    return executions.length > 0;
  }

  private async runEvent(event: AutomationEvent, requiresLiveFeed = false): Promise<void> {
    // Reserve before yielding, so concurrent feed messages cannot dispatch twice.
    event.executionStatus = "dispatching";
    event.executionAttempts = (event.executionAttempts ?? 0) + 1;
    event.executionStartedAt ??= Date.now();
    event.executionId ??= crypto.randomUUID();
    const startedAt = Date.now();
    const generation = this.automationGeneration;
    delete event.executionError;
    try {
      // Reserve output order before the first await. Persist the dispatch
      // before external effects so restart recovery can detect uncertainty.
      await this.executor.run(
        automationOutput(event),
        event.action === "custom-webhook" ? 5000 : 10000,
        async (signal) => {
          await this.persist();
          this.broadcastEvents();
          await this.executeEventAction(event, signal, requiresLiveFeed, generation);
        },
      );
      event.fired = true;
      event.executionStatus = "acknowledged";
    } catch (error) {
      if (error instanceof AutomationCancelled) {
        event.executionStatus = "scheduled";
        this.broadcastEvents();
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
    this.broadcastEventFired(event);
    this.broadcastEvents();
    this.broadcastState();
  }

  private async executeEventAction(event: AutomationEvent, signal: AbortSignal, requiresLiveFeed: boolean, generation: number): Promise<void> {
    const env = this.env as unknown as Env;
    const assertCanDispatch = () => {
      signal.throwIfAborted();
      if (requiresLiveFeed && generation !== this.automationGeneration) {
        throw new AutomationCancelled("Automation changed after this cue was queued.");
      }
      const lastFeed = this.state.signal?.lastFeedAt ?? this.expectedFeedSince;
      if (requiresLiveFeed && (!this.state.running || (lastFeed !== null && Date.now() - lastFeed >= FEED_STALL_MS))) {
        throw new AutomationCancelled("Timecode signal lost before dispatch.");
      }
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
        rundownInternalRequest(`https://internal/command?orgId=${encodeURIComponent(this.orgId)}&serviceDate=${encodeURIComponent(target.serviceDate)}${target.showId ? `&showId=${encodeURIComponent(target.showId)}` : ""}&access=control`, env.BETTER_AUTH_SECRET, {
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
        if (!env.BETTER_AUTH_SECRET) throw new Error("Internal graphics authority is not configured.");
        const response = await ltStub.fetch(new Request(`https://internal/internal/${show ? "trigger" : "clear"}`, {
          method: "POST",
          headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
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
        this.broadcast({ type: "lyrics-clear" });
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

  private hydrate(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as { canWrite?: boolean } | null;
    this.send(ws, attachment?.canWrite
      ? { type: "hydrate", state: this.state, events: this.events, control: this.controlStatus(ws) }
      : { type: "hydrate", state: this.getDisplayState() }, this.revisions.current());
  }

  private broadcastState(): void {
    const sequence = this.revisions.next();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment?.() as {
        canWrite?: boolean;
        authClaim?: LiveSessionAuthorityClaim | null;
      } | null;
      const msg: TimecodeWsMessage = {
        type: "tc-update",
        state: attachment?.canWrite ? this.state : this.getDisplayState(),
      };
      this.send(ws, msg, sequence);
    }
  }

  private broadcastEvents(): void {
    const msg: TimecodeWsMessage = {
      type: "events-update",
      events: this.events,
    };
    this.broadcastToWriters(msg);
  }

  private broadcastEventFired(event: AutomationEvent): void {
    const msg: TimecodeWsMessage = {
      type: "event-fired",
      event,
      firedAt: Date.now(),
    };
    this.broadcastToWriters(msg);
  }

  private broadcastLyrics(lyrics: LyricsDisplayState): void {
    this.broadcast({ type: "lyrics-update", lyrics });
  }

  private broadcast(data: TimecodeWsMessage): void {
    const sequence = this.revisions.next();
    for (const ws of this.ctx.getWebSockets()) this.send(ws, data, sequence);
  }

  private broadcastToWriters(data: TimecodeWsMessage): void {
    const sequence = this.revisions.next();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment?.() as {
        canWrite?: boolean;
        authClaim?: LiveSessionAuthorityClaim | null;
      } | null;
      if (attachment?.canWrite) this.send(ws, data, sequence);
    }
  }

  private socketNeedsReadLease(socket: WebSocket): boolean {
    const attachment = socket.deserializeAttachment() as { canWrite?: boolean } | null;
    return attachment?.canWrite === true;
  }

  /** Worker-only RPC used by permission changes; alarms handle missed pushes. */
  async refreshReadAuthority(userId?: string, onlyDue = false): Promise<void> {
    await refreshSocketReadLeases(this.ctx.getWebSockets(), async socket => {
      const attachment = socket.deserializeAttachment() as { canWrite?: boolean; authClaim?: LiveSessionAuthorityClaim | null; readAuthorizedUntil?: number } | null;
      if (!attachment?.canWrite) return null;
      if (userId && attachment.authClaim?.userId !== userId) return null;
      if (onlyDue && (attachment.readAuthorizedUntil ?? 0) > Date.now() + 30_000) return null;
      const allowed = Boolean(attachment.authClaim && await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "timecode:access"));
      if (!allowed) await this.webSocketClose(socket);
      return allowed;
    });
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    const checkingFeed = this.feedDeadline() !== null;
    if (this.updateSignalHealth()) {
      await this.persistClock();
      this.broadcastState();
    }
    // The 500ms watchdog must not turn read-lease renewal into 2Hz D1 polling.
    await this.refreshReadAuthority(undefined, checkingFeed);
  }

  private send(ws: WebSocket, data: TimecodeWsMessage, sequence: number): void {
    if (!displaySocketMayReceive(ws) || !socketReadLeaseAllows(ws, this.socketNeedsReadLease(ws))) return;
    try {
      ws.send(JSON.stringify({ ...data, ...this.revisions.envelope(ws, sequence) }));
    } catch {
      try { ws.close(1011, "Broadcast failed"); } catch {}
    }
  }

  private getDisplayState(): TimecodeDisplayState {
    return projectTimecodeDisplayState(this.state, Date.now(), this.events);
  }
}
