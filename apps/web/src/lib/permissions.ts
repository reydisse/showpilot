import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export type Role = "owner" | "admin" | "td" | "cd" | "pd" | "pm" | "tm" | "sm" | "member";
export type LegacyRole = Role | "stageManager";

export type Permission =
  | "show:view" | "show:edit"
  | "showboard:view" | "showboard:edit"
  | "rundown:view" | "rundown:edit" | "rundown:pin_required"
  | "cuesheet:view" | "cuesheet:edit" | "cuesheet:add_notes"
  | "cuesheet:push_to_checklist" // PLANNED
  | "chat:access"
  | "checklist:view" | "checklist:access"
  | "incidents:report" | "incidents:access"
  | "checkin:access"
  | "timecode:access"
  | "lowerthird:view" | "lowerthird:trigger" | "lowerthird:configure"
  | "dashboard:pm" | "dashboard:tm"
  | "devices:access"
  | "streaming_suite:access"
  | "stream_health:view" | "stream_health:manage"
  | "assets:view" | "assets:manage"
  | "settings:organization"
  | "settings:members"
  | "settings:billing"
  | "settings:integrations"
  | "settings:production_defaults"
  | "settings:lowerthird_config"
  | "settings:notifications"
  | "settings:api_keys"
  | "settings:webhooks"
  | "settings:danger_zone"
  | "org:delete";

const ALL_PERMISSIONS = [
  "show:view", "show:edit",
  "showboard:view", "showboard:edit",
  "rundown:view", "rundown:edit", "rundown:pin_required",
  "cuesheet:view", "cuesheet:edit", "cuesheet:add_notes",
  "cuesheet:push_to_checklist", // PLANNED
  "chat:access",
  "checklist:view", "checklist:access",
  "incidents:report", "incidents:access",
  "checkin:access",
  "timecode:access",
  "lowerthird:view", "lowerthird:trigger", "lowerthird:configure",
  "dashboard:pm", "dashboard:tm",
  "devices:access",
  "streaming_suite:access",
  "stream_health:view", "stream_health:manage",
  "assets:view", "assets:manage",
  "settings:organization",
  "settings:members",
  "settings:billing",
  "settings:integrations",
  "settings:production_defaults",
  "settings:lowerthird_config",
  "settings:notifications",
  "settings:api_keys",
  "settings:webhooks",
  "settings:danger_zone",
  "org:delete",
] as const satisfies readonly Permission[];

// Admin tier: everything except org deletion. Shared by `admin` and the
// director roles (td/cd/pd) so a permission added to ALL_PERMISSIONS flows
// to all four automatically. Director sets can diverge later without a migration.
const ADMIN_TIER_PERMISSIONS = ALL_PERMISSIONS.filter(
  (permission) => permission !== "org:delete",
);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ADMIN_TIER_PERMISSIONS,
  td: ADMIN_TIER_PERMISSIONS,
  cd: ADMIN_TIER_PERMISSIONS,
  pd: ADMIN_TIER_PERMISSIONS,
  pm: [
    "show:view", "show:edit",
    "showboard:view", "showboard:edit",
    "rundown:view", "rundown:edit",
    "cuesheet:view", "cuesheet:edit",
    "chat:access",
    "checklist:access",
    "incidents:access",
    "checkin:access",
    "timecode:access",
    "lowerthird:view", "lowerthird:trigger",
    "dashboard:pm",
    "stream_health:view",
    "assets:view",
  ],
  tm: [
    "show:view",
    "showboard:view",
    "rundown:view", "rundown:pin_required",
    "cuesheet:view", "cuesheet:add_notes",
    "cuesheet:push_to_checklist", // PLANNED
    "chat:access",
    "checklist:access",
    "incidents:access",
    "timecode:access",
    "lowerthird:view", "lowerthird:trigger", "lowerthird:configure",
    "dashboard:tm",
    "devices:access",
    "streaming_suite:access",
    "stream_health:view", "stream_health:manage",
    "assets:view", "assets:manage",
    "settings:organization",
    "settings:integrations",
    "settings:production_defaults",
    "settings:lowerthird_config",
    "settings:notifications",
  ],
  sm: [
    "show:view", "show:edit",
    "showboard:view", "showboard:edit",
    "rundown:view", "rundown:edit",
    "cuesheet:view", "cuesheet:edit",
    "chat:access",
    "checklist:access",
    "incidents:access",
    "checkin:access",
    "timecode:access",
    "dashboard:pm",
    "stream_health:view",
    "assets:view",
    "settings:organization",
    "settings:integrations",
    "settings:production_defaults",
    "settings:notifications",
  ],
  member: [
    "show:view",
    "showboard:view",
    "rundown:view",
    "chat:access",
    "checklist:view",
    "incidents:report",
  ],
};

export function normalizeRole(role: string | null | undefined): Role | null {
  if (!role) return null;
  if (role === "stageManager") return "sm";
  if (
    role === "owner" || role === "admin" ||
    role === "td" || role === "cd" || role === "pd" ||
    role === "pm" || role === "tm" || role === "sm" || role === "member"
  ) {
    return role;
  }
  return null;
}

export function getPermissions(role: string | null | undefined): readonly Permission[] {
  const normalized = normalizeRole(role);
  return normalized ? ROLE_PERMISSIONS[normalized] : [];
}

export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  return getPermissions(role).includes(permission);
}

export function hasAnyPermission(
  role: string | null | undefined,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => hasPermission(role, permission));
}

export function roleRequiresRundownPin(role: string | null | undefined): boolean {
  return hasPermission(role, "rundown:pin_required");
}

