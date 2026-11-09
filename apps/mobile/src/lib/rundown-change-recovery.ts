import { z } from "zod";
const scope = z.object({
  orgId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  showId: z.string().min(1).max(64),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestId: z.string().min(1).max(64),
  expectedRevision: z.number().int().nonnegative(),
});
export const rundownChangeCommandSchema = z.discriminatedUnion("action", [
  scope
    .extend({
      action: z.literal("remove-item"),
      itemId: z.string().min(1).max(128),
    })
    .strict(),
  scope
    .extend({
      action: z.literal("restore-item"),
      itemId: z.string().min(1).max(128),
    })
    .strict(),
  scope.extend({ action: z.literal("clear-all") }).strict(),
  scope.extend({ action: z.literal("reset") }).strict(),
]);
export const rundownChangeReplySchema = z.object({
  orgId: z.string(),
  userId: z.string(),
  showId: z.string(),
  requestId: z.string(),
  outcome: z.enum(["applied", "conflict", "unavailable"]),
  revision: z.number().int().nonnegative().nullable(),
});
export type RundownChangeCommand = z.infer<typeof rundownChangeCommandSchema>;
export type RundownChangeReply = z.infer<typeof rundownChangeReplySchema>;
