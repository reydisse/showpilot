import { z } from "zod";
const scope = z.object({
  orgId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  showId: z.string().min(1).max(64),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestId: z.string().min(1).max(64),
  expectedRevision: z.number().int().nonnegative(),
});
export const rundownItemFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    type: z.enum([
      "segment",
      "song",
      "header",
      "prayer",
      "announcement",
      "offering",
      "custom",
    ]),
    duration: z.number().int().min(0).max(604800000),
    notes: z.string().max(20000),
    assignee: z.string().max(500),
    cue: z.string().max(2000),
    hardStop: z.boolean(),
  })
  .strict();
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
  scope
    .extend({
      action: z.literal("add-item"),
      itemId: z.string().min(1).max(128),
      fields: rundownItemFieldsSchema,
    })
    .strict(),
  scope
    .extend({
      action: z.literal("update-item"),
      itemId: z.string().min(1).max(128),
      fields: rundownItemFieldsSchema,
    })
    .strict(),
  scope
    .extend({
      action: z.literal("reorder"),
      order: z.array(z.string().min(1).max(128)).min(1).max(10000),
    })
    .strict(),
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
