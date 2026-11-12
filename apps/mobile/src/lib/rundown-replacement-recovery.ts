import { z } from "zod";
import {
  templateItemCopySchema,
  fitsMobileBody,
  templateSizeError,
} from "./template-save-recovery";
const id = z.string().min(1).max(64);
export const replacementSourceSchema = z.object({
  kind: z.enum(["template", "show"]),
  id,
});
export const replacementReadSchema = z.object({
  orgId: id,
  userId: id,
  showId: id,
  source: replacementSourceSchema,
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedUpdatedAt: z.iso.datetime(),
  expectedRevision: z.number().int().nonnegative(),
  copy: z
    .object({
      serviceName: z.string().max(120),
      scheduledStartTime: z.iso.datetime().nullable(),
      location: z.string().max(240),
      items: z
        .array(templateItemCopySchema)
        .max(500)
        .refine(
          (items) =>
            new Set(items.map((item) => item.id)).size === items.length,
          "Rundown items must have distinct IDs.",
        ),
    })
    .strict(),
  timeZone: z.string().min(1),
  label: z.string(),
  targetName: z.string(),
  canReplace: z.boolean(),
});
export const replacementCommandSchema = replacementReadSchema
  .omit({ label: true, targetName: true, canReplace: true, timeZone: true })
  .extend({ requestId: z.uuid() })
  .strict()
  .refine(fitsMobileBody, templateSizeError);
export const replacementReplySchema = z.object({
  orgId: id,
  userId: id,
  showId: id,
  requestId: z.uuid(),
  outcome: z.enum([
    "applied",
    "superseded",
    "cancelled",
    "conflict",
    "removed",
  ]),
  revision: z.number().int().nonnegative().nullable(),
});
export type ReplacementSource = z.infer<typeof replacementSourceSchema>;
export type ReplacementRead = z.infer<typeof replacementReadSchema>;
export type ReplacementCommand = z.infer<typeof replacementCommandSchema>;
export type ReplacementReply = z.infer<typeof replacementReplySchema>;
export type ReplacementDraft = {
  showId: string;
  source: ReplacementSource;
  base: ReplacementRead | null;
};
