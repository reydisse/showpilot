import type { Permission } from "@/lib/permissions";

export const ACCESS_CAPABILITIES = [
  {
    id: "show-planning",
    label: "Show planning",
    description: "Edit show details and manage the production schedule.",
    permissions: ["show:view", "show:edit", "schedule:view", "schedule:manage"],
  },
  {
    id: "rundown-operator",
    label: "Rundown operator",
    description: "View, edit, start, advance, and control rundowns.",
    permissions: ["rundown:view", "rundown:edit", "rundown:control"],
  },
  {
    id: "show-board-operator",
    label: "Show Board operator",
    description: "View and operate the Show Board output.",
    permissions: ["showboard:view", "showboard:edit"],
  },
  {
    id: "cue-sheet-editor",
    label: "Cue sheet editor",
    description: "View and edit cue sheets, columns, and notes.",
    permissions: ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes"],
  },
  {
    id: "checklist-manager",
    label: "Checklist manager",
    description: "View and update production checklists.",
    permissions: ["checklist:view", "checklist:access"],
  },
  {
    id: "incident-manager",
    label: "Incident manager",
    description: "Report, assign, and resolve production incidents.",
    permissions: ["incidents:report", "incidents:access"],
  },
  {
    id: "check-in-operator",
    label: "Check-in operator",
    description: "Access crew check-in and attendance tools.",
    permissions: ["checkin:access"],
  },
  {
    id: "timecode-operator",
    label: "Timecode operator",
    description: "Access and operate the production timecode surface.",
    permissions: ["timecode:access"],
  },
  {
    id: "graphics-operator",
    label: "Graphics operator",
    description: "View, configure, and trigger lower thirds.",
    permissions: ["lowerthird:view", "lowerthird:trigger", "lowerthird:configure"],
  },
  {
    id: "device-operator",
    label: "Device operator",
    description: "Access connected production equipment and controls.",
    permissions: ["devices:access", "dashboard:tm"],
  },
  {
    id: "streaming-operator",
    label: "Streaming operator",
    description: "Access streaming destinations and manage stream health.",
    permissions: [
      "streaming_suite:access",
      "stream_health:view",
      "stream_health:manage",
    ],
  },
  {
    id: "asset-manager",
    label: "Asset manager",
    description: "View, upload, organize, and update production assets.",
    permissions: ["assets:view", "assets:manage"],
  },
  {
    id: "production-dashboard",
    label: "Production dashboard",
    description: "Access the Production Manager dashboard and reports.",
    permissions: ["dashboard:pm"],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  description: string;
  permissions: readonly Permission[];
}[];

export type AccessCapabilityId = (typeof ACCESS_CAPABILITIES)[number]["id"];

const GRANTABLE_PERMISSIONS = new Set<Permission>(
  ACCESS_CAPABILITIES.flatMap((capability) => [...capability.permissions]),
);

export function isGrantablePermission(value: unknown): value is Permission {
  return typeof value === "string" && GRANTABLE_PERMISSIONS.has(value as Permission);
}

export const ACCESS_CAPABILITY_IDS = ACCESS_CAPABILITIES.map(
  (capability) => capability.id,
) as [AccessCapabilityId, ...AccessCapabilityId[]];

export function getAccessCapability(id: string) {
  return ACCESS_CAPABILITIES.find((capability) => capability.id === id) ?? null;
}
