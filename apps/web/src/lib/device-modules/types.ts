/** Transport protocol used to communicate with the device */
export type TransportType =
  | "websocket"
  | "http"
  | "osc"
  | "tcp"
  | "udp"
  | "serial";

/** Whether the browser can connect directly or needs a bridge agent */
export type ConnectivityMode = "browser-direct" | "bridge-required";

/** Device connection lifecycle states */
export type DeviceConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "bridge-required";

/** Device categories matching the Prisma Device model */
export type DeviceCategory =
  | "mixer"
  | "video"
  | "lighting"
  | "streaming"
  | "timer"
  | "automation"
  | "comms";

/** A configuration field for device connection settings */
export interface AdapterField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "number" | "password" | "select";
  options?: { value: string; label: string }[];
  required?: boolean;
}

/** Parameter definition for a module action */
export interface ModuleActionParam {
  id: string;
  label: string;
  type: "number" | "string" | "boolean" | "select";
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
}

/** An action the operator can perform on the device */
export interface ModuleAction {
  id: string;
  label: string;
  category?: string;
  params: ModuleActionParam[];
}

/** Real-time state feedback from the device */
export interface ModuleFeedback<T = unknown> {
  id: string;
  label: string;
  type: "boolean" | "number" | "string" | "enum";
  value: T;
}

/** Status change listener callback */
export type StatusChangeCallback = (
  status: DeviceConnectionStatus,
  error?: string
) => void;

/** Feedback change listener callback */
export type FeedbackChangeCallback = (
  feedbackId: string,
  value: unknown
) => void;

/**
 * Runtime module instance — one per connected device.
 * This is the Companion "module" equivalent.
 */
export interface DeviceModule {
  /** Connect to the device */
  connect(): Promise<void>;
  /** Disconnect from the device */
  disconnect(): void;
  /** Current connection status */
  connectionStatus(): DeviceConnectionStatus;
  /** Subscribe to status changes. Returns unsubscribe function. */
  onStatusChange(callback: StatusChangeCallback): () => void;
  /** All actions this module supports */
  getActions(): ModuleAction[];
  /** Execute a specific action by id */
  executeAction(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<void>;
  /** All feedbacks this module exposes */
  getFeedbacks(): ModuleFeedback[];
  /** Subscribe to feedback changes. Returns unsubscribe function. */
  onFeedbackChange(callback: FeedbackChangeCallback): () => void;
}

/**
 * Static metadata about a module — used for registration and UI rendering
 * before any instance is created.
 */
export interface ModuleDefinition {
  /** Matches Device.adapterType in Prisma */
  adapterType: string;
  /** Human-readable name */
  displayName: string;
  /** Device category */
  category: DeviceCategory;
  /** What transport this device uses */
  transport: TransportType;
  /** Whether browser can connect directly */
  connectivity: ConnectivityMode;
  /** Fields needed in Device.settings JSON */
  configFields: AdapterField[];
  /** Icon name from lucide-react */
  icon: string;
  /** Short description */
  description: string;
  /** Create a module instance from device settings */
  createInstance(settings: Record<string, unknown>): DeviceModule;
}
