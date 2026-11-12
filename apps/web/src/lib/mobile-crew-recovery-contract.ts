import { z } from "zod";
import { idSchema } from "./validation";
import { createCrewProfileSchema } from "./crew-roster-contract";
const identity = { orgId: idSchema, userId: idSchema, requestId: z.uuid() };
const revision = z.number().int().nonnegative();
export const mobileCrewCommandSchema = z.discriminatedUnion("kind", [
  createCrewProfileSchema
    .extend({ ...identity, kind: z.literal("create") })
    .strict(),
  createCrewProfileSchema
    .extend({
      ...identity,
      kind: z.literal("update"),
      id: idSchema,
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      ...identity,
      kind: z.literal("delete"),
      id: idSchema,
      expectedRevision: revision,
    })
    .strict(),
]);
export const mobileCrewReadSchema = z
  .object({ orgId: idSchema, userId: idSchema, id: idSchema })
  .strict();
