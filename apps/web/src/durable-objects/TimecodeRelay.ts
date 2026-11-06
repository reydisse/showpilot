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
import { automationDispatchFrame, deviceTimingForEvent, MAX_AUTOMATION_LEAD_MS, MAX_DEVICE_LATENCY_MS, type DeviceTiming } from "@/lib/automation-timing";
import { startPositionProblem, timecodeStartPositionSchema } from "@/lib/timecode-start";
import { z } from "zod";
import { DEFAULT_TIMECODE_TOLERANCE_FRAMES, MAX_TIMECODE_TOLERANCE_FRAMES, TIMECODE_COMMANDS, TIMECODE_FEED_STALL_MS as FEED_STALL_MS } from "@/types/timecode";
import { automationPayloadProblem } from "@/lib/automation-payload";
import { resolveLyricsStep } from "@/lib/lyrics-step.server";
import { lyricsControlSchema, lyricsReviewMatches } from "@/lib/lyrics-control";
import { automationTimecodeSchema, automationEventChangesSchema, automationEditReviewSchema, automationEditReviewMatches } from "@/lib/automation-edit";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { NamedTimerStore } from "@/lib/named-timer-store.server";
import { MediaOutputManager, isMediaOutputSocket } from "@/lib/media-output.server";
import { mediaPlaySchema, mediaStopSchema } from "@/lib/media-output";
import { socketAuthorityClaim } from "@/lib/socket-read-authority.server";
import { namedTimerStartSchema, namedTimerStopSchema } from "@/lib/named-timers";
import { crewMessagePayloadSchema } from "@/lib/crew-message";
import { chatRelayKey } from "@/lib/chat-relay-key";
import { runProPresenterCue } from "@/lib/automation-propresenter";
import { AutomationExecutor, automationOutput, isTriggerControlAction } from "@/lib/automation-execution";
import { cueReviewMatches, nextAutomationEvent, automationControlPriority } from "@/lib/automation-cues";
import { emptyMidiController, midiControllerSchema, type MidiControllerSnapshot } from "@/lib/midi-controller";

interface Env {
  CREDENTIAL_ENCRYPTION_KEYS?: string;
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
  "rundown-goto-item",
  "rundown-previous",
  "rundown-pause",
  "rundown-resume",
  "rundown-stop",
  "rundown-adjust",
  "stage-message",
  "crew-message",
  "timer-start",
  "timer-stop",
  "media-play",
  "media-stop",
  "triggers-disable",
  "triggers-enable",
  "stage-clear",
  "device-action",
  "lighting-scene",
  "lighting-blackout",
  "lyrics-goto",
  "lyrics-next-section",
  "lyrics-previous-section",
  "lyrics-clear",
  "pp-trigger-slide",
  "pp-trigger-next",
  "pp-trigger-previous",
  "pp-trigger-prop",
  "pp-clear-props",
  "pp-trigger-clear",
  "custom-webhook",
]);

// Server-owned acknowledgement and retry fields cannot be patched by clients.
const toleranceFramesSchema = z.number().int().min(0).max(MAX_TIMECODE_TOLERANCE_FRAMES);
const leadMsSchema = z.number().int().min(0).max(MAX_AUTOMATION_LEAD_MS);

const cueReviewSchema = z.object({
  executionId: z.string().nullable(), fired: z.boolean(), skipped: z.boolean(),
}).strict();

function resetCueExecution(event: AutomationEvent): void {
  event.editRevision = crypto.randomUUID();
  event.fired = false;
  delete event.skipped;
  event.executionStatus = "scheduled";
  event.executionAttempts = 0;
  delete event.executionId;
  delete event.executionStartedAt;
  delete event.executionDurationMs;
  delete event.executionRetryable;
  delete event.executionError;
  delete event.executedAt;
}

class AutomationRejection extends Error {
  readonly retryable: boolean;
  constructor(action: string, status: number) {
    super(`${action} failed with ${status}`);
    this.retryable = status === 429 || status === 503;
  }
}

class AutomationCancelled extends Error {}
class TimecodeCommandRejection extends Error {}

function parseTolerance(value: unknown): number {
  const parsed = toleranceFramesSchema.default(DEFAULT_TIMECODE_TOLERANCE_FRAMES).safeParse(value);
  if (!parsed.success) throw new TimecodeCommandRejection(`Tolerance must be a whole number from 0 to ${MAX_TIMECODE_TOLERANCE_FRAMES} frames.`);
  return parsed.data;
}

function parseLeadMs(value: unknown): number {
  const parsed = leadMsSchema.default(0).safeParse(value);
  if (!parsed.success) throw new TimecodeCommandRejection(`Cue lead must be a whole number from 0 to ${MAX_AUTOMATION_LEAD_MS} milliseconds.`);
  return parsed.data;
}

interface TimecodeSocketAttachment {
  canWrite?: boolean;
  sessionId?: string;
  orgId?: string;
  showId?: string;
  authClaim?: LiveSessionAuthorityClaim | null;
  controlsTimecode?: boolean;
}
const commandSchema = z.object({ action: z.enum(TIMECODE_COMMANDS), payload: z.record(z.string(), z.unknown()).optional() });

interface TimecodeSnapshot { state: TimecodeState; events: AutomationEvent[]; target?: TimecodeTarget; deviceTimings?: DeviceTiming[] | null }
interface LegacyTimecodeExport { target: TimecodeTarget; snapshot: TimecodeSnapshot | null }

const FEED_LOST_MS = 2000;
const FORMAT_STABILITY_FEEDS = 5;
interface FormatCandidate { format: TimecodeFormat; count: number; receivedAt: number; producer: string | null }
interface BridgeFeed { source?: "mtc" | "ltc-bridge"; timecode: TimecodeValue; format: TimecodeFormat; receivedAt: number }
/** Small durable journal; never rewrite the full event timeline at feed rate. */
interface ClockSnapshot {
  state: Pick<TimecodeState, "timecode" | "display" | "totalFrames" | "format" | "source" | "running" | "serverTime" | "signal" | "triggersEnabled" | "automaticCuesEnabled" | "automationHold" | "incomingFormat">;
  previousFeedFrame: number | null;
  masterSessionId: string | null;
  expectedFeedSince: number | null;
  bridgeFeed: BridgeFeed | null;
  bridgeTransport?: "stopped" | "waiting" | null;
  formatCandidate?: FormatCandidate | null;
}

