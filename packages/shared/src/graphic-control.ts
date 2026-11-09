import { z } from "zod";

const id = z.string().min(1).max(64);
const revision = z.number().int().nonnegative();
export const graphicControlScopeSchema = z.object({ orgId: id, userId: id });
export const graphicTextSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().max(500),
});
const existing = { id, expectedGraphicRevision: revision, expectedProgramRevision: revision };
export const graphicControlOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), content: graphicTextSchema }),
  z.object({ kind: z.literal("update"), ...existing, content: graphicTextSchema }),
  z.object({ kind: z.literal("delete"), ...existing }),
  z.object({ kind: z.literal("show"), ...existing, expiresAt: z.number().int().positive() }),
  z.object({ kind: z.literal("hide"), ...existing, expiresAt: z.number().int().positive() }),
  z.object({ kind: z.literal("clear"), expectedProgramRevision: revision, expiresAt: z.number().int().positive() }),
]);
export const graphicControlCommandSchema = graphicControlScopeSchema.extend({
  requestId: z.string().uuid(), operation: graphicControlOperationSchema,
});
export const graphicControlSnapshotSchema = graphicControlScopeSchema.extend({
  serverTime: z.number(), programRevision: revision,
  cloudEnabled: z.boolean(), canConfigure: z.boolean(), canTrigger: z.boolean(),
  activeIds: z.array(id), unknownProgram: z.boolean(),
  templates: z.array(z.object({ id, revision, name: z.string(), title: z.string(), subtitle: z.string() })),
});
export const graphicControlResultSchema = graphicControlScopeSchema.extend({
  requestId: z.string().uuid(), outcome: z.enum(["applied", "conflict", "cancelled", "expired"]),
  snapshot: graphicControlSnapshotSchema,
});
export type GraphicControlScope = z.infer<typeof graphicControlScopeSchema>;
export type GraphicControlOperation = z.infer<typeof graphicControlOperationSchema>;
export type GraphicControlCommand = z.infer<typeof graphicControlCommandSchema>;
export type GraphicControlSnapshot = z.infer<typeof graphicControlSnapshotSchema>;
export type GraphicControlResult = z.infer<typeof graphicControlResultSchema>;
export type GraphicText = z.infer<typeof graphicTextSchema>;
