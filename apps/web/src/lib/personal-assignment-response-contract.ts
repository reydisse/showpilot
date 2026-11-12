import { z } from "zod";
import { idSchema } from "./validation";
export const personalResponseFieldsSchema = z.object({
  orgId: idSchema,
  assignmentId: idSchema,
  reviewedVersion: z.string().min(2).max(512),
  response: z.enum(["confirmed", "declined"]),
  reason: z.string().trim().max(500).default(""),
});
export const personalResponseCommandSchema = personalResponseFieldsSchema
  .extend({
    userId: idSchema,
    requestId: z.uuid(),
    expectedRevision: z.string().min(1).max(64),
  })
  .strict();
export type PersonalResponseCommand = z.infer<
  typeof personalResponseCommandSchema
>;
export const personalResponseResultSchema = z.object({
  orgId: idSchema,
  userId: idSchema,
  requestId: z.uuid(),
  assignmentId: idSchema,
  outcome: z.enum([
    "applied",
    "superseded",
    "removed",
    "conflict",
    "closed",
    "unavailable",
    "cancelled",
  ]),
});
export type PersonalResponseResult = z.infer<
  typeof personalResponseResultSchema
>;
