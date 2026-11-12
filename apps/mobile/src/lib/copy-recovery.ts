import { z } from "zod";
const idSchema = z.string().min(1).max(64);
const serviceDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
import { scheduleReminderResultSchema } from "./reminder-recovery";

export const copyTeamSelectionSchema = z
  .object({
    showId: idSchema,
    serviceDate: serviceDateSchema,
    copyFromShowId: idSchema,
    copyFrom: serviceDateSchema,
  })
  .strict();
export const copyTeamCommandSchema = copyTeamSelectionSchema
  .extend({
    orgId: idSchema,
    userId: idSchema,
    requestId: z.uuid(),
  })
  .refine(
    (value) => value.showId !== value.copyFromShowId,
    "Choose a different source show.",
  );
export type CopyTeamSelection = z.infer<typeof copyTeamSelectionSchema>;
export type CopyTeamCommand = z.infer<typeof copyTeamCommandSchema>;
export const copyTeamResultSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    requestId: z.uuid(),
    copied: z.number().int().nonnegative(),
    reason: z
      .enum([
        "show-missing",
        "live-show",
        "target-not-empty",
        "source-empty",
        "crew-changed",
      ])
      .nullable(),
    items: z.array(
      z
        .object({
          id: idSchema,
          label: z.string(),
          changed: z.boolean(),
          invitation:
            scheduleReminderResultSchema.shape.items.element.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type CopyTeamResult = z.infer<typeof copyTeamResultSchema>;
export function copyTeamBlockedMessage(
  reason: NonNullable<CopyTeamResult["reason"]>,
) {
  return {
    "show-missing":
      "The source or destination show changed. Refresh and review the selection.",
    "live-show":
      "This show is live or paused. Copying its team is unavailable.",
    "target-not-empty":
      "This show already has positions. Its crew list was kept.",
    "source-empty": "The source show has no positions to copy.",
    "crew-changed":
      "A source crew contact is no longer available. Review the source roster.",
  }[reason];
}