function recoverInterruptedEvents(events: AutomationEvent[]): AutomationEvent[] {
  return events.map(event => ({ ...event, enabled: event.enabled ?? true,
    toleranceFrames: event.toleranceFrames ?? DEFAULT_TIMECODE_TOLERANCE_FRAMES,
    ...(event.executionStatus === "dispatching" ? {
      fired: false, executionStatus: "failed" as const,
      executionError: "Acknowledgement interrupted. Check the output before retrying.", executionAttempts: 3,
    } : {}),
  }));
}

export class TimecodeRelay extends DurableObject {
  private deviceTimings: DeviceTiming[] | null = null;
  private timingLoad: Promise<boolean> | null = null;
  private bridgeTimingPrepared = false;
  private bridgeTransport: "stopped" | "waiting" | null = null;
  private state: TimecodeState = {
    timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
    display: "00:00:00:00",
    source: "internal-freerun",
    format: { frameRate: 30, dropFrame: "ndf" },
    running: false,
    triggersEnabled: true,
    automaticCuesEnabled: true,
    serverTime: Date.now(),
    totalFrames: 0,
    lyrics: null,
    signal: { status: "idle", lastFeedAt: null },
  };
  private events: AutomationEvent[] = [];
  private controller = emptyMidiController();
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
  private readonly namedTimerStore: NamedTimerStore;
  private readonly mediaOutputs: MediaOutputManager;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.revisions = new RelaySequenceStore(ctx.storage.sql);
    this.namedTimerStore = new NamedTimerStore(ctx.storage);
    this.mediaOutputs = new MediaOutputManager({ ctx, bucket: env.STORAGE,
      authorize: async socket => {
        const claim = socketAuthorityClaim(socket);
        const allowed = Boolean(claim && await hasLivePermissionAuthority(env.DB, claim, "timecode:access"));
        if (allowed) renewSocketReadLease(socket);
        return allowed;
      },
      changed: () => this.broadcastState(),
    });
    ctx.blockConcurrencyWhile(async () => {
      this.controller = await ctx.storage.get<MidiControllerSnapshot>("midi-controller") ?? emptyMidiController();
      const stored = await ctx.storage.get<TimecodeSnapshot>("timecode");
      this.retired = await ctx.storage.get<boolean>("retired") ?? false;
      this.legacyExport = await ctx.storage.get<LegacyTimecodeExport>("legacy-export") ?? null;
      this.hasSnapshot = Boolean(stored);
      if (stored) {
        this.deviceTimings = stored.deviceTimings ?? null;
        this.target = stored.target ?? null;
        this.orgId = this.target?.orgId ?? this.legacyExport?.target.orgId ?? "";
        this.state = {
          ...stored.state,
          triggersEnabled: stored.state.triggersEnabled ?? true,
          automaticCuesEnabled: stored.state.automaticCuesEnabled ?? true,
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
        this.bridgeTransport = clock.bridgeTransport ?? null;
        this.formatCandidate = clock.formatCandidate ?? null;
        if (this.updateSignalHealth()) {
          await this.persistClock();
          this.broadcastState();
        }
      }
      if (this.target && !this.retired && !this.legacyExport && this.deviceTimings === null) await this.loadDeviceTiming();
    });
  }

  private async persist(): Promise<void> {
    if (this.retired) return;
    await this.ctx.storage.put({
      timecode: { state: this.state, events: this.events, deviceTimings: this.deviceTimings, ...(this.target ? { target: this.target } : {}) } satisfies TimecodeSnapshot,
      clock: this.clockSnapshot(),
    });
    await this.scheduleAlarm();
    this.hasSnapshot = true;
    this.lastPersistedAt = Date.now();
  }

  private clockSnapshot(): ClockSnapshot {
    const { timecode, display, totalFrames, format, source, running, serverTime, signal, triggersEnabled, automaticCuesEnabled, automationHold, incomingFormat } = this.state;
    return { state: { timecode, display, totalFrames, format, source, running, serverTime, signal, triggersEnabled, automaticCuesEnabled, automationHold, incomingFormat },
      previousFeedFrame: this.previousFeedFrame, masterSessionId: this.masterSessionId,
      expectedFeedSince: this.expectedFeedSince, bridgeFeed: this.bridgeFeed, bridgeTransport: this.bridgeTransport, formatCandidate: this.formatCandidate };
  }

  private async persistClock(): Promise<void> {
    if (this.retired) return;
    await this.ctx.storage.put("clock", this.clockSnapshot());
    await this.scheduleAlarm();
  }

  private feedDeadline(): number | null {
    const signal = this.state.signal;
    const last = signal?.lastFeedAt ?? this.expectedFeedSince;
    if (!signal || last === null || signal.status === "paused" || signal.status === "idle" || signal.status === "timecode-lost" || signal.status === "midi-stopped" || signal.status === "midi-waiting") return null;
    return last + (signal.status === "timecode-stalled" ? FEED_LOST_MS : FEED_STALL_MS);
  }

  private scheduleAlarm(): Promise<void> {
    const deadlines = [this.feedDeadline(), this.mediaOutputs.deadline()].filter(value => value !== null);
    return scheduleSocketReadRefresh(this.ctx, socket => this.socketNeedsReadLease(socket), deadlines.length ? Math.min(...deadlines) : null);
  }

