import type { AccessGrantNotificationPath } from "@/lib/notification-destination";
import type { Permission } from "@/lib/permissions";

export const ACCESS_CAPABILITIES = [
  {
    id: "show-planning",
    label: "Show planning",
    description: "Edit show details and manage the production schedule.",
    permissions: ["show:view", "show:edit", "schedule:view", "schedule:manage"],
    notificationPath: "schedule",
  },
  {
    id: "rundown-operator",
    label: "Rundown operator",
    description: "View, edit, start, advance, and control rundowns.",
    permissions: ["rundown:view", "rundown:edit", "rundown:control"],
    notificationPath: "rundown",
  },
  {
    id: "show-board-operator",
    label: "Show Board operator",
    description: "View and operate the Show Board output.",
    permissions: ["showboard:view", "showboard:edit"],
    notificationPath: "board",
  },
  {
    id: "cue-sheet-editor",
    label: "Cue sheet editor",
    description: "View and edit cue sheets, columns, and notes.",
    permissions: ["cuesheet:view", "cuesheet:edit", "cuesheet:add_notes"],
    notificationPath: "production/cue-sheets",
  },
  {
    id: "checklist-manager",
    label: "Checklist manager",
    description: "View and update production checklists.",
    permissions: ["checklist:view", "checklist:access"],
    notificationPath: "production/checklist",
  },
  {
    id: "incident-manager",
    label: "Incident manager",
    description: "Report, assign, and resolve production incidents.",
    permissions: ["incidents:report", "incidents:access"],
    notificationPath: "production/incidents",
  },
  {
    id: "check-in-operator",
    label: "Check-in operator",
    description: "Access crew check-in and attendance tools.",
    permissions: ["checkin:access"],
    notificationPath: "checkin",
  },
  {
    id: "timecode-operator",
    label: "Timecode operator",
    description: "Access and operate the production timecode surface.",
    permissions: ["timecode:access"],
    notificationPath: "timecode",
  },
  {
    id: "graphics-operator",
    label: "Graphics operator",
    description: "View, configure, and trigger lower thirds.",
    permissions: ["lowerthird:view", "lowerthird:trigger", "lowerthird:configure"],
    notificationPath: "streaming/graphics",
  },
  {
    id: "device-operator",
    label: "Device operator",
    description: "Access connected production equipment and controls.",
    permissions: ["devices:access", "dashboard:tm"],
    notificationPath: "dashboard/tech-manager",
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
    notificationPath: "streaming/health",
  },
  {
    id: "asset-manager",
    label: "Asset manager",
    description: "View, upload, organize, and update production assets.",
    permissions: ["assets:view", "assets:manage"],
    notificationPath: "production/assets",
  },
  {
    id: "production-dashboard",
    label: "Production dashboard",
    description: "Access the Production Manager dashboard and reports.",
    permissions: ["dashboard:pm"],
    notificationPath: "dashboard/prod-manager",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  description: string;
  permissions: readonly Permission[];
  notificationPath: AccessGrantNotificationPath;
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
