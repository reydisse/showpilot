import { z } from "zod";
import { idSchema, serviceDateSchema } from "./validation";

const time = z.union([
  z.literal(""),
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
]);
const instant = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Refresh the show before editing it",
  );
export const showDetailsInputSchema = z.object({
  orgId: idSchema,
  showId: idSchema,
  serviceDate: serviceDateSchema,
  requestId: idSchema.optional(),
  userId: idSchema.optional(),
  name: z.string().trim().max(120),
  startTime: time,
  callTime: time.default(""),
  location: z.string().trim().max(240),
  expectedUpdatedAt: instant,
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
});
export const showDetailsCommandSchema = showDetailsInputSchema.extend({
  requestId: idSchema,
  userId: idSchema,
});
export type ShowDetailsInput = z.infer<typeof showDetailsInputSchema>;
export type ShowDetailsCommand = z.infer<typeof showDetailsCommandSchema>;
export const showDetailsSnapshotSchema = z.object({
  id: idSchema,
  serviceDate: serviceDateSchema,
  name: z.string(),
  location: z.string(),
  scheduledStartTime: instant.nullable(),
  scheduledCallTime: instant.nullable(),
  updatedAt: instant,
});
export type ShowDetailsSnapshot = z.infer<typeof showDetailsSnapshotSchema>;
export const showDetailsResultSchema = z.object({
  requestId: idSchema,
  showId: idSchema,
  outcome: z.enum([
    "applied",
    "superseded",
    "conflict",
    "cancelled",
    "removed",
  ]),
  snapshot: showDetailsSnapshotSchema.nullable(),
});
export type ShowDetailsResult = z.infer<typeof showDetailsResultSchema>;
export function showDetailsFingerprint(command: ShowDetailsCommand) {
  return JSON.stringify([
    command.showId,
    command.serviceDate,
    command.expectedUpdatedAt,
    command.name,
    command.startTime,
    command.callTime,
    command.location,
    command.timeZone ?? "",
  ]);
}
export function showDetailsMetadata(
  snapshot: Omit<ShowDetailsSnapshot, "id" | "updatedAt">,
) {
  return JSON.stringify([
    snapshot.serviceDate,
    snapshot.name,
    snapshot.scheduledStartTime,
    snapshot.scheduledCallTime,
    snapshot.location,
  ]);
}

export const showDetailsRelayRequestSchema = z.object({
  command: showDetailsCommandSchema,
  sessionId: idSchema,
  mode: z.enum(["save", "review"]),
});
