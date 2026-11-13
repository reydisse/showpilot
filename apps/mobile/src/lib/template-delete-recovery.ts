import { z } from "zod";
const id = z.string().min(1).max(64);
export const templateDeleteCommandSchema = z
  .object({
    orgId: id,
    userId: id,
    showId: id,
    templateId: id,
    requestId: id,
  })
  .strict();
export const templateDeleteReplySchema = templateDeleteCommandSchema.extend({
  ok: z.literal(true),
});
export type TemplateDeleteCommand = z.infer<typeof templateDeleteCommandSchema>;
export type TemplateDeleteReply = z.infer<typeof templateDeleteReplySchema>;
