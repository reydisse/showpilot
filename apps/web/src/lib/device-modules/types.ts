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

/** Protocols the venue Bridge can execute on behalf of remote operators. */
export type BridgeDeviceProtocol =
  | "atem"
  | "dmx-artnet"
  | "dmx-sacn"
  | "http-command"
  | "obs"
  | "osc"
  | "pjlink"
  | "propresenter"
  | "tcp-command"
  | "udp"
  | "visca-ip"
  | "wol";

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
  category: string;
  params: ModuleActionParam[];
}

/** Real-time state feedback from the device */
export interface ModuleFeedback<T = unknown> {
  id: string;
  label: string;
  type: "boolean" | "number" | "string" | "enum";
  value: T;
}

export interface RemoteFeedbackQuery {
  feedbackIds: string[];
  command: string;
  parse(response: string): Record<string, unknown>;
}

export interface RemoteControlDefinition {
  protocol: BridgeDeviceProtocol;
  target(settings: Record<string, unknown>): string | null;
  connectionSettings?(settings: Record<string, unknown>): Record<string, unknown>;
  actions(settings: Record<string, unknown>): ModuleAction[];
  feedbacks(settings: Record<string, unknown>): ModuleFeedback[];
  buildCommand(
    actionId: string,
    params: Record<string, unknown>,
    settings: Record<string, unknown>,
  ): string;
  feedbackQueries?(settings: Record<string, unknown>): RemoteFeedbackQuery[];
  parseEvent?(
    eventName: string,
    data: string,
    settings: Record<string, unknown>,
  ): Record<string, unknown>;
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
  /** Server-owned remote control contract used by native and off-site clients. */
  remoteControl?: RemoteControlDefinition;
  /** Create a module instance from device settings */
  createInstance(settings: Record<string, unknown>): DeviceModule;
}
