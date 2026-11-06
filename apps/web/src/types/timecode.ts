// ─── SMPTE Frame Rates ──────────────────────────────────────

import type { NamedTimerSample } from "@/lib/named-timers";
import type { MediaOutputSnapshot } from "@/lib/media-output";
import type { MidiControllerSnapshot } from "@/lib/midi-controller";

export type FrameRate = 24 | 25 | 29.97 | 30;

export type DropFrameMode = "df" | "ndf";

export interface TimecodeFormat {
  frameRate: FrameRate;
  dropFrame: DropFrameMode;
}

// ─── Core Timecode Value ────────────────────────────────────

export interface TimecodeValue {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

// ─── Timecode Source Types ──────────────────────────────────

export type TimecodeSourceType =
  | "internal-freerun"
  | "internal-rundown"
  | "mtc"
  | "ltc-bridge"
  | "network";

export interface TimecodeSource {
  type: TimecodeSourceType;
  label: string;
  midiInputId?: string;
  host?: string;
  port?: number;
}

// ─── Timecode State (broadcast via WebSocket) ───────────────

export interface TimecodeShow {
  id: string;
  serviceDate: string;
  name: string;
  scheduledStartTime: string | null;
}

export interface TimecodeState {
  /** Wall-clock countdown outputs, independent of the timecode transport. */
  namedTimers?: NamedTimerSample;
  mediaOutputs?: MediaOutputSnapshot[];
  /** Stable input format awaiting an explicit timeline reformat. Operator-only. */
  incomingFormat?: { id: string; format: TimecodeFormat } | null;
  /** Persisted review reason. triggersEnabled remains the automation gate. */
  automationHold?: { id: string; reason: "timecode-jump"; from: string; to: string; detectedAt: number } | null;
  /** Absent only on snapshots/clients predating the feed watchdog. */
  signal?: {
    status: "idle" | "waiting" | "live" | "timecode-stalled" | "timecode-lost" | "format-mismatch" | "midi-stopped" | "midi-waiting" | "paused";
    lastFeedAt: number | null;
  };
  /** Present on a show-bound room; absent only in pre-migration snapshots. */
  showId?: string;
  serviceDate?: string;
  triggersEnabled: TimecodeSettings["triggersEnabled"];
  /** Cue-controlled automatic firing; manual Fire remains available. Legacy snapshots default to true. */
  automaticCuesEnabled?: boolean;
  timecode: TimecodeValue;
  display: string;
  source: TimecodeSourceType;
  format: TimecodeFormat;
  running: boolean;
  serverTime: number;
  totalFrames: number;
  lyrics: LyricsDisplayState | null;
}

/** Display clients receive output and a failure count, never event payloads. */
export type TimecodeDisplayState = Pick<
  TimecodeState,
  "display" | "running" | "serverTime" | "lyrics" | "showId" | "serviceDate" | "signal" | "format" | "totalFrames"
> & {
  namedTimers?: NamedTimerSample;
  automation: { status: "ok" | "failed"; failedCueCount: number };
};

export interface LyricsDisplayState {
  songId: string;
  songTitle: string;
  sectionId: string;
  sectionLabel: string;
  lyrics: string;
  nextLabel: string;
  updatedAt: number;
  manual: boolean;
  /** Opaque identity for guarded operator edits; older saved states may omit it. */
  revision?: string;
  /** Identifies the automation load that owns a later scoped clear. */
  generationKey?: string;
}

// ─── Automation Events ──────────────────────────────────────

export const DEFAULT_TIMECODE_TOLERANCE_FRAMES = 5;
export const TIMECODE_FEED_STALL_MS = 500;
export const MAX_TIMECODE_TOLERANCE_FRAMES = 9000;

export type AutomationActionType =
  | "device-action"
  | "lower-third-show"
  | "lower-third-clear"
  | "rundown-advance"
  | "rundown-start-item"
  | "rundown-goto-item"
  | "rundown-previous"
  | "rundown-pause"
  | "rundown-resume"
  | "rundown-stop"
  | "rundown-adjust"
  | "stage-message"
  | "timer-start"
  | "timer-stop"
  | "media-play"
  | "media-stop"
  | "crew-message"
  | "triggers-disable"
  | "triggers-enable"
  | "stage-clear"
  | "lighting-scene"
  | "lighting-blackout"
  | "lyrics-goto"
  | "lyrics-next-section"
  | "lyrics-previous-section"
  | "lyrics-clear"
  | "pp-trigger-slide"
  | "pp-trigger-next"
  | "pp-trigger-previous"
  | "pp-trigger-prop"
  | "pp-clear-props"
  | "pp-trigger-clear"
  | "custom-webhook";

export interface AutomationEvent {
  id: string;
  triggerTimecode: TimecodeValue;
  triggerFrame: number;
  action: AutomationActionType;
  /** Target device ID (for device-action) */
  targetDeviceId?: string;
  /** Action ID on the target device (for device-action) */
  targetActionId?: string;
  /** Action parameters or payload */
  payload: Record<string, unknown>;
  label: string;
  fired: boolean;
  /** Operator skipped this cue without acknowledging any external action. */
  skipped?: boolean;
  enabled: boolean;
  /** Startup/resync matching only; normal forward crossings ignore this value.
   * Defaults to DEFAULT_TIMECODE_TOLERANCE_FRAMES. Also bounds transient retries. */
  toleranceFrames: number;
  /** Additional cue anticipation, in milliseconds. Missing legacy values are zero. */
  leadMs?: number;
  /** Server-owned device latency captured for the current source/automation start. */
  deviceLatencyMs?: number;
  /** Pins an implicitly selected device to the latency captured for that device. */
  timingDeviceId?: string;
  /** Server-owned trigger position after lead and device latency are applied. */
  dispatchFrame?: number;
  /** Associated rundown item ID */
  rundownItemId?: string;
  /** Category for UI grouping */
  category?: string;
  /** Stable ownership key for atomic replace/upsert operations. */
  sourceKey?: string;
  /** Server-owned execution state for the most recent scheduled firing. */
  executionStatus?: "scheduled" | "dispatching" | "acknowledged" | "failed";
  executionError?: string;
  executedAt?: number;
  executionAttempts?: number;
  executionStartedAt?: number;
  executionDurationMs?: number;
  /** Automatic retry is allowed only after an explicit transient rejection. */
  executionRetryable?: boolean;
  executionId?: string;
}

export interface AutomationTimeline {
  id: string;
  name: string;
  orgId: string;
  events: AutomationEvent[];
  format: TimecodeFormat;
  createdAt: string;
  updatedAt: string;
}

// ─── Timecode Settings ──────────────────────────────────────

export interface TimecodeSettings {
  enabled: boolean;
  source: TimecodeSource;
  format: TimecodeFormat;
  showOnKiosk: boolean;
  showInRundown: boolean;
  triggersEnabled: boolean;
}

// ─── WebSocket Messages ─────────────────────────────────────

export type TimecodeControlStatus = "available" | "yours" | "other";

export type TimecodeWsMessage = (
  | { type: "sync"; lastSeenSequence: number | null }
  | { type: "hydrate"; state: TimecodeState; events: AutomationEvent[]; control?: TimecodeControlStatus; controller?: MidiControllerSnapshot }
  | { type: "hydrate"; state: TimecodeDisplayState }
  | { type: "tc-update"; state: TimecodeState | TimecodeDisplayState }
  | { type: "event-fired"; event: AutomationEvent; firedAt: number }
  | { type: "events-update"; events: AutomationEvent[] }
  | { type: "lyrics-update"; lyrics: LyricsDisplayState }
  | { type: "lyrics-clear" }
  | { type: "command"; action: TimecodeCommand; payload?: Record<string, unknown> }
  | { type: "command-rejected"; action: TimecodeCommand; error: string }
  | { type: "master-status"; granted: boolean }
  | { type: "control-status"; control: TimecodeControlStatus }
  | { type: "controller-update"; controller: MidiControllerSnapshot }
) & { showId?: string | null; serviceDate?: string | null };

export const TIMECODE_COMMANDS = [
  "claim-control",
  "save-controller",
  "release-control",
  "start",
  "stop",
  "pause",
  "feed-tc",
  "mtc-transport",
  "set-source",
  "set-format",
  "set-timecode",
  "add-event",
  "replace-event-group",
  "update-event",
  "remove-event",
  "reset-events",
  "retry-event",
  "fire-event",
  "fire-next",
  "skip-event",
  "rearm-event",
  "set-event-enabled",
  "set-triggers-enabled",
  "resume-automatic-cues",
  "set-lyrics",
  "control-lyrics",
  "clear-lyrics",
  "bridge-disconnected",
] as const;
export type TimecodeCommand = typeof TIMECODE_COMMANDS[number];
