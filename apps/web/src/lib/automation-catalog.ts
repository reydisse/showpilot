import type { ModuleAction, ModuleActionParam } from "./device-modules/types";

/** Display names and action schemas only; connection settings never leave the server. */
export type AutomationDeviceAction = Omit<ModuleAction, "params"> & {
  params: (Omit<ModuleActionParam, "default"> & { default?: string | number | boolean })[];
};
export type AutomationDeviceTarget = {
  id: string;
  label: string;
  category: string;
} & ({ actionSource: "static"; actions: AutomationDeviceAction[] } | { actionSource: "homeassistant" });
export type CueDetails = { status: "ready"; payload: Record<string, unknown> } | { status: "invalid"; message: string };

export interface AutomationDeviceName { id: string; label: string; enabled: boolean }
export type AutomationDeviceNames = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: AutomationDeviceName[] };
