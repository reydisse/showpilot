import { WORKSPACE_SETTING_KEYS, resolveWorkspaceProfile } from "@showpilot/shared";
import { WORKSPACE_REVISION_KEY } from "./workspace/profile-contract";
import { writeWorkspaceProfile } from "./workspace/profile.server";
import { buildOnboardingRoleValue } from "./onboarding-flow";
import { parseSetupRole, parseWorkspaceReceipt, type SetupChoicesSnapshot, type SetupChoiceCommand } from "./setup-choices-contract";
import type { RundownDatabase } from "./rundown-item-storage.server";
const roleKey = (userId: string) => `onboarding-role:${userId}`;
export async function readSetupChoices(db: RundownDatabase, orgId: string, userId: string): Promise<SetupChoicesSnapshot> {
  const { results } = await db.prepare(`SELECT key, value FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?, ?, ?)`)
    .bind(orgId, ...WORKSPACE_SETTING_KEYS, WORKSPACE_REVISION_KEY, roleKey(userId)).all<{ key: string; value: string }>();
  const values = new Map(results.map(row => [row.key, row.value]));
  return { settings: Object.fromEntries(results.filter(row => WORKSPACE_SETTING_KEYS.includes(row.key)).map(row => [row.key, row.value])),
    workspaceRevision: values.get(WORKSPACE_REVISION_KEY) ?? null, roleValue: values.get(roleKey(userId)) ?? null };
}
async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
export async function saveSetupChoice(db: RundownDatabase, userId: string, command: SetupChoiceCommand): Promise<SetupChoicesSnapshot> {
  const current = await readSetupChoices(db, command.orgId, userId);
  let key: string;
  let value: string;
  let entries: [string, string][] = [];
  let expectedFingerprint: string | undefined;
  if (command.kind === "workspace") {
    const hash = await fingerprint(command.selection); expectedFingerprint = hash;
    const receipt = parseWorkspaceReceipt(current.workspaceRevision);
    if (receipt?.requestId === command.requestId) {
      if (receipt.fingerprint !== hash) throw new Error("This save request already belongs to a different workspace choice.");
      return current;
    }
    // Reuse the same workspace normalization as Settings and mobile, without writing yet.
    await writeWorkspaceProfile({ read: async () => current.settings, write: async next => { entries = next; } }, { kind: "initial", onlyIfUnconfigured: false, ...command.selection });
    key = WORKSPACE_REVISION_KEY;
    value = JSON.stringify({ requestId: command.requestId, fingerprint: hash, nonce: crypto.randomUUID() });
  } else {
    const receipt = parseSetupRole(current.roleValue);
    if (receipt?.requestId === command.requestId) {
      if (receipt.archetype !== command.archetype) throw new Error("This save request already belongs to a different team role.");
      return current;
    }
    key = roleKey(userId);
    value = buildOnboardingRoleValue(command.archetype, resolveWorkspaceProfile(current.settings).modules, { requestId: command.requestId, nonce: crypto.randomUUID() });
  }
  // A fresh invocation nonce prevents even identical request retries from replaying
  // the field writes. A newer Settings/mobile/setup revision makes this CAS fail.
  await db.batch([
    db.prepare(`INSERT INTO app_setting (id, orgId, key, value) SELECT ?, ?, ?, ?
      WHERE (SELECT value FROM app_setting WHERE orgId = ? AND key = ?) IS ?
      ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value WHERE value IS ?`)
      .bind(crypto.randomUUID(), command.orgId, key, value, command.orgId, key, command.expectedRevision, command.expectedRevision),
    ...entries.map(([field, entry]) => db.prepare(`INSERT INTO app_setting (id, orgId, key, value) SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = ? AND value = ?)
      ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`)
      .bind(crypto.randomUUID(), command.orgId, field, entry, command.orgId, key, value)),
  ]);
  const saved = await readSetupChoices(db, command.orgId, userId);
  if (command.kind === "workspace") {
    const receipt = parseWorkspaceReceipt(saved.workspaceRevision);
    if (receipt?.requestId === command.requestId && receipt.fingerprint !== expectedFingerprint) throw new Error("This save request already belongs to a different workspace choice.");
  } else {
    const receipt = parseSetupRole(saved.roleValue);
    if (receipt?.requestId === command.requestId && receipt.archetype !== command.archetype) throw new Error("This save request already belongs to a different team role.");
  }
  return saved;
}
