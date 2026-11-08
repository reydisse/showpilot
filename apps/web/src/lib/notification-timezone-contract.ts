import { z } from "zod";
import { idSchema } from "./validation";

const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const notificationTimeZoneCommandSchema = z
  .object({
    orgId: idSchema,
    requestId: z.string().uuid(),
    expectedRevision: revision,
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone"),
  })
  .strict();
export type NotificationTimeZoneCommand = z.infer<
  typeof notificationTimeZoneCommandSchema
>;
export const notificationTimeZoneStateSchema = z.object({
  timeZone: z.string().nullable(),
  revision,
});
export const notificationTimeZoneResultSchema = z.object({
  requestId: z.string().uuid(),
  outcome: z.enum(["applied", "conflict", "superseded"]),
  state: notificationTimeZoneStateSchema,
});
