import { z } from "zod";
import { idSchema } from "./validation";
import { showDetailsCommandSchema } from "./show-details-contract";
import { deleteShowInputSchema } from "./show-deletion-contract";

export const mobileShowManagementSchema = z.discriminatedUnion("kind", [
  showDetailsCommandSchema.extend({ kind: z.literal("edit") }),
  deleteShowInputSchema.extend({
    kind: z.literal("delete"),
    userId: idSchema,
    requestId: idSchema,
    expectedUpdatedAt: deleteShowInputSchema.shape.expectedUpdatedAt.unwrap(),
  }),
]);
export const mobileShowReadSchema = z.object({
  orgId: idSchema,
  userId: idSchema,
  showId: idSchema,
});
