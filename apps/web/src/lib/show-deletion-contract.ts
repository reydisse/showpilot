import { z } from "zod";
import { idSchema } from "./validation";
export const deleteShowInputSchema = z.object({
  orgId: idSchema,
  showId: idSchema,
  userId: idSchema.optional(),
  expectedUpdatedAt: z
    .string()
    .max(64)
    .refine(
      (value) => Number.isFinite(Date.parse(value)),
      "Refresh the show before deleting it",
    )
    .optional(),
});
export type DeleteShowInput = z.infer<typeof deleteShowInputSchema>;
export const deleteShowResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), message: z.string().min(1) }),
]);
export class ShowDeletionRejectedError extends Error {}
export class ShowDeletionBlockedError extends ShowDeletionRejectedError {
  constructor() {
    super("Stop the show before deleting it");
    this.name = "ShowDeletionBlockedError";
  }
}
