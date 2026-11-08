import { z } from "zod";
import { idSchema } from "./validation";
const scope = {
  orgId: idSchema,
  requestId: z.string().uuid(),
  targets: z
    .array(
      z.object({ id: idSchema, version: z.string().min(1).max(128) }).strict(),
    )
    .min(1)
    .max(100)
    .refine(
      (targets) =>
        new Set(targets.map((target) => target.id)).size === targets.length,
      "Review each destination only once.",
    ),
};
export const tmStreamCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...scope,
      action: z.literal("stream-live"),
      liveInputId: idSchema,
    })
    .strict(),
  z.object({ ...scope, action: z.literal("stream-stop") }).strict(),
]);
export type TmStreamCommand = z.infer<typeof tmStreamCommandSchema>;
export const tmStreamResultSchema = z.object({
  requestId: z.string().uuid(),
  notificationError: z.string().optional(),
  results: z.array(
    z.object({
      id: idSchema,
      success: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
export const tmStreamSnapshotSchema = z.object({
  canControl: z.boolean(),
  inputs: z.array(z.object({ id: idSchema, name: z.string() })),
  destinations: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      enabled: z.boolean(),
      version: z.string(),
      status: z.enum([
        "enabled",
        "disabled",
        "missing",
        "unconfirmed",
        "unknown",
        "none",
      ]),
      error: z.string().optional(),
    }),
  ),
});
export type TmStreamSnapshot = z.infer<typeof tmStreamSnapshotSchema>;
// UI review metadata survives route changes alongside the original command.
export const tmStreamReviewSchema = z.object({
  command: tmStreamCommandSchema,
  inputName: z.string().optional(),
  names: z.record(z.string(), z.string()),
});
export type TmStreamReview = z.infer<typeof tmStreamReviewSchema>;
