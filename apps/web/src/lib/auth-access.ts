import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

// This file intentionally stays separate from the app RBAC model.
// Better Auth only needs a stable org-role definition for session, invitation,
// and membership plumbing. Keeping it isolated prevents app permission changes
// from breaking sign-in or active-organization resolution.

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

export const authAccessControl = createAccessControl(statements);

const owner = authAccessControl.newRole({
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

const admin = authAccessControl.newRole({
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

const pm = authAccessControl.newRole({
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

const tm = authAccessControl.newRole({
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

const stageManager = authAccessControl.newRole({
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

const member = authAccessControl.newRole({
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

export const authRoles = {
  owner,
  admin,
  // Director roles (Technical/Creative/Production) carry the admin
  // statement set — all directors have admin-level access. Distinct
  // names so the title renders on the team page and invitations, and
  // the sets can diverge later without a migration.
  td: admin,
  cd: admin,
  pd: admin,
  pm,
  tm,
  stageManager,
  sm: stageManager,
  member,
};
