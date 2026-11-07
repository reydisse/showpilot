import { z } from "zod";
import { idSchema } from "./validation";

export const organizationDeletionSchema = z.object({
  orgId: idSchema,
  confirmName: z.string().min(1).max(200),
}).strict();
export type OrganizationDeletion = z.infer<typeof organizationDeletionSchema>;
export const organizationDeletionResultSchema = z.object({ alreadyDeleted: z.boolean() }).strict();
