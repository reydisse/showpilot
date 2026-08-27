import "./device-modules/register-all";
import { moduleRegistry } from "./device-modules/registry";
import { buildAtemBridgeCommand } from "./device-modules/atem/atem-module";
import type { ModuleAction, ModuleFeedback, RemoteControlDefinition } from "./device-modules/types";

export type MobileDeviceAction = ModuleAction;

export interface ResolvedRemoteDeviceControl {
  definition: RemoteControlDefinition;
  target: string;
  actions: ModuleAction[];
  feedbacks: ModuleFeedback[];
  connectionSettings: Record<string, unknown>;
}

export function resolveRemoteDeviceControl(
  adapterType: string,
  settings: Record<string, unknown>,
): ResolvedRemoteDeviceControl | null {
  const definition = moduleRegistry.get(adapterType)?.remoteControl;
  if (!definition) return null;
  const target = definition.target(settings);
  if (!target) return null;
  return {
    definition,
    target,
    actions: definition.actions(settings),
    feedbacks: definition.feedbacks(settings),
    connectionSettings: definition.connectionSettings?.(settings) ?? settings,
  };
}

export function actionsForMobileAdapter(
  adapterType: string,
  consoleType?: "x32" | "wing",
): ModuleAction[] {
  const settings = consoleType ? { consoleName: consoleType, host: "catalog" } : { host: "catalog" };
  return moduleRegistry.get(adapterType)?.remoteControl?.actions(settings) ?? [];
}

export function buildMobileAtemCommand(actionId: string, params: Record<string, unknown>): string {
  return buildAtemBridgeCommand(actionId, params);
}
