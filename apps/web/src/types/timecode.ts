// ─── SMPTE Frame Rates ──────────────────────────────────────

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

export interface TimecodeState {
  timecode: TimecodeValue;
  display: string;
  source: TimecodeSourceType;
  format: TimecodeFormat;
  running: boolean;
  serverTime: number;
  totalFrames: number;
  lyrics: LyricsDisplayState | null;
}

/** Fields approved for the intentionally public confidence display. */
export type TimecodeDisplayState = Pick<
  TimecodeState,
  "display" | "running" | "serverTime" | "lyrics"
>;

export interface LyricsDisplayState {
  songId: string;
  songTitle: string;
  sectionId: string;
  sectionLabel: string;
  lyrics: string;
  nextLabel: string;
  updatedAt: number;
  manual: boolean;
  /** Identifies the automation load that owns a later scoped clear. */
  generationKey?: string;
}

// ─── Automation Events ──────────────────────────────────────

export type AutomationActionType =
  | "device-action"
  | "lower-third-show"
  | "lower-third-clear"
  | "rundown-advance"
  | "rundown-start-item"
  | "rundown-previous"
  | "rundown-pause"
  | "rundown-resume"
  | "rundown-stop"
  | "rundown-adjust"
  | "stage-message"
  | "stage-clear"
  | "lighting-scene"
  | "lyrics-goto"
  | "lyrics-clear"
  | "pp-trigger-slide"
  | "pp-trigger-next"
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
  /** Frames of tolerance for matching (default: 2) */
  toleranceFrames: number;
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

export type TimecodeWsMessage =
  | { type: "hydrate"; state: TimecodeState; events: AutomationEvent[] }
  | { type: "hydrate"; state: TimecodeDisplayState }
  | { type: "tc-update"; state: TimecodeState | TimecodeDisplayState }
  | { type: "event-fired"; event: AutomationEvent; firedAt: number }
  | { type: "events-update"; events: AutomationEvent[] }
  | { type: "lyrics-update"; lyrics: LyricsDisplayState }
  | { type: "lyrics-clear" }
  | { type: "command"; action: TimecodeCommand; payload?: Record<string, unknown> }
  | { type: "master-status"; granted: boolean };

export type TimecodeCommand =
  | "start"
  | "stop"
  | "feed-tc"
  | "set-source"
  | "set-format"
  | "set-timecode"
  | "add-event"
  | "replace-event-group"
  | "update-event"
  | "remove-event"
  | "reset-events"
  | "set-lyrics"
  | "clear-lyrics"
  | "bridge-disconnected";
