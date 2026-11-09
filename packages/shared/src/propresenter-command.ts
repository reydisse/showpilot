import { z } from "zod";

export const proPresenterCommandSchema = z
  .object({
    orgId: z.string().min(1).max(100),
    userId: z.string().min(1).max(100),
    showId: z.string().min(1).max(100),
    requestId: z.string().uuid(),
    command: z.enum(["next", "previous", "clear"]),
  })
  .strict();
export type ProPresenterCommand = z.infer<typeof proPresenterCommandSchema>;
export const proPresenterReplySchema = proPresenterCommandSchema.extend({
  status: z.enum([
    "preparing",
    "prepared",
    "sending",
    "confirmed",
    "rejected",
    "uncertain",
  ]),
  message: z.string(),
});
export type ProPresenterReply = z.infer<typeof proPresenterReplySchema>;
