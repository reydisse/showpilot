import { z } from "zod";
import { MODULE_IDS, TERM_KEYS, WORKSPACE_TYPES } from "./workspace/types";
import { isWorkspaceTerm } from "./workspace/resolve";

const id = z.string().min(1).max(64);
const term = z.string().trim().refine(isWorkspaceTerm, "Use 1–24 plain-text characters");
export const workspaceCustomSchema = z.object({
  label: z.string().trim().max(80).refine(value => !/[<>\x00-\x1f\x7f]/.test(value), "Use plain text"),
  terms: z.object({ event: term.optional(), events: term.optional(), item: term.optional(), items: term.optional() }).strict().default({}),
}).strict();
export const workspaceOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("type"), type: z.enum(WORKSPACE_TYPES), resetModules: z.boolean() }).strict(),
  z.object({ kind: z.literal("module"), module: z.enum(MODULE_IDS), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal("custom"), custom: workspaceCustomSchema }).strict(),
]);
export const workspaceScopeSchema = z.object({ orgId: id, userId: id }).strict();
export const workspaceChangeSchema = workspaceScopeSchema.extend({
  requestId: z.uuid(),
  expectedRevision: z.string().min(1).max(64).nullable(),
  operation: workspaceOperationSchema,
}).strict();
export const workspaceSnapshotSchema = workspaceScopeSchema.extend({
  revision: z.string().nullable(),
  profile: z.object({
    type: z.enum(WORKSPACE_TYPES), label: z.string().nullable(),
    modules: z.array(z.enum(MODULE_IDS)),
    terms: z.record(z.enum(TERM_KEYS), z.string()), isExplicit: z.boolean(),
  }),
});
export const workspaceChangeResultSchema = workspaceScopeSchema.extend({
  requestId: z.uuid(),
  outcome: z.enum(["applied", "conflict", "cancelled", "superseded"]),
  snapshot: workspaceSnapshotSchema,
});
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type WorkspaceChangeResult = z.infer<typeof workspaceChangeResultSchema>;
export function workspaceChangeMessage(result: WorkspaceChangeResult) {
  switch (result.outcome) {
    case "applied": return "Workspace saved.";
    case "conflict": return "Workspace settings changed. Your change was not applied. Review the current settings before saving again.";
    case "cancelled": return "This change was not saved. Review the current settings before saving again.";
    case "superseded": return "Your change was saved, then workspace settings changed again. Review the current settings.";
  }
}
