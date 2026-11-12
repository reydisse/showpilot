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
export class ShowDeletionBlockedError extends Error {
  constructor() {
    super("Stop the show before deleting it");
    this.name = "ShowDeletionBlockedError";
  }
}
