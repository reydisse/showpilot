import { z } from "zod";
import { idSchema } from "./validation";
import { templateSaveCommandSchema } from "./template-save-contract";
import { rundownDetailsReadSchema } from "./rundown-details-contract";
export const replacementSourceSchema = z
  .object({ kind: z.enum(["template", "show"]), id: idSchema })
  .strict();
export const replacementReadSchema = rundownDetailsReadSchema
  .extend({ source: replacementSourceSchema })
  .strict();
export const replacementCopySchema = z
  .object({
    serviceName: z.string().max(120),
    scheduledStartTime: z.iso.datetime().nullable(),
    location: z.string().max(240),
    items: templateSaveCommandSchema.shape.items,
  })
  .strict();
export const replacementCommandSchema = replacementReadSchema
  .extend({
    requestId: z.uuid(),
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expectedUpdatedAt: z.iso.datetime(),
    expectedRevision: z.number().int().nonnegative(),
    copy: replacementCopySchema,
  })
  .strict();
export const replacementRelaySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("read"),
    scope: replacementReadSchema,
    sessionId: idSchema,
    pin: z.string().nullable(),
  }),
  z.object({
    mode: z.enum(["save", "review"]),
    command: replacementCommandSchema,
    sessionId: idSchema,
    pin: z.string().nullable(),
  }),
]);
export type ReplacementCommand = z.infer<typeof replacementCommandSchema>;
export type ReplacementScope = z.infer<typeof replacementReadSchema>;
export type ReplacementResult = Pick<
  ReplacementCommand,
  "orgId" | "userId" | "showId" | "requestId"
> & {
  outcome: "applied" | "superseded" | "cancelled" | "conflict" | "removed";
  revision: number | null;
};
