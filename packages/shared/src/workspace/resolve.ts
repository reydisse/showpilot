import { CORE_MODULES } from "./modules";
import { WORKSPACE_TERMS } from "./terms";
import {
  MODULE_IDS,
  isModuleId,
  isWorkspaceType,
  type ModuleId,
  type WorkspaceType,
  type WorkspaceSettings,
  type WorkspaceTerms,
  type WorkspaceCustom,
  type WorkspaceProfile,
} from "./types";
export function resolveWorkspaceType(
  settings: WorkspaceSettings,
): WorkspaceType {
  const explicit = settings["workspace-type"];
  if (isWorkspaceType(explicit)) return explicit;
  if (settings["terminology-profile"] === "general") return "live_events";
  return "church";
}
export function legacyTerminologyProfile(
  type: WorkspaceType,
): "general" | "church" {
  return type === "church" ? "church" : "general";
}
export function legacyWorkspaceType(
  current: WorkspaceType,
  requested?: "general" | "church",
): WorkspaceType {
  if (requested === "church") return "church";
  return requested === "general" && current === "church"
    ? "live_events"
    : current;
}
export function resolveModules(stored?: unknown): ModuleId[] {
  if (stored == null) return [...MODULE_IDS];
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      return [...MODULE_IDS];
    }
  }
  if (!Array.isArray(value)) return [...MODULE_IDS];
  const selected = new Set(value.filter(isModuleId));
  CORE_MODULES.forEach((id) => selected.add(id));
  return MODULE_IDS.filter((id) => selected.has(id));
}
export function isWorkspaceTerm(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 24 &&
    !/[<>\x00-\x1f\x7f]/.test(value)
  );
}
export function parseWorkspaceCustom(stored: unknown): WorkspaceCustom | null {
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("label" in value) ||
    typeof value.label !== "string"
  )
    return null;
  const terms: WorkspaceCustom["terms"] = {};
  if (
    "terms" in value &&
    typeof value.terms === "object" &&
    value.terms !== null
  ) {
    for (const key of ["event", "events", "item", "items"] as const) {
      const term = Reflect.get(value.terms, key);
      if (isWorkspaceTerm(term)) terms[key] = term.trim();
    }
  }
  return {
    label: value.label
      .trim()
      .replace(/[<>\x00-\x1f\x7f]/g, "")
      .slice(0, 80),
    terms,
  };
}
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export function resolveTerms(
  type: WorkspaceType,
  custom?: unknown,
): WorkspaceTerms {
  const terms = { ...WORKSPACE_TERMS[type] };
  if (type !== "custom") return terms;
  const overrides = parseWorkspaceCustom(custom)?.terms;
  if (!overrides) return terms;
  if (overrides.event) {
    terms.event = overrides.event.toLowerCase();
    terms.eventTitle = title(overrides.event);
    terms.eventName = `${terms.eventTitle} name`;
    terms.eventPlural = title(overrides.events ?? `${overrides.event}s`);
    terms.participate = `work this ${terms.event}`;
  } else if (overrides.events) terms.eventPlural = title(overrides.events);
  if (overrides.item) {
    terms.item = title(overrides.item);
    terms.itemPlural = title(overrides.items ?? `${overrides.item}s`);
  } else if (overrides.items) terms.itemPlural = title(overrides.items);
  return terms;
}
export function resolveWorkspaceProfile(
  settings: WorkspaceSettings,
): WorkspaceProfile {
  const type = resolveWorkspaceType(settings);
  const custom = parseWorkspaceCustom(settings["workspace-custom"]);
  return {
    type,
    label: type === "custom" ? custom?.label || null : null,
    modules: resolveModules(settings["workspace-modules"]),
    terms: resolveTerms(type, custom),
    isExplicit: isWorkspaceType(settings["workspace-type"]),
  };
}
export function orgTerms(profile: "general" | "church") {
  return resolveTerms(profile === "general" ? "live_events" : "church");
}
