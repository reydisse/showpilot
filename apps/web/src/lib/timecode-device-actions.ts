import { resolveRemoteDeviceControl } from "./mobile-device-controls";
import type { BridgeDeviceProtocol } from "./device-modules/types";
import type { AutomationEvent } from "@/types/timecode";

interface TimecodeDeviceRow {
  id: string;
  name: string;
  category: string;
  adapterType: string;
  settings: string;
  enabled: number | boolean;
}

export interface ResolvedTimecodeDeviceAction {
  deviceId: string;
  deviceName: string;
  protocol: BridgeDeviceProtocol;
  target: string;
  connectionSettings: Record<string, unknown>;
  command: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseSettings(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveLightingDevice(db: D1Database, orgId: string): Promise<TimecodeDeviceRow> {
  const result = await db.prepare(
    `SELECT id, name, category, adapterType, settings, enabled
     FROM device
     WHERE orgId = ? AND category = 'lighting' AND enabled = 1
     ORDER BY name ASC
     LIMIT 2`,
  ).bind(orgId).all<TimecodeDeviceRow>();
  if (result.results.length === 0) {
    throw new Error("No enabled lighting device is configured for this organization.");
  }
  if (result.results.length > 1) {
    throw new Error("Choose a lighting device for this event; more than one enabled lighting device is configured.");
  }
  return result.results[0];
}

export async function resolveTimecodeDeviceAction(
  db: D1Database,
  orgId: string,
  event: AutomationEvent,
): Promise<ResolvedTimecodeDeviceAction> {
  const deviceId = optionalString(
    event.targetDeviceId,
    event.payload.deviceId,
    event.payload.targetDeviceId,
  );
  let device: TimecodeDeviceRow | null;
  if (deviceId) {
    device = await db.prepare(
      `SELECT id, name, category, adapterType, settings, enabled
       FROM device WHERE id = ? AND orgId = ? LIMIT 1`,
    ).bind(deviceId, orgId).first<TimecodeDeviceRow>();
    if (!device || !device.enabled) throw new Error("The selected device does not exist or is disabled.");
  } else if (event.action === "lighting-scene") {
    device = await resolveLightingDevice(db, orgId);
  } else {
    throw new Error("Choose a target device for this automation event.");
  }

  const settings = parseSettings(device.settings);
  if (!settings) throw new Error(`Device “${device.name}” has invalid settings.`);
  const remote = resolveRemoteDeviceControl(device.adapterType, settings);
  if (!remote) throw new Error(`Device “${device.name}” does not support remote control.`);

  const requestedActionId = optionalString(
    event.targetActionId,
    event.payload.actionId,
    event.payload.targetActionId,
  );
  const actionId = requestedActionId || (event.action === "lighting-scene" ? "recall_scene" : "");
  if (!actionId) throw new Error("Choose a device action for this automation event.");
  if (!remote.actions.some((action) => action.id === actionId)) {
    throw new Error(`Action “${actionId}” is not available on device “${device.name}”.`);
  }

  const explicitParams = event.payload.params;
  const params = isRecord(explicitParams)
    ? explicitParams
    : Object.fromEntries(Object.entries(event.payload).filter(([key]) => ![
        "deviceId",
        "targetDeviceId",
        "actionId",
        "targetActionId",
      ].includes(key)));

  return {
    deviceId: device.id,
    deviceName: device.name,
    protocol: remote.definition.protocol,
    target: remote.target,
    connectionSettings: remote.connectionSettings,
    command: remote.definition.buildCommand(actionId, params, settings),
  };
}
