import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  adminAc,
  ownerAc,
  memberAc,
} from "better-auth/plugins/organization/access";

// ─── Statements ──────────────────────────────────────────
// Every resource + action pair that ShowPilot cares about.
// Better Auth's defaultStatements cover: organization, member,
// invitation, team, ac (access-control CRUD).

const statements = {
  ...defaultStatements,
  // Org-level
  billing: ["read", "update"],
  settings: ["read", "update"],
  integrations: ["read", "update"],
  kiosk: ["create", "revoke"],
  // Production
  dashboard: ["read"],
  rundown: ["read", "create", "update", "delete", "control"],
  schedule: ["read", "update"],
  cue: ["read", "create", "update", "delete"],
  lowerThirds: ["read", "create", "update", "delete", "trigger"],
  chat: ["read", "send", "alert"],
} as const;

export const ac = createAccessControl(statements);

// ─── Static Roles ────────────────────────────────────────
// These ship with every org. Admins can also create custom
// roles at runtime via dynamic access control.

/** Owner — one per org, full access including billing + org deletion */
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

/** Admin (TD, Production Director) — everything except billing + org delete */
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

// ─── Crew Presets ────────────────────────────────────────
// Crew = any member below Admin. Access is determined by
// their assigned role's permission set.

/** PM (Production Manager) — dashboard, full rundown, schedule editing, integrations view */
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
  lowerThirds: ["read", "create", "update", "delete", "trigger"],
  chat: ["read", "send", "alert"],
});

/** TM (Technical Manager) — dashboard, rundown view, cue editing */
export const tm = ac.newRole({
  ...memberAc.statements,
  billing: [],
  settings: ["read"],
  integrations: [],
  kiosk: [],
  dashboard: ["read"],
  rundown: ["read", "control"],
  schedule: ["read"],
  cue: ["read", "create", "update", "delete"],
  lowerThirds: ["read", "trigger"],
  chat: ["read", "send"],
});

/** Stage Manager — dashboard, rundown view, cue view, schedule view */
export const stageManager = ac.newRole({
  ...memberAc.statements,
  billing: [],
  settings: [],
  integrations: [],
  kiosk: [],
  dashboard: ["read"],
  rundown: ["read", "control"],
  schedule: ["read"],
  cue: ["read"],
  lowerThirds: ["read", "trigger"],
  chat: ["read", "send"],
});

/** Member — bare-minimum read access, no production control */
export const member = ac.newRole({
  ...memberAc.statements,
  billing: [],
  settings: [],
  integrations: [],
  kiosk: [],
  dashboard: ["read"],
  rundown: ["read"],
  schedule: ["read"],
  cue: ["read"],
  lowerThirds: ["read"],
  chat: ["read", "send"],
});

// ─── Exports ─────────────────────────────────────────────

/** All static roles — passed to both server and client */
export const roles = { owner, admin, pm, tm, stageManager, member };

/** Human-readable labels for UI */
export const ROLE_META: Record<
  string,
  { label: string; description: string; tier: "owner" | "admin" | "crew" }
> = {
  owner: {
    label: "Owner",
    description: "Full access including billing and org deletion",
    tier: "owner",
  },
  admin: {
    label: "Admin",
    description: "Full production access, member management, no billing",
    tier: "admin",
  },
  pm: {
    label: "PM",
    description: "Dashboard, full rundown, schedule editing, integrations view",
    tier: "crew",
  },
  tm: {
    label: "TM",
    description: "Dashboard, rundown view, cue editing",
    tier: "crew",
  },
  stageManager: {
    label: "Stage Manager",
    description: "Dashboard, rundown view, cue view, schedule view",
    tier: "crew",
  },
  member: {
    label: "Member",
    description: "Read-only access to production data",
    tier: "crew",
  },
};

/** Roles that can be assigned by admins when inviting */
export const ASSIGNABLE_ROLES = ["admin", "pm", "tm", "stageManager", "member"] as const;
