import { z } from "zod";
import { WORKSPACE_TYPES, MODULE_IDS, isWorkspaceTerm } from "@showpilot/shared";

export const WORKSPACE_REVISION_KEY = "workspace-profile-revision";

const term = z
  .string()
  .trim()
  .refine(isWorkspaceTerm, "Use 1–24 plain-text characters");
export const workspaceCustomSchema = z
  .object({
    label: z
      .string()
      .trim()
      .max(80)
      .refine((value) => !/[<>\x00-\x1f\x7f]/.test(value), "Use plain text"),
    terms: z
      .object({
        event: term.optional(),
        events: term.optional(),
        item: term.optional(),
        items: term.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export const workspaceTypeSchema = z.enum(WORKSPACE_TYPES);
export const workspaceModulesSchema = z.array(z.enum(MODULE_IDS));
export const workspaceCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initial"),
    type: workspaceTypeSchema,
    custom: workspaceCustomSchema.optional(),
    modules: workspaceModulesSchema.optional(),
    onlyIfUnconfigured: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("type"),
    type: workspaceTypeSchema,
    resetModules: z.boolean(),
  }),
  z.object({ kind: z.literal("modules"), modules: workspaceModulesSchema }),
  z.object({ kind: z.literal("custom"), custom: workspaceCustomSchema }),
  z.object({
    kind: z.literal("legacy"),
    terminologyProfile: z.enum(["general", "church"]).optional(),
  }),
]);
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
