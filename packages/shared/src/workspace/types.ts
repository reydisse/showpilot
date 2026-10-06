export const WORKSPACE_SETTING_KEYS: readonly string[] = [
  "workspace-type",
  "workspace-modules",
  "workspace-custom",
  "terminology-profile",
];
export const WORKSPACE_TYPES = [
  "church",
  "live_events",
  "school",
  "theatre",
  "custom",
] as const;
export type WorkspaceType = (typeof WORKSPACE_TYPES)[number];
export const MODULE_IDS = [
  "show",
  "rundown",
  "team",
  "schedule",
  "board",
  "chat",
  "production",
  "timecode",
  "songs",
  "streaming",
  "lower_thirds",
  "dashboards",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export function isWorkspaceType(value: unknown): value is WorkspaceType {
  return WORKSPACE_TYPES.some((type) => type === value);
}
export function isModuleId(value: unknown): value is ModuleId {
  return MODULE_IDS.some((id) => id === value);
}
export const TERM_KEYS = [
  "event",
  "eventTitle",
  "eventPlural",
  "eventName",
  "participate",
  "scheduled",
  "checkinCta",
  "section",
  "item",
  "itemPlural",
  "presenter",
  "presenterExample",
  "sectionExample",
  "eventNameExample",
] as const;
export type TermKey = (typeof TERM_KEYS)[number];
export type WorkspaceTerms = Record<TermKey, string>;
export interface WorkspaceCustom {
  label: string;
  terms: { event?: string; events?: string; item?: string; items?: string };
}
export interface WorkspaceProfile {
  type: WorkspaceType;
  label: string | null;
  modules: ModuleId[];
  terms: WorkspaceTerms;
  isExplicit: boolean;
}
export type WorkspaceSettings = Readonly<
  Record<string, string | null | undefined>
>;
