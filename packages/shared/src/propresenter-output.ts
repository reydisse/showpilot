import { z } from "zod";

export const proPresenterOutputScopeSchema = z
  .object({
    orgId: z.string().min(1).max(100),
    userId: z.string().min(1).max(100),
  })
  .strict();
export const proPresenterOutputSnapshotSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.uuid().nullable(),
    serverTime: z.number().int().nonnegative(),
  })
  .strict();
export const proPresenterOutputCommandSchema = proPresenterOutputScopeSchema
  .extend({
    requestId: z.uuid(),
    enabled: z.boolean(),
    expectedRevision: z.uuid().nullable(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export const proPresenterOutputResultSchema = proPresenterOutputCommandSchema
  .extend({
    outcome: z.enum(["applied", "conflict", "expired", "superseded"]),
    snapshot: proPresenterOutputSnapshotSchema,
  })
  .strict();
export type ProPresenterOutputCommand = z.infer<
  typeof proPresenterOutputCommandSchema
>;
export type ProPresenterOutputSnapshot = z.infer<
  typeof proPresenterOutputSnapshotSchema
>;
export type ProPresenterOutputResult = z.infer<
  typeof proPresenterOutputResultSchema
>;
