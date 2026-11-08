import { z } from "zod";
import { idSchema, serviceDateSchema } from "./validation";

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");
export const createShowInputSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema.optional(),
    requestId: idSchema.optional(),
    serviceDate: serviceDateSchema,
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
      }, "Choose a valid timezone")
      .optional(),
    name: z.string().trim().max(120).optional(),
    location: z.string().trim().max(240).optional(),
    startTime: clock.optional(),
    callTime: clock.optional(),
    copyFrom: serviceDateSchema.optional(),
    copyFromShowId: idSchema.optional(),
    inventoryId: idSchema.optional(),
  })
  .refine(
    (value) => !value.copyFromShowId || !!value.copyFrom,
    "Choose a source show date",
  )
  .refine(
    (value) => !value.inventoryId || !value.copyFrom,
    "Choose one rundown source",
  );

export type CreateServiceForOrgInput = z.infer<typeof createShowInputSchema>;

export function showCreationFingerprint(data: CreateServiceForOrgInput) {
  return JSON.stringify([
    data.serviceDate,
    data.name ?? "",
    data.startTime ?? "",
    data.callTime ?? "",
    data.location ?? "",
    data.timeZone ?? "",
    data.inventoryId ?? "",
    data.copyFrom ?? "",
    data.copyFromShowId ?? "",
  ]);
}
export const reviewShowCreationSchema = createShowInputSchema.safeExtend({
  requestId: idSchema,
  userId: idSchema,
});
export const showCreationResultSchema = z.object({
  ok: z.literal(true),
  showId: idSchema,
  serviceDate: serviceDateSchema,
});
export const showCreationReviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), result: showCreationResultSchema }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("removed") }),
]);
export type ShowCreationResult = z.infer<typeof showCreationResultSchema>;
export type ShowCreationReview = z.infer<typeof showCreationReviewSchema>;
