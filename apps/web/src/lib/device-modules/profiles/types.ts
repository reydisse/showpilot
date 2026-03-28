import type {
  DeviceCategory,
  AdapterField,
  ModuleActionParam,
} from "../types";

// ─── Param Transforms ─────────────────────────────────────

export interface ParamTransform {
  /** "map" = lookup table, "scale" = multiply, "format" = sprintf-style */
  type: "map" | "scale" | "format";
  /** For "map": human-readable value → protocol value */
  values?: Record<string, string>;
  /** For "scale": multiply param by this factor */
  factor?: number;
  /** For "format": e.g., "%02X" for hex, "%03d" for zero-padded */
  format?: string;
}

// ─── Action Mapping ───────────────────────────────────────

export interface ProfileActionMapping {
  /**
   * Protocol command template with {{paramName}} interpolation.
   * For HTTP: "GET /api/power/on" or "POST /api/command {\"action\":\"{{action}}\"}"
   * For PJLink: "%1POWR {{state}}\r"
   * For TCP: "{{channel}}*{{level}}!\r\n"
   */
  command: string;
  /** Optional param transformations before interpolation */
  paramTransforms?: Record<string, ParamTransform>;
}

// ─── Feedback Mapping ─────────────────────────────────────

export interface ProfileFeedbackMapping {
  /** Command to send for polling this feedback */
  pollCommand?: string;
  /** Poll interval in ms (default: 5000) */
  pollInterval?: number;
  /** Regex to extract value from response */
  responsePattern?: string;
  /** Which capture group (default: 1) */
  captureGroup?: number;
  /** Value mapping for enum/string feedbacks */
  valueMap?: Record<string, string>;
  /** For event-driven protocols: event name to listen for */
  eventName?: string;
}

// ─── Device Quirks ────────────────────────────────────────

export interface DeviceQuirks {
  /** Minimum ms between consecutive commands */
  commandInterval?: number;
  /** Ms to wait after power-on before sending other commands */
  powerOnDelay?: number;
  /** Ms to wait after connect before device is ready */
  connectDelay?: number;
  /** Custom line terminator override */
  lineTerminator?: string;
  /** Max concurrent pending commands (default: 1) */
  maxConcurrent?: number;
}

// ─── Profile Action & Feedback ────────────────────────────

export interface ProfileAction {
  id: string;
  label: string;
  category?: string;
  params: ModuleActionParam[];
  mapping: ProfileActionMapping;
}

export interface ProfileFeedback {
  id: string;
  label: string;
  type: "boolean" | "number" | "string" | "enum";
  defaultValue: unknown;
  mapping: ProfileFeedbackMapping;
}

// ─── Device Profile ───────────────────────────────────────

export interface DeviceProfile {
  /** Schema version for future migration */
  profileVersion: 1;
  /** Unique identifier: "manufacturer-model" */
  id: string;
  /** Device metadata */
  manufacturer: string;
  model: string;
  category: DeviceCategory;
  icon: string;
  description: string;
  /** Which protocol module drives this device */
  protocol: string;
  /** Protocol-specific default settings (e.g., default port) */
  protocolDefaults?: Record<string, unknown>;
  /** Additional config fields beyond the protocol's base fields */
  configFields?: AdapterField[];
  /** Actions this device supports */
  actions: ProfileAction[];
  /** Feedbacks this device exposes */
  feedbacks: ProfileFeedback[];
  /** Device-specific behavior quirks */
  quirks?: DeviceQuirks;
}
