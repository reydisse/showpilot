import { z } from "zod";
import { idSchema } from "./validation";
export const TM_LAYOUT_WIDGET_IDS = ["prep", "faults", "all-clear"] as const;
export const TM_LAYOUT_SECTION_IDS = [
  "overview",
  "signal-path",
  "workspace",
  "operations",
] as const;
export const tmLayoutSchema = z.object({
  version: z.literal(1),
  sections: z.array(z.enum(TM_LAYOUT_SECTION_IDS)).max(4),
  main: z.array(z.enum(TM_LAYOUT_WIDGET_IDS)).max(3),
});
export type TmDashboardLayout = z.infer<typeof tmLayoutSchema>;
export function completeTmLayout(layout: TmDashboardLayout): TmDashboardLayout {
  return {
    version: 1,
    sections: [...new Set([...layout.sections, ...TM_LAYOUT_SECTION_IDS])],
    main: [...new Set([...layout.main, ...TM_LAYOUT_WIDGET_IDS])],
  };
}
export const defaultTmLayout = (): TmDashboardLayout => ({
  version: 1,
  sections: [...TM_LAYOUT_SECTION_IDS],
  main: [...TM_LAYOUT_WIDGET_IDS],
});
export const tmManagementScopeSchema = z.object({
  orgId: idSchema,
  userId: idSchema,
});
export type TmManagementScope = z.infer<typeof tmManagementScopeSchema>;
const revision = z.number().int().nonnegative();
export const tmManagementCommandSchema = tmManagementScopeSchema.extend({
  requestId: z.uuid(),
  expiresAt: z.number().int(),
  operation: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("layout"),
      expectedRevision: revision,
      layout: tmLayoutSchema,
    }),
    z.object({
      kind: z.literal("assign"),
      id: idSchema,
      expectedRevision: revision,
      assignedTo: idSchema.nullable(),
    }),
    z.object({
      kind: z.literal("acknowledge"),
      id: idSchema,
      expectedRevision: revision,
    }),
    z.object({
      kind: z.literal("resolve"),
      id: idSchema,
      expectedRevision: revision,
    }),
  ]),
});
export type TmManagementCommand = z.infer<typeof tmManagementCommandSchema>;
export const tmManagementStateSchema = tmManagementScopeSchema.extend({
  serverTime: z.number(),
  layout: tmLayoutSchema,
  layoutRevision: revision,
  layoutUnknown: z.boolean(),
  canManageIncidents: z.boolean(),
  canAssignPeople: z.boolean(),
  pendingNotifications: revision,
});
export type TmManagementState = z.infer<typeof tmManagementStateSchema>;
export const tmManagementResultSchema = z.object({
  requestId: z.uuid(),
  outcome: z.enum(["applied", "conflict", "cancelled", "expired"]),
  notification: z.enum(["none", "pending", "delivered", "skipped"]),
  snapshot: tmManagementStateSchema,
});
export type TmManagementResult = z.infer<typeof tmManagementResultSchema>;