export function isLowerThirdPermission(permission: Permission): boolean {
  return permission.startsWith("lowerthird:");
}

// Owner + admin tier (owner, admin, and the director roles td/cd/pd which
// share the admin statement set). Used to gate org-level feature flags like
// cloud lower thirds to owner/admin only — crew roles are excluded.
export function isAdminTier(role: string | null | undefined): boolean {
  const normalized = normalizeRole(role);
  if (!normalized) return false;
  const tier = ROLE_META[normalized].tier;
  return tier === "owner" || tier === "admin";
}

// Better Auth compatibility exports.
// These keep the existing organization plugin wiring intact while the app-level
// RBAC system resolves the production permissions at request time.
const statements = {
  ...defaultStatements,
  billing: ["read", "update"],
  settings: ["read", "update"],
  integrations: ["read", "update"],
  kiosk: ["create", "revoke"],
  dashboard: ["read"],
  rundown: ["read", "create", "update", "delete", "control"],
  schedule: ["read", "update"],
  cue: ["read", "create", "update", "delete"],
  lowerThirds: ["read", "create", "update", "delete", "trigger"],
  chat: ["read", "send", "alert"],
} as const;

export const ac = createAccessControl(statements);

export const owner = ac.newRole({
  ...ownerAc.statements,
  billing: ["read", "update"],
  settings: ["read", "update"],
  integrations: ["read", "update"],
  kiosk: ["create", "revoke"],
  dashboard: ["read"],
  rundown: ["read", "create", "update", "delete", "control"],
  schedule: ["read", "update"],
  cue: ["read", "create", "update", "delete"],
  lowerThirds: ["read", "create", "update", "delete", "trigger"],
  chat: ["read", "send", "alert"],
});

export const admin = ac.newRole({
  ...adminAc.statements,
  billing: [],
  settings: ["read", "update"],
  integrations: ["read", "update"],
  kiosk: ["create", "revoke"],
  dashboard: ["read"],
  rundown: ["read", "create", "update", "delete", "control"],
  schedule: ["read", "update"],
  cue: ["read", "create", "update", "delete"],
  lowerThirds: ["read", "create", "update", "delete", "trigger"],
  chat: ["read", "send", "alert"],
});

export const pm = ac.newRole({
  ...memberAc.statements,
  billing: [],
  settings: ["read"],
  integrations: ["read"],
  kiosk: [],
  dashboard: ["read"],
  rundown: ["read", "create", "update", "delete", "control"],
  schedule: ["read", "update"],
  cue: ["read", "create", "update", "delete"],
  lowerThirds: ["read", "trigger"],
  chat: ["read", "send", "alert"],
});

export const tm = ac.newRole({
  ...memberAc.statements,
  billing: [],
  settings: ["read"],
  integrations: ["read"],
  kiosk: [],
  dashboard: ["read"],
  rundown: ["read", "control"],
  schedule: ["read"],
  cue: ["read", "create", "update"],
  lowerThirds: ["read", "create", "update", "delete", "trigger"],
  chat: ["read", "send"],
});

export const sm = ac.newRole({
  ...memberAc.statements,
  billing: [],
  settings: ["read"],
  integrations: ["read"],
  kiosk: [],
  dashboard: ["read"],
  rundown: ["read", "create", "update", "delete", "control"],
  schedule: ["read", "update"],
  cue: ["read", "create", "update", "delete"],
  lowerThirds: [],
  chat: ["read", "send"],
});

export const member = ac.newRole({
  ...memberAc.statements,
  billing: [],
  settings: [],
  integrations: [],
  kiosk: [],
  dashboard: [],
  rundown: ["read"],
  schedule: [],
  cue: [],
  lowerThirds: [],
  chat: ["read", "send"],
});

export const stageManager = sm;

// Director roles share the admin statement set (admin tier). Kept as
// distinct role names so titles render correctly and the sets can
// diverge later without a data migration.
export const td = admin;
export const cd = admin;
export const pd = admin;

export const roles = {
  owner,
  admin,
  td,
  cd,
  pd,
  pm,
  tm,
  sm,
  member,
  stageManager: sm,
};

export const ROLE_META: Record<LegacyRole, { label: string; description: string; tier: "owner" | "admin" | "crew" }> = {
  owner: {
    label: "Owner",
    description: "Full access including billing and organization deletion",
    tier: "owner",
  },
  admin: {
    label: "Admin",
    description: "Full system access except organization deletion",
    tier: "admin",
  },
  td: {
    label: "Technical Director",
    description: "Admin-level access — runs the booth and owns the technical show",
    tier: "admin",
  },
  cd: {
    label: "Creative Director",
    description: "Admin-level access — owns content, graphics, and the creative show",
    tier: "admin",
  },
  pd: {
    label: "Production Director",
    description: "Admin-level access — owns planning and the overall production",
    tier: "admin",
  },
  pm: {
    label: "Production Manager",
    description: "Production control, checklist, incidents, and PM dashboard",
    tier: "crew",
  },
  tm: {
    label: "Tech Manager",
    description: "Technical control, streaming, devices, and TM dashboard",
    tier: "crew",
  },
  sm: {
    label: "Stage Manager",
    description: "Show and rundown control without lower thirds or streaming management",
    tier: "crew",
  },
  stageManager: {
    label: "Stage Manager",
    description: "Legacy alias for Stage Manager",
    tier: "crew",
  },
  member: {
    label: "Member",
    description: "Limited operator visibility with chat, checklist view, and incident reporting",
    tier: "crew",
  },
};

export const ASSIGNABLE_ROLES = ["td", "cd", "pd", "pm", "tm", "sm", "admin", "member"] as const;
