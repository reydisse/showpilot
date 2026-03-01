import type { DeviceCommand, DeviceState } from "./devices";

/** Messages sent from gateway to cloud */
export type GatewayToCloud =
  | { type: "device:state"; data: DeviceState }
  | { type: "device:meters"; deviceId: string; data: Record<string, unknown> }
  | { type: "gateway:hello"; orgId: string; apiKey: string };

/** Messages sent from cloud to gateway */
export type CloudToGateway =
  | { type: "device:command"; deviceId: string; command: DeviceCommand }
  | { type: "gateway:authenticated" }
  | { type: "gateway:error"; message: string };

/** Messages sent from server to browser clients */
export type ServerToClient =
  | { type: "members:updated"; data: unknown[] }
  | { type: "notifications:new"; data: unknown }
  | { type: "checklist:updated"; data: unknown }
  | { type: "device:state"; data: DeviceState }
  | { type: "device:removed"; deviceId: string }
  | { type: "heartbeat" };

/** Messages sent from browser clients to server */
export type ClientToServer =
  | { type: "device:command"; deviceId: string; command: DeviceCommand }
  | { type: "subscribe"; channels: string[] };
