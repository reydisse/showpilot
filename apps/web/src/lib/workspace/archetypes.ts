import {
  moduleForSurface,
  type WorkspaceType,
  type ModuleId,
} from "@showpilot/shared";
import type { ArchetypeDef } from "../onboarding-flow";
export const ONBOARDING_ARCHETYPES: readonly ArchetypeDef[] = [
  {
    id: "td",
    label: "Technical Director",
    desc: "Runs the booth",
    landing: "/show",
  },
  {
    id: "pm",
    label: "Production Manager",
    desc: "Plans & coordinates",
    landing: "/dashboard/prod-manager",
  },
  {
    id: "sm",
    label: "Stage Manager",
    desc: "Calls the show",
    landing: "/rundown",
  },
  {
    id: "cd",
    label: "Creative / Worship Dir.",
    desc: "Owns the content",
    landing: "/streaming/graphics",
  },
  {
    id: "pastor",
    label: "Pastor / Staff",
    desc: "Oversees everything",
    landing: "/dashboard/prod-manager",
  },
  {
    id: "op",
    label: "Operator / Volunteer",
    desc: "Runs a position",
    landing: "/show",
  },
];

const LABELS: Record<WorkspaceType, { cd: string; pastor: string }> = {
  church: { cd: "Creative / Worship Dir.", pastor: "Pastor / Staff" },
  live_events: { cd: "Creative Director", pastor: "Client / Producer" },
  school: { cd: "Creative / Media Lead", pastor: "Teacher / Staff" },
  theatre: { cd: "Director / Designer", pastor: "Producer / Company Mgr" },
  custom: { cd: "Creative Director", pastor: "Leadership / Staff" },
};
export function archetypesForWorkspace(
  type: WorkspaceType,
): readonly ArchetypeDef[] {
  return ONBOARDING_ARCHETYPES.map((item) => ({
    ...item,
    label:
      item.id === "cd" || item.id === "pastor"
        ? LABELS[type][item.id]
        : item.label,
  }));
}
export function workspaceArchetypeLanding(
  id: string | null | undefined,
  modules?: readonly ModuleId[],
): string {
  const path =
    ONBOARDING_ARCHETYPES.find((item) => item.id === id)?.landing ?? "/show";
  const module = moduleForSurface("web", path);
  return module && modules && !modules.includes(module) ? "/show" : path;
}
