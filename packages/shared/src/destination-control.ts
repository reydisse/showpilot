import { z } from "zod";
const id = z.string().min(1).max(64), revision = z.number().int().nonnegative();
export const destinationControlScopeSchema = z.object({ orgId: id, userId: id });
export const destinationFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200), platform: z.string().trim().min(1).max(50),
  rtmpUrl: z.string().trim().max(500).regex(/^rtmps?:\/\//i), streamKey: z.string().max(500),
});
const existing = { id, expectedRevision: revision };
export const destinationControlOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), fields: destinationFieldsSchema }),
  z.object({ kind: z.literal("update"), ...existing, fields: destinationFieldsSchema }),
  z.object({ kind: z.enum(["select", "disable", "delete"]), ...existing, expiresAt: z.number().int().positive() }),
]);
export const destinationControlCommandSchema = destinationControlScopeSchema.extend({ requestId: z.string().uuid(), operation: destinationControlOperationSchema });
export const destinationControlSnapshotSchema = destinationControlScopeSchema.extend({
  serverTime: z.number(), canManage: z.boolean(), destinations: z.array(z.object({
    id, revision, name: z.string(), platform: z.string(), rtmpUrl: z.string(), hasStreamKey: z.boolean(), selected: z.boolean(),
    status: z.enum(["none", "enabled", "disabled", "missing", "unconfirmed", "unknown"]),
    error: z.string().optional(),
  })),
});
export const destinationControlResultSchema = destinationControlScopeSchema.extend({
  requestId: z.string().uuid(), outcome: z.enum(["applied", "conflict", "cancelled", "expired", "superseded", "unconfirmed"]),
  destinationId: z.string(), message: z.string().optional(),
});
export type DestinationControlScope = z.infer<typeof destinationControlScopeSchema>;
export type DestinationControlOperation = z.infer<typeof destinationControlOperationSchema>;
export type DestinationControlCommand = z.infer<typeof destinationControlCommandSchema>;
export type DestinationControlSnapshot = z.infer<typeof destinationControlSnapshotSchema>;
export type DestinationControlResult = z.infer<typeof destinationControlResultSchema>;
export type DestinationFields = z.infer<typeof destinationFieldsSchema>;
