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
}

// ─── Automation Events ──────────────────────────────────────

export type AutomationActionType =
  | "device-action"
  | "lower-third-show"
  | "lower-third-clear"
  | "rundown-advance"
  | "rundown-start-item"
  | "lighting-scene"
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
  | { type: "tc-update"; state: TimecodeState }
  | { type: "event-fired"; event: AutomationEvent; firedAt: number }
  | { type: "events-update"; events: AutomationEvent[] }
  | { type: "command"; action: TimecodeCommand; payload?: Record<string, unknown> };

export type TimecodeCommand =
  | "start"
  | "stop"
  | "feed-tc"
  | "set-source"
  | "set-format"
  | "set-timecode"
  | "add-event"
  | "update-event"
  | "remove-event"
  | "reset-events";
