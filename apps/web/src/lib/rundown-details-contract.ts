import { z } from "zod";
import { idSchema } from "./validation";
import { showDetailsCommandSchema } from "./show-details-contract";

export const rundownDetailsCommandSchema = showDetailsCommandSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    timeZone: showDetailsCommandSchema.shape.timeZone.unwrap(),
  })
  .strict();
export type RundownDetailsCommand = z.infer<typeof rundownDetailsCommandSchema>;
export const rundownDetailsReadSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    showId: idSchema,
  })
  .strict();
export const rundownDetailsRelaySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("read"),
    scope: rundownDetailsReadSchema,
    sessionId: idSchema,
    pin: z.string().nullable(),
  }),
  z.object({
    mode: z.enum(["save", "review"]),
    command: rundownDetailsCommandSchema,
    sessionId: idSchema,
    pin: z.string().nullable(),
  }),
]);