  private updateSignalHealth(): boolean {
    const signal = this.state.signal;
    const last = signal?.lastFeedAt ?? this.expectedFeedSince;
    if (!signal || signal.status === "paused" || signal.status === "idle" || signal.status === "midi-stopped" || signal.status === "midi-waiting" || last === null) return false;
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
    this.bridgeTimingPrepared = false;
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
        if (this.deviceTimings === null) await this.loadDeviceTiming();
        // Bridge binds before forwarding each sample. Refresh once before a
        // stopped native source activates, never during live/stalled playback.
        if (!refreshMetadata && !this.masterSessionId && !this.bridgeTimingPrepared && !this.state.running && ["idle", "midi-waiting"].includes(this.state.signal?.status ?? "idle")) {
          if (await this.loadDeviceTiming(true)) this.bridgeTimingPrepared = true;
        }
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
      await this.loadDeviceTiming();
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
        ws.send(JSON.stringify({ type: "master-status", granted, ...this.resolvedTarget() } satisfies TimecodeWsMessage));
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
      try { socket.send(JSON.stringify({ type: "control-status", control: this.controlStatus(socket), ...this.resolvedTarget() } satisfies TimecodeWsMessage)); }
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

  private resolvedTarget() {
    return { showId: this.target?.showId ?? null, serviceDate: this.target?.serviceDate ?? null };
  }

  private targetJson(data: object, init?: ResponseInit): Response {
    const target = this.resolvedTarget();
    // Preserve the v1 events-array contract. Its target travels in the same
    // response headers; object responses also carry it in their JSON body.
    const response = Response.json(Array.isArray(data) ? data : { ...data, ...target }, init);
    response.headers.set("X-ShowPilot-Show-Id", target.showId ?? "");
    response.headers.set("X-ShowPilot-Service-Date", target.serviceDate ?? "");
    return response;
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
      this.namedTimerStore.clear();
      this.mediaOutputs.clear();
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
        automaticCuesEnabled: true,
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
      return this.targetJson({ ok: true });
    }

    if (this.retired) return this.targetJson({ error: "This show's timecode has been retired" }, { status: 410 });
    if (!this.target || this.legacyExport) return this.targetJson({ error: "Choose a show for timecode." }, { status: 409 });
    if (this.target && (url.searchParams.get("orgId") !== this.target.orgId || url.searchParams.get("showId") !== this.target.showId)) {
      return this.targetJson({ error: "Timecode show mismatch" }, { status: 409 });
    }
    this.orgId = this.target?.orgId ?? url.searchParams.get("orgId") ?? this.orgId;

    if (url.pathname === "/internal/bridge-feed" || url.pathname === "/internal/bridge-disconnected" || url.pathname === "/internal/bridge-transport") {
      if (request.method !== "POST" || !this.target || !this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/internal/bridge-disconnected") {
        this.bridgeFeed = null;
        this.bridgeTransport = null;
        await this.persistClock();
        if (!this.masterSessionId) await this.handleCommand("bridge-disconnected");
      } else if (url.pathname === "/internal/bridge-transport") {
        const body = await request.json<{ payload?: Record<string, unknown> }>();
        if (body.payload?.state !== "stopped" && body.payload?.state !== "waiting") return this.targetJson({ error: "Invalid MIDI transport state" }, { status: 400 });
        // A paused standby must never be promoted using its previous live frame.
        this.bridgeFeed = null;
        this.bridgeTransport = body.payload.state;
        if (this.masterSessionId) await this.persistClock();
        else {
          this.state.source = "mtc";
          await this.handleCommand("mtc-transport", body.payload);
        }
      } else {
        const body = await request.json<{ payload?: Record<string, unknown> }>();
        const source = body.payload?.source ?? "mtc";
        if (source !== "mtc" && source !== "ltc-bridge") return this.targetJson({ error: "Invalid Bridge timecode source" }, { status: 400 });
        if (source === "mtc" && this.bridgeTransport === "stopped") return this.targetJson({ ok: true, held: true });
        const format = body.payload?.format;
        const tc = automationTimecodeSchema.safeParse(body.payload?.timecode);
        if (!isValidTimecodeFormat(format) || !tc.success || !tc.data || !isValidTimecode(tc.data, format)) {
          return this.targetJson({ error: "Invalid Bridge timecode" }, { status: 400 });
        }
        if (source === "ltc-bridge") this.bridgeTransport = null;
        this.bridgeFeed = { source, timecode: tc.data, format, receivedAt: Date.now() };
        if (this.masterSessionId) await this.persistClock();
        else {
          if (this.state.source !== source && this.state.signal?.status === "midi-stopped") this.state.signal = { status: "waiting", lastFeedAt: null };
          this.state.source = source;
          await this.handleCommand("feed-tc", body.payload);
        }
      }
      return this.targetJson({ ok: true, showId: this.target.showId, serviceDate: this.target.serviceDate });
    }

    const authClaim = this.readAuthorityClaim(url);
    const canWrite = url.searchParams.get("access") === "write"
      && authClaim !== null
      && await hasLivePermissionAuthority(this.env.DB, authClaim, "timecode:access");

    if (url.pathname === "/lyrics-controls" && request.method === "GET") {
      if (!canWrite) return new Response("Unauthorized", { status: 401 });
      const owner = this.controlOwner();
      return this.targetJson({ canControl: Boolean(owner && owner.attachment.authClaim?.sessionId === authClaim?.sessionId
        && owner.attachment.authClaim?.userId === authClaim?.userId) });
    }

    if (url.pathname === "/media-ws") {
      if (!canWrite) return new Response("Unauthorized", { status: 401 });
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ canWrite: false, authClaim, orgId: this.orgId, showId: this.target.showId, sessionId: crypto.randomUUID(), media: { output: null } });
      renewSocketReadLease(server);
      server.send(JSON.stringify({ type: "media-hello", orgId: this.orgId, showId: this.target.showId, serverTime: Date.now() }));
      await this.scheduleAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

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
      return this.targetJson(
        canWrite ? this.getOperatorState() : this.getDisplayState(),
      );
    }

    if (url.pathname === "/events") {
      if (!canWrite) {
        return new Response("Unauthorized", { status: 401 });
      }
      return this.targetJson(this.events);
    }

    if (url.pathname === "/command" && request.method === "POST") {
      if (!canWrite) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = commandSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return this.targetJson({ error: "Invalid timecode command" }, { status: 400 });
      const owner = this.controlOwner();
      if (!owner || owner.attachment.authClaim?.sessionId !== authClaim?.sessionId
        || owner.attachment.authClaim?.userId !== authClaim?.userId) {
        return this.targetJson({ ok: false, error: "Claim timecode control in a connected operator window first." }, { status: 409 });
      }
      if (["claim-control", "release-control", "bridge-disconnected"].includes(body.data.action)) {
        return this.targetJson({ error: "This command requires its dedicated connection." }, { status: 400 });
      }
      try { await this.handleCommand(body.data.action, body.data.payload, owner.attachment.sessionId); }
      catch (error) {
        if (error instanceof TimecodeCommandRejection) return this.targetJson({ ok: false, error: error.message }, { status: 400 });
        throw error;
      }
      return this.targetJson({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (this.retired || !this.target || this.legacyExport) { ws.close(4409, "Timecode show unavailable. Reconnect."); return; }
    if (isMediaOutputSocket(ws)) {
      try {
        if (typeof data !== "string" || data.length > 4096) throw new Error("Invalid media message");
        await this.mediaOutputs.message(ws, JSON.parse(data));
        this.mediaOutputs.plan(this.events);
      } catch {
        this.mediaOutputs.disconnected(ws);
        ws.close(1011, "Media output unavailable. Reconnect and enable it again.");
      }
      await this.scheduleAlarm();
      return;
    }
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
          ws.send(JSON.stringify({ type: "command-rejected", action: msg.action, error: error.message, ...this.resolvedTarget() } satisfies TimecodeWsMessage));
        }
      }
    } catch {
      // Ignore
    }
  }

  async webSocketClose(ws: WebSocket) {
    if (isMediaOutputSocket(ws)) { this.mediaOutputs.disconnected(ws); await this.scheduleAlarm(); return; }
    const attachment = ws.deserializeAttachment?.() as TimecodeSocketAttachment | null;
    if (attachment?.controlsTimecode) {
      ws.serializeAttachment({ ...attachment, controlsTimecode: false });
      this.broadcastControl();
    }
    if (attachment?.sessionId && attachment.sessionId === this.masterSessionId) {
      this.automationGeneration++;
      this.masterSessionId = null;
      if (this.state.signal?.status === "paused") {
        this.previousFeedFrame = null; this.expectedFeedSince = null;
        await this.persist(); this.broadcastState(); return;
      }
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
        this.state.source = standby.source ?? "mtc";
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

  private applyEventTiming(event: AutomationEvent): void {
    const device = deviceTimingForEvent(event, this.deviceTimings ?? []);
    event.deviceLatencyMs = device?.latencyMs ?? 0;
    event.timingDeviceId = device?.id;
    event.dispatchFrame = automationDispatchFrame(event, this.state.format);
  }

  /** Capture device timing at source start/arming, never query D1 per frame. */
  private async loadDeviceTiming(force = false): Promise<boolean> {
    if (!force && this.deviceTimings !== null) return true;
    if (this.timingLoad) return this.timingLoad;
    const generation = this.automationGeneration;
    const load = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const rows = await Promise.race([
          this.env.DB.prepare("SELECT id, category, latencyMs FROM device WHERE orgId = ? AND enabled = 1").bind(this.orgId).all<DeviceTiming>(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Device timing lookup timed out")), 2_000); }),
        ]);
        const devices = z.array(z.object({ id: z.string(), category: z.string(), latencyMs: z.number().int().min(0).max(MAX_DEVICE_LATENCY_MS) })).parse(rows.results);
        if (this.retired || generation !== this.automationGeneration) return false;
        this.deviceTimings = devices;
        for (const event of this.events) {
          // Keep a dispatched cue's timing/retry history until explicit re-arm.
          if (!event.fired && (event.executionStatus === undefined || event.executionStatus === "scheduled")) this.applyEventTiming(event);
        }
        await this.persist();
        this.broadcastEvents();
        return generation === this.automationGeneration && !this.retired;
      } catch {
        throw new TimecodeCommandRejection("Device timing could not be loaded. Check the connection and try starting or enabling automation again.");
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    this.timingLoad = load();
    try { return await this.timingLoad; }
    finally { this.timingLoad = null; }
  }

  private async handleCommand(
    action: TimecodeCommand,
    payload?: Record<string, unknown>,
    sessionId?: string,
    feedReceivedAt = Date.now(),
  ): Promise<void> {
    switch (action) {
      case "save-controller": {
        const parsed = midiControllerSchema.safeParse(payload?.config);
        if (!parsed.success) throw new TimecodeCommandRejection("Invalid MIDI mappings. Check the inputs and action values.");
        if (payload?.revision !== this.controller.revision) {
          this.broadcastToWriters({ type: "controller-update", controller: this.controller });
          throw new TimecodeCommandRejection("MIDI mappings changed. Reload the saved mappings before editing again.");
        }
        // Reserve the revision before persistence yields so two saves cannot win.
        this.controller = { revision: this.controller.revision + 1, config: parsed.data };
        await this.ctx.storage.put("midi-controller", this.controller);
        this.broadcastToWriters({ type: "controller-update", controller: this.controller });
        break;
      }
      case "start": {
        const parsed = payload?.startPosition === undefined ? null : timecodeStartPositionSchema.safeParse(payload.startPosition);
        if (parsed && !parsed.success) throw new TimecodeCommandRejection("Review a valid start position before starting the generator.");
        const position = parsed?.success ? parsed.data : null;
        const checkPosition = () => {
          if (!position) return;
          const problem = startPositionProblem(position, this.state, this.masterSessionId !== null);
          if (problem) throw new TimecodeCommandRejection(problem);
        };
        checkPosition();
        if (sessionId && this.masterSessionId && this.masterSessionId !== sessionId) {
          this.sendMasterStatus(sessionId, false);
          break;
        }
        const generation = this.automationGeneration;
        if (!this.state.running && (!await this.loadDeviceTiming(true) || generation !== this.automationGeneration)) {
          throw new TimecodeCommandRejection("Clock start was cancelled while device timing was loading.");
        }
        if (sessionId && (this.controlOwner()?.attachment.sessionId !== sessionId || (this.masterSessionId && this.masterSessionId !== sessionId))) {
          throw new TimecodeCommandRejection("Timecode control changed while starting the source.");
        }
        // Preparation can yield to Stop, another start, a seek or a reformat.
        checkPosition();
        if (position) {
          const frame = timecodeToFrames(position.timecode, this.state.format);
          this.holdForJump(this.state.totalFrames, frame);
          this.automationGeneration++;
          this.state.timecode = position.timecode;
          this.state.totalFrames = frame;
          this.state.display = timecodeToString(position.timecode, this.state.format.dropFrame === "df");
          this.state.source = "internal-freerun";
          this.state.serverTime = Date.now();
          this.previousFeedFrame = null;
        }
        if (sessionId) this.masterSessionId = sessionId;
        this.sendMasterStatus(sessionId, true);
        this.state.running = true;
        this.expectedFeedSince = Date.now();
        this.state.signal = { status: "waiting", lastFeedAt: null };
        await this.persist();
        this.broadcastState();
        break;
      }

      case "pause":
        if (!sessionId || this.masterSessionId !== sessionId) throw new TimecodeCommandRejection("Pause requires this browser's active clock source.");
        this.holdClock();
        this.state.signal = { status: "paused", lastFeedAt: this.state.signal?.lastFeedAt ?? null };
        await this.persist(); this.broadcastState();
        break;

      case "stop":
        if (sessionId && this.masterSessionId && this.masterSessionId !== sessionId) break;
        this.masterSessionId = null;
        this.sendMasterStatus(sessionId, false);
        this.holdClock();
        await this.persist();
        this.broadcastState();
        break;

      case "mtc-transport": {
        if (sessionId && this.masterSessionId !== sessionId) throw new TimecodeCommandRejection("Start the local MTC source before changing MIDI transport.");
        if (this.state.source !== "mtc" || (payload?.state !== "stopped" && payload?.state !== "waiting")) throw new TimecodeCommandRejection("Invalid MIDI transport state.");
        if (this.state.signal?.status === "paused") break;
        this.bridgeTimingPrepared = false;
        this.automationGeneration++;
        this.state.running = false;
        this.state.serverTime = Date.now();
        this.state.signal = { status: payload.state === "stopped" ? "midi-stopped" : "midi-waiting", lastFeedAt: this.state.signal?.lastFeedAt ?? null };
        this.expectedFeedSince = null;
        this.formatCandidate = null;
        await this.persistClock();
        this.broadcastState();
        break;
      }

      case "feed-tc": {
        if (sessionId && this.masterSessionId !== sessionId) throw new TimecodeCommandRejection("Start the local timecode source before sending a feed.");
        if (this.state.signal?.status === "midi-stopped" || this.state.signal?.status === "paused") break;
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
          || this.state.signal?.status === "format-mismatch" || this.state.signal?.status === "midi-waiting";
        this.state.timecode = tc;
        this.state.totalFrames = totalFrames;
        this.state.display = timecodeToString(tc, format.dropFrame === "df");
        this.state.format = format;
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

        // Persist the full timeline when cues change or after five seconds.
        if (eventFired || Date.now() - this.lastPersistedAt >= 5_000) {
          await this.persist();
        }
        this.broadcastState();
        break;
      }

      case "bridge-disconnected":
        if (this.state.source !== "mtc" && this.state.source !== "ltc-bridge") break;
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
        // Native LTC selects its source at the authenticated Bridge feed boundary.
        // A browser cannot claim an audio producer by changing this label.
        if (payload?.source === "ltc-bridge") throw new TimecodeCommandRejection("Select the LTC audio input in ShowPilot Bridge. Valid audio activates the source.");
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
        for (const event of this.events) {
          event.triggerFrame = timecodeToFrames(event.triggerTimecode, format);
          event.dispatchFrame = automationDispatchFrame(event, format);
        }
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
        const problem = automationPayloadProblem(event);
        if (problem) throw new TimecodeCommandRejection(problem);
        event.id = event.id || crypto.randomUUID();
        if (this.events.some((existing) => existing.id === event.id)) {
          // A save retry may follow a lost echo. Return the canonical timeline.
          this.broadcastEvents();
          break;
        }
        event.editRevision = crypto.randomUUID();
        event.enabled = event.enabled !== false;
        delete event.skipped;
        event.fired = false;
        event.executionAttempts = 0;
        delete event.executionId;
        delete event.executionStartedAt;
        delete event.executionDurationMs;
        delete event.executionRetryable;
        event.executionStatus = "scheduled";
        delete event.executionError;
        delete event.executedAt;
        event.toleranceFrames = parseTolerance(event.toleranceFrames);
        event.leadMs = parseLeadMs(event.leadMs);
        event.triggerFrame = timecodeToFrames(
          event.triggerTimecode,
          this.state.format
        );
        this.events.push(event);
        this.applyEventTiming(event);
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
          const problem = automationPayloadProblem({ action: candidate.action, payload: candidate.payload, targetDeviceId: candidate.targetDeviceId });
          if (problem) throw new TimecodeCommandRejection(problem);
          const next: AutomationEvent = {
            ...(candidate as AutomationEvent),
            id: candidate.id || crypto.randomUUID(),
            fired: false,
            skipped: undefined,
            enabled: candidate.enabled !== false,
            executionAttempts: 0,
            executionId: undefined,
            executionStartedAt: undefined,
            executionDurationMs: undefined,
            executionRetryable: undefined,
            executionStatus: "scheduled",
            editRevision: crypto.randomUUID(),
            executionError: undefined,
            executedAt: undefined,
            toleranceFrames: parseTolerance(candidate.toleranceFrames),
            leadMs: parseLeadMs(candidate.leadMs),
            triggerFrame: timecodeToFrames(candidate.triggerTimecode, this.state.format),
            sourceKey,
          };
          this.applyEventTiming(next);
          nextEvents.push(next);
        }
        if (!valid) break;
        this.events = replaceAutomationEventGroup(this.events, sourceKey, nextEvents);
        await this.persist();
        this.broadcastEvents();
        break;
      }

      case "update-event": {
        const event = this.events.find(candidate => candidate.id === payload?.id);
        if (!event) throw new TimecodeCommandRejection("This cue is no longer in the timeline. Keep your draft and review the current show.");
        if (event.executionStatus === "dispatching") throw new TimecodeCommandRejection("Wait for this cue's acknowledgement before editing it.");
        const parsed = automationEventChangesSchema.safeParse(payload?.updates);
        if (!parsed.success || Object.keys(parsed.data).length === 0) throw new TimecodeCommandRejection("Invalid cue changes. Edit only its label, timecode, tolerance, lead or action details.");
        if (payload?.expected !== undefined) {
          const review = automationEditReviewSchema.safeParse(payload.expected);
          if (!review.success || !automationEditReviewMatches(event, review.data)) throw new TimecodeCommandRejection("The cue changed while you were editing. Keep your draft and review the latest cue before saving.");
        }
        if (payload?.expectedFormat !== undefined && (!isValidTimecodeFormat(payload.expectedFormat) || !sameTimecodeFormat(payload.expectedFormat, this.state.format))) {
          throw new TimecodeCommandRejection("The timeline frame rate changed. Review the cue time before saving.");
        }
        const updates = parsed.data;
        if (updates.triggerTimecode && !isValidTimecode(updates.triggerTimecode, this.state.format)) throw new TimecodeCommandRejection("The cue time is not valid at the current frame rate.");
        const candidate = { ...event, ...updates };
        if (updates.payload && event.action === "custom-webhook" && !isSafeAutomationWebhookUrl(updates.payload.url)) {
          throw new TimecodeCommandRejection("Custom webhook target must be a public HTTPS URL.");
        }
        const problem = automationPayloadProblem(candidate);
        if (problem) throw new TimecodeCommandRejection(problem);
        Object.assign(event, updates);
        event.editRevision = crypto.randomUUID();
        if (updates.triggerTimecode) event.triggerFrame = timecodeToFrames(updates.triggerTimecode, this.state.format);
        this.applyEventTiming(event);
        this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
        await this.persist();
        this.broadcastEvents();
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

      case "set-triggers-enabled": {
        if (typeof payload?.enabled !== "boolean") break;
        if (payload.enabled && this.state.incomingFormat) throw new TimecodeCommandRejection("Confirm the input format before enabling automation.");
        if (payload.enabled && this.state.automationHold && (payload.confirmed !== true || payload.expectedHoldId !== this.state.automationHold.id)) {
          throw new TimecodeCommandRejection("Review the latest timecode jump before resuming automation.");
        }
        if (payload.enabled && !this.state.automationHold && payload.expectedHoldId) {
          throw new TimecodeCommandRejection("Automation review changed. Refresh before resuming.");
        }
        if (payload.enabled && !this.state.triggersEnabled) {
          const generation = this.automationGeneration;
          if (!await this.loadDeviceTiming(true) || generation !== this.automationGeneration) {
            throw new TimecodeCommandRejection("Automation changed while device timing was loading. Review its current state.");
          }
        }
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
      }

      case "resume-automatic-cues":
        this.applyAutomaticCueGate(true);
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

      case "fire-next":
      case "fire-event": {
        if (!this.state.triggersEnabled) throw new TimecodeCommandRejection("Enable automation before firing a cue.");
        const event = action === "fire-next" ? nextAutomationEvent(this.events, this.state.totalFrames)
          : this.events.find(candidate => candidate.id === payload?.id);
        if (!event) throw new TimecodeCommandRejection(action === "fire-next" ? "No upcoming cue is ready to fire." : "This cue is no longer in the show.");
        if (!event.enabled || event.skipped || event.fired || event.executionStatus === "failed" || event.executionStatus === "dispatching") {
          throw new TimecodeCommandRejection("This cue is not ready to fire. Review its status before retrying or re-arming it.");
        }
        await this.runEvent(event);
        await this.persist();
        this.broadcastState();
        break;
      }

      case "skip-event":
      case "rearm-event": {
        const event = this.events.find(candidate => candidate.id === payload?.id);
        if (!event) throw new TimecodeCommandRejection("This cue is no longer in the show.");
        if (event.executionStatus === "dispatching") throw new TimecodeCommandRejection("Wait for this cue's acknowledgement before changing it.");
        if (action === "skip-event") {
          if (event.fired) throw new TimecodeCommandRejection("This cue already fired. Skipping cannot undo its output.");
          event.skipped = true;
        } else {
          const expected = cueReviewSchema.safeParse(payload?.expected);
          if (payload?.confirmed !== true || !expected.success || !cueReviewMatches(event, expected.data)) {
            throw new TimecodeCommandRejection("The cue changed. Review its current status before re-arming it.");
          }
          resetCueExecution(event);
          this.applyEventTiming(event);
        }
        await this.persist();
        this.broadcastEvents();
        this.broadcastState();
        break;
      }

      case "retry-event": {
        if (!this.state.triggersEnabled || typeof payload?.id !== "string") break;
        const event = this.events.find((candidate) => candidate.id === payload.id);
        if (!event?.enabled || event.executionStatus === "dispatching") break;
        if (event.skipped) throw new TimecodeCommandRejection("Re-arm this skipped cue before retrying it.");
        const refire = payload.confirmed === true;
        if (refire || (event.fired && event.action !== "crew-message")) {
          const expected = cueReviewSchema.safeParse(payload.expected);
          if (!refire || !event.fired || !expected.success || !cueReviewMatches(event, expected.data)) {
            throw new TimecodeCommandRejection("Review the current cue before firing it again.");
          }
        }
        const durableReceipt = event.action === "crew-message" || event.action === "timer-start" || event.action === "timer-stop" || event.action === "media-play" || event.action === "media-stop";
        const deliveryId = durableReceipt && !refire ? event.executionId : undefined;
        resetCueExecution(event);
        // A lost acknowledgment must not duplicate a post or restart a timer.
        if (deliveryId) event.executionId = deliveryId;
        await this.runEvent(event);
        await this.persist();
        this.broadcastState();
        break;
      }

      case "reset-events":
        if (this.events.some((event) => event.executionStatus === "dispatching")) break;
        for (const event of this.events) { resetCueExecution(event); this.applyEventTiming(event); }
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
          revision: crypto.randomUUID(),
          manual: true,
        };
        await this.persist();
        this.broadcastLyrics(this.state.lyrics);
        this.broadcastState();
        break;
      }

      case "control-lyrics": {
        const parsed = lyricsControlSchema.safeParse(payload);
        if (!parsed.success) throw new TimecodeCommandRejection("Review the displayed lyrics before changing the section.");
        const current = this.state.lyrics;
        if (!current || !lyricsReviewMatches(current, parsed.data.expected)) throw new TimecodeCommandRejection("Lyrics changed. Review the current section before trying again.");
        const owner = this.controlOwner();
        const claim = owner?.attachment.authClaim;
        if (!claim || owner.attachment.sessionId !== sessionId) throw new TimecodeCommandRejection("Claim timecode control before changing lyrics.");
        const deadline = Date.now() + 5_000;
        let next: LyricsDisplayState | null;
        try {
          next = parsed.data.operation === "clear" ? null : await withOperationTimeout(
            resolveLyricsStep(this.env.DB, this.orgId, current, parsed.data.operation), 5_000, "Song sections could not load in time. Try again.");
          const allowed = await withOperationTimeout(hasLivePermissionAuthority(this.env.DB, claim, "timecode:access"),
            Math.max(1, deadline - Date.now()), "Lyrics permission check timed out.");
          if (!allowed) throw new Error("Timecode access changed. Sign in and check your permissions.");
        } catch (error) { throw new TimecodeCommandRejection(error instanceof Error ? error.message : "The song section could not load."); }
        if (Date.now() >= deadline || this.retired || this.controlOwner()?.socket !== owner.socket
          || this.state.lyrics !== current) throw new TimecodeCommandRejection("Lyrics or timecode control changed. Review the display before trying again.");
        this.state.lyrics = next ? { ...next, manual: true } : null;
        await this.persist();
        if (this.state.lyrics) this.broadcastLyrics(this.state.lyrics); else this.broadcast({ type: "lyrics-clear" });
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

  private applyAutomaticCueGate(enabled: boolean): void {
    if (enabled && (!this.state.triggersEnabled || this.state.automationHold || this.state.incomingFormat)) {
      throw new TimecodeCommandRejection("Enable automation and resolve its safety holds before resuming automatic cues.");
    }
    if (!enabled) this.automationGeneration++;
    this.state.automaticCuesEnabled = enabled;
    if (enabled) this.previousFeedFrame = this.state.totalFrames;
  }

  private async evaluateEvents(previousFrame: number | null, totalFrames: number): Promise<boolean> {
    if (!this.state.triggersEnabled || !this.state.running) return false;
    const due: { event: AutomationEvent; dispatchFrame: number }[] = [];
    for (const event of this.events) {
      if (!event.enabled || event.fired || event.skipped || event.executionStatus === "dispatching") continue;
      const attempts = event.executionAttempts ?? 0;
      const dispatchFrame = automationDispatchFrame(event, this.state.format);
      // Retries retain Phase 0's time/frame cap. Matching tolerance never
      // expands the crossing window during continuous forward playback.
      const withinRetryWindow = event.executionStartedAt !== undefined
        && Date.now() - event.executionStartedAt <= event.toleranceFrames * 1000 / this.state.format.frameRate
        && totalFrames >= dispatchFrame
        && totalFrames <= dispatchFrame + event.toleranceFrames;
      const shouldRun = event.executionStatus === "failed"
        ? event.executionRetryable === true && attempts < 3 && withinRetryWindow
        : crossedTriggerFrame(previousFrame, totalFrames, dispatchFrame, event.toleranceFrames);
      if (!shouldRun) continue;
      due.push({ event, dispatchFrame });
    }
    // A feed may cross several cues whose lead times reverse nominal order.
    // Reserve shared outputs in dispatch order, matching Next and the timeline.
    // Controls apply synchronously before reserving subsequent outputs. At the
    // same frame, enable precedes disable, so disable wins and blocks output.
    due.sort((a, b) => a.dispatchFrame - b.dispatchFrame || automationControlPriority(a.event.action) - automationControlPriority(b.event.action));
    const executions: Promise<void>[] = [];
    for (const { event } of due) {
      if (this.state.automaticCuesEnabled === false && !isTriggerControlAction(event.action)) continue;
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
      // A trigger barrier must take effect before the first await: another feed
      // can arrive while persistence is pending. The safety gate stays separate.
      const control = isTriggerControlAction(event.action);
      if (control) {
        this.assertAutomationDispatch(event, requiresLiveFeed, generation);
        this.applyAutomaticCueGate(event.action === "triggers-enable");
      }
      // Reserve output order before the first await. Persist the dispatch
      // before external effects so restart recovery can detect uncertainty.
      await this.executor.run(
        automationOutput(event),
        event.action === "custom-webhook" ? 5000 : 10000,
        async (signal) => {
          await this.persist();
          this.broadcastEvents();
          if (control) { signal.throwIfAborted(); this.broadcastState(); }
          else await this.executeEventAction(event, signal, requiresLiveFeed, generation, startedAt + 10000);
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

  private assertAutomationDispatch(event: AutomationEvent, requiresLiveFeed: boolean, generation: number): void {
    if (requiresLiveFeed && generation !== this.automationGeneration) {
      throw new AutomationCancelled("Automation changed after this cue was queued.");
    }
    const lastFeed = this.state.signal?.lastFeedAt ?? this.expectedFeedSince;
    if (requiresLiveFeed && (!this.state.running || (lastFeed !== null && Date.now() - lastFeed >= FEED_STALL_MS))) {
      throw new AutomationCancelled("Timecode signal lost before dispatch.");
    }
    if (this.retired || !this.target || !this.state.triggersEnabled || !event.enabled || event.skipped || !this.events.includes(event)) {
      throw new AutomationCancelled("Automation was disabled or removed before dispatch.");
    }
    if (requiresLiveFeed && this.state.automaticCuesEnabled === false && !isTriggerControlAction(event.action)) {
      throw new AutomationCancelled("Automatic cues were paused before dispatch.");
    }
  }

  private async executeEventAction(event: AutomationEvent, signal: AbortSignal, requiresLiveFeed: boolean, generation: number, deadline: number): Promise<void> {
    const env = this.env as unknown as Env;
    const assertCanDispatch = () => {
      signal.throwIfAborted();
      this.assertAutomationDispatch(event, requiresLiveFeed, generation);
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
      action: "timer-goto" | "timer-start" | "timer-next" | "timer-prev" | "timer-pause" | "timer-resume" | "timer-stop" | "timer-adjust" | "stage-message" | "stage-clear",
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

    const executeProPresenterCommand = async () => {
      const relay = env.BRIDGE_RELAY.get(env.BRIDGE_RELAY.idFromName(this.orgId));
      const status = await relay.getBridgeStatus();
      assertCanDispatch();
      const targets = status.connectedTargets.filter(candidate => candidate.startsWith("propresenter:"));
      const target = typeof event.payload.target === "string" && event.payload.target.trim()
        ? event.payload.target.trim()
        : targets.length === 1 ? targets[0] : undefined;
      if (!status.bridgeOnline || !target || !targets.includes(target)) {
        throw new Error("Choose one connected ProPresenter target through Venue Bridge.");
      }
      const installationId = status.activeInstallation?.installationId;
      if (!installationId) throw new Error("Venue Bridge installation is unavailable.");
      const executionId = event.executionId ?? crypto.randomUUID();
      let outputDispatched = false;
      try {
        await runProPresenterCue({
          action: event.action, payload: event.payload, signal, assertCanDispatch,
          send: async (command, step) => {
            const current = await relay.getBridgeStatus();
            assertCanDispatch();
            if (!current.bridgeOnline || !current.connectedTargets.includes(target)
              || current.activeInstallation?.installationId !== installationId) {
              throw new Error("ProPresenter connection changed during the cue. Check the output before retrying.");
            }
            if (command.action !== "resolve-prop") outputDispatched = true;
            const result = await relay.dispatchBridgeMessage({
              type: "command", id: `${executionId}:${step}`, protocol: "propresenter", target,
              command: JSON.stringify(command),
            }, { source: "automation", actorUserId: this.controlOwner()?.attachment.authClaim?.userId ?? null, executionId }, installationId);
            assertCanDispatch();
            if (!result.success) throw new Error(result.error ?? "ProPresenter command failed.");
            return result.response;
          },
        });
      } catch (error) {
        // A cancelled multi-step cue may already have cleared props. Never
        // silently reschedule it after the kill switch is released.
        if (outputDispatched && error instanceof AutomationCancelled) {
          throw new Error("ProPresenter cue interrupted after dispatch. Check the output before retrying.", { cause: error });
        }
        throw error;
      }
    };

    const executeDeviceCommand = async () => {
      const resolved = await resolveTimecodeDeviceAction(env.DB, this.orgId,
        { ...event, targetDeviceId: event.timingDeviceId ?? event.targetDeviceId }, env.CREDENTIAL_ENCRYPTION_KEYS);
      assertCanDispatch();
      const relay = env.BRIDGE_RELAY.get(env.BRIDGE_RELAY.idFromName(this.orgId));
      const status = await relay.getBridgeStatus();
      assertCanDispatch();
      if (!status.bridgeOnline) throw new Error("Venue Bridge is offline.");
      const installationId = status.activeInstallation?.installationId;
      if (!installationId) throw new Error("Venue Bridge installation is unavailable.");
      if (!status.connectedTargets.includes(resolved.target)) {
        const connected = await relay.dispatchBridgeMessage({
          type: "connect-device",
          protocol: resolved.protocol,
          target: resolved.target,
          settings: resolved.connectionSettings,
        }, { source: "automation", actorUserId: this.controlOwner()?.attachment.authClaim?.userId ?? null, executionId: event.executionId ?? event.id }, installationId);
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
      }, { source: "automation", actorUserId: this.controlOwner()?.attachment.authClaim?.userId ?? null, executionId: event.executionId ?? event.id }, installationId);
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
      case "rundown-goto-item":
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
          "rundown-goto-item": "timer-goto",
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

      case "triggers-disable":
      case "triggers-enable":
        throw new Error("Trigger controls must execute before reserving external outputs.");

      case "timer-start":
      case "timer-stop": {
        if (!event.executionId) throw new Error("Named timer execution is missing its receipt identity.");
        const command = event.action === "timer-start"
          ? { action: event.action, payload: namedTimerStartSchema.parse(event.payload) }
          : { action: event.action, payload: namedTimerStopSchema.parse(event.payload) };
        assertCanDispatch();
        this.namedTimerStore.apply(command, event.id, event.executionId);
        this.broadcastState();
        logResult(event.action, "success", `Named timer ${command.payload.name} ${event.action === "timer-start" ? "started" : "stopped"}.`);
        break;
      }

      case "media-play":
      case "media-stop": {
        const authority = this.controlOwner()?.attachment.authClaim;
        if (!authority || !event.executionId || !await hasLivePermissionAuthority(this.env.DB, authority, "timecode:access")) throw new Error("Claim timecode control before firing a media cue.");
        const cue = event.action === "media-play"
          ? { action: event.action, payload: mediaPlaySchema.parse(event.payload) }
          : { action: event.action, payload: mediaStopSchema.parse(event.payload) };
        await this.mediaOutputs.execute({ orgId: this.orgId, eventId: event.id, executionId: event.executionId, cue, signal, deadline, assertCanDispatch,
          authorizeDispatch: async () => {
            const allowed = await hasLivePermissionAuthority(this.env.DB, authority, "timecode:access");
            const current = this.controlOwner()?.attachment.authClaim;
            return allowed && current?.sessionId === authority.sessionId && current.userId === authority.userId;
          },
        });
        logResult(event.action, "success", `Media output ${cue.payload.output} confirmed ${event.action}.`);
        break;
      }

      case "crew-message": {
        const authority = this.controlOwner()?.attachment.authClaim;
        if (!authority || !this.target || !event.executionId) throw new Error("Claim timecode control before posting a crew message.");
        const payload = crewMessagePayloadSchema.parse(event.payload);
        const chat = this.env.CHAT_RELAY.getByName(chatRelayKey(this.orgId, "production"));
        const result = await chat.postAutomationCue({
          orgId: this.orgId, showId: this.target.showId, eventId: event.id,
          executionId: event.executionId, payload, authority, deadline,
        });
        signal.throwIfAborted();
        if (!result.ok) throw new Error(result.error);
        logResult(event.action, "success", `Production Chat saved message ${result.messageId}.`);
        break;
      }

      case "device-action":
      case "lighting-scene":
      case "lighting-blackout":
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
          revision: crypto.randomUUID(),
        } satisfies LyricsDisplayState;
        this.broadcastLyrics(this.state.lyrics);
        break;
      }

      case "lyrics-next-section":
      case "lyrics-previous-section": {
        const current = this.state.lyrics;
        const next = await resolveLyricsStep(this.env.DB, this.orgId, current, event.action === "lyrics-next-section" ? "next" : "previous");
        assertCanDispatch();
        if (this.state.lyrics !== current) throw new Error("Lyrics changed while the cue was resolving. Review the current section before retrying.");
        this.state.lyrics = next;
        this.broadcastLyrics(next);
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
      case "pp-trigger-next":
      case "pp-trigger-previous":
      case "pp-trigger-clear":
      case "pp-trigger-prop":
      case "pp-clear-props":
        await executeProPresenterCommand();
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
      ? { type: "hydrate", state: this.getOperatorState(), events: this.events, control: this.controlStatus(ws), controller: this.controller }
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
        state: attachment?.canWrite ? this.getOperatorState() : this.getDisplayState(),
      };
      this.send(ws, msg, sequence);
    }
  }

  private broadcastEvents(): void {
    this.mediaOutputs.plan(this.events);
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
    return attachment?.canWrite === true || isMediaOutputSocket(socket);
  }

  /** Worker-only RPC used by permission changes; alarms handle missed pushes. */
  async refreshReadAuthority(userId?: string, onlyDue = false): Promise<void> {
    await refreshSocketReadLeases(this.ctx.getWebSockets(), async socket => {
      const attachment = socket.deserializeAttachment() as { canWrite?: boolean; authClaim?: LiveSessionAuthorityClaim | null; readAuthorizedUntil?: number } | null;
      if (!attachment || (!attachment.canWrite && !isMediaOutputSocket(socket))) return null;
      if (userId && attachment.authClaim?.userId !== userId) return null;
      if (onlyDue && (attachment.readAuthorizedUntil ?? 0) > Date.now() + 30_000) return null;
      const allowed = Boolean(attachment.authClaim && await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "timecode:access"));
      if (!allowed) await this.webSocketClose(socket);
      return allowed;
    });
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    this.mediaOutputs.expire();
    const checkingFeed = this.feedDeadline() !== null;
    if (this.updateSignalHealth()) {
      await this.persistClock();
      this.broadcastState();
    }
    // The 500ms watchdog must not turn read-lease renewal into 2Hz D1 polling.
    await this.refreshReadAuthority(undefined, checkingFeed);
  }

  private send(ws: WebSocket, data: TimecodeWsMessage, sequence: number): void {
    if (isMediaOutputSocket(ws)) return;
    if (!displaySocketMayReceive(ws) || !socketReadLeaseAllows(ws, this.socketNeedsReadLease(ws))) return;
    try {
      ws.send(JSON.stringify({ ...data, ...this.resolvedTarget(), ...this.revisions.envelope(ws, sequence) }));
    } catch {
      try { ws.close(1011, "Broadcast failed"); } catch {}
    }
  }

  private getOperatorState(): TimecodeState {
    const mediaOutputs = this.mediaOutputs.snapshot();
    return { ...this.state, namedTimers: this.namedTimerStore.sample(), mediaOutputs: mediaOutputs.length ? mediaOutputs : undefined };
  }

  private getDisplayState(): TimecodeDisplayState {
    return projectTimecodeDisplayState(this.getOperatorState(), Date.now(), this.events);
  }
}
