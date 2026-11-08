import { z } from "zod";
const idSchema = z.string().min(1, "ID is required").max(64);
export const reminderTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assignment"), id: idSchema }).strict(),
  z.object({ kind: z.literal("show"), id: idSchema }).strict(),
]);
export type ReminderTarget = z.infer<typeof reminderTargetSchema>;
export const scheduleReminderCommandSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    requestId: z.uuid(),
    target: reminderTargetSchema,
  })
  .strict();
export type ScheduleReminderCommand = z.infer<
  typeof scheduleReminderCommandSchema
>;
export const scheduleReminderResultSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    requestId: z.uuid(),
    items: z.array(
      z
        .object({
          id: idSchema,
          label: z.string(),
          email: z.enum([
            "accepted",
            "failed",
            "uncertain",
            "sending",
            "expired",
            "changed",
            "unavailable",
          ]),
          inAppDelivered: z.boolean(),
          reason: z.string().nullable(),
          updatedAt: z.number(),
        })
        .strict(),
    ),
  })
  .strict();
export type ScheduleReminderResult = z.infer<
  typeof scheduleReminderResultSchema
>;
export function reminderMessage(item: ScheduleReminderResult["items"][number]) {
  const app = item.inAppDelivered ? " App invitation available." : "";
  switch (item.email) {
    case "accepted":
      return "Email accepted by the delivery service." + app;
    case "failed":
      return "Email was rejected. Retry the same reminder." + app;
    case "uncertain":
      return (
        "Email acceptance is unknown. Retry checks the same reminder." + app
      );
    case "sending":
      return (
        "A reminder is still being checked. Retry its status shortly." + app
      );
    case "expired":
      return (
        "The safe retry window ended. Review before sending another reminder." +
        app
      );
    case "changed":
      return (
        "The assignment changed or closed. Refresh and review it before sending another reminder." +
        app
      );
    case "unavailable":
      return (
        "The invitation could not be prepared. Check the crew email and assignment, then retry." +
        app
      );
  }
}
