import type { ModuleAction, ModuleActionParam } from "./device-modules/types";

/** Display names and action schemas only; connection settings never leave the server. */
export type AutomationDeviceAction = Omit<ModuleAction, "params"> & {
  params: (Omit<ModuleActionParam, "default"> & { default?: string | number | boolean })[];
};
export interface AutomationDeviceTarget {
  id: string;
  label: string;
  category: string;
  actions: AutomationDeviceAction[];
}
export type CueDetails = { status: "ready"; payload: Record<string, unknown> } | { status: "invalid"; message: string };
