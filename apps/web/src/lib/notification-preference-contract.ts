import { NOTIFICATION_CATEGORIES } from "@showpilot/shared";
import { z } from "zod";
import { idSchema } from "./validation";

export const notificationPreferenceCommandSchema = z.object({
  orgId: idSchema,
  category: z.enum(NOTIFICATION_CATEGORIES),
  deviceAlerts: z.boolean(),
  requestId: z.string().uuid().optional(),
  expectedDeviceAlerts: z.boolean().optional(),
});
export type NotificationPreferenceCommand = z.infer<
  typeof notificationPreferenceCommandSchema
>;
export const notificationPreferenceResultSchema = z.object({
  outcome: z.enum(["applied", "conflict", "superseded"]),
  preference: z.object({
    category: z.enum(NOTIFICATION_CATEGORIES),
    deviceAlerts: z.boolean(),
  }),
});
export type NotificationPreferenceResult = z.infer<
  typeof notificationPreferenceResultSchema
>;
