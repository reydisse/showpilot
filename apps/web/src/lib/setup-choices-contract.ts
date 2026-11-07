import { z } from "zod";
import { isOnboardingArchetype, type OnboardingArchetype } from "./onboarding-flow";
import { workspaceCustomSchema, workspaceModulesSchema, workspaceTypeSchema } from "./workspace/profile-contract";
import { idSchema } from "./validation";
const revision = z.string().max(4096).nullable();
export const setupWorkspaceSelectionSchema = z.object({ type: workspaceTypeSchema, custom: workspaceCustomSchema.optional(), modules: workspaceModulesSchema.optional() });
export type SetupWorkspaceSelection = z.infer<typeof setupWorkspaceSelectionSchema>;
export const setupRoleSchema = z.custom<OnboardingArchetype>(value => typeof value === "string" && isOnboardingArchetype(value), "Choose a team role.");
const command = z.object({ orgId: idSchema, requestId: z.string().uuid(), expectedRevision: revision });
export const setupWorkspaceCommandSchema = command.extend({ kind: z.literal("workspace"), selection: setupWorkspaceSelectionSchema });
export const setupRoleCommandSchema = command.extend({ kind: z.literal("role"), archetype: setupRoleSchema });
export type SetupChoiceCommand = z.infer<typeof setupWorkspaceCommandSchema> | z.infer<typeof setupRoleCommandSchema>;
export const setupChoicesSnapshotSchema = z.object({
  settings: z.object({ "workspace-type": z.string().optional(), "workspace-modules": z.string().optional(), "workspace-custom": z.string().optional(), "terminology-profile": z.string().optional() }),
  workspaceRevision: revision,
  roleValue: revision,
});
export type SetupChoicesSnapshot = z.infer<typeof setupChoicesSnapshotSchema>;
const roleValueSchema = z.object({ archetype: setupRoleSchema, requestId: z.string().uuid().optional() });
export function parseSetupRole(value: string | null) {
  try { const result = roleValueSchema.safeParse(JSON.parse(value ?? "null")); return result.success ? result.data : null; } catch { return null; }
}
const receiptSchema = z.object({ requestId: z.string().uuid(), fingerprint: z.string() });
export function parseWorkspaceReceipt(value: string | null) {
  try { const result = receiptSchema.safeParse(JSON.parse(value ?? "null")); return result.success ? result.data : null; } catch { return null; }
}
export function setupChoiceConfirmed(snapshot: SetupChoicesSnapshot, command: SetupChoiceCommand): boolean {
  return command.kind === "workspace" ? parseWorkspaceReceipt(snapshot.workspaceRevision)?.requestId === command.requestId
    : parseSetupRole(snapshot.roleValue)?.requestId === command.requestId && parseSetupRole(snapshot.roleValue)?.archetype === command.archetype;
}
