export type DeviceCategory =
  | "mixer"
  | "streaming"
  | "timer"
  | "automation"
  | "video"
  | "comms";

export type DeviceStatus = "online" | "offline" | "error" | "connecting";

export interface DeviceConfig {
  id: string;
  name: string;
  category: DeviceCategory;
  adapterType: string;
  settings: Record<string, unknown>;
  enabled: boolean;
}

export interface DeviceState {
  deviceId: string;
  name: string;
  category: DeviceCategory;
  status: DeviceStatus;
  lastSeen: number;
  data: Record<string, unknown>;
  detail?: string;
  configured: boolean;
}

export interface DeviceCommand {
  type: string;
  payload?: Record<string, unknown>;
}

export interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
