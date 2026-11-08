import { z } from "zod";
import { idSchema, serviceDateSchema } from "./validation";
import { scheduleReminderResultSchema } from "./schedule-reminder-contract";

export const assignmentFieldsSchema = z
  .object({
    showId: idSchema,
    serviceDate: serviceDateSchema,
    role: z.string().trim().min(1).max(120),
    department: z.string().trim().min(1).max(80),
    crewMemberId: idSchema.nullable(),
    callTime: z.union([
      z.literal(""),
      z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    ]),
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
      }, "Choose a valid timezone."),
    notes: z.string().trim().max(500),
  })
  .strict();
const revision = z.string().min(1).max(64);
export const assignmentOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("create"), fields: assignmentFieldsSchema })
    .strict(),
  z
    .object({
      kind: z.literal("edit"),
      id: idSchema,
      expectedRevision: revision,
      fields: assignmentFieldsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      id: idSchema,
      expectedRevision: revision,
    })
    .strict(),
]);
export const scheduleAssignmentCommandSchema = z
  .object({
    orgId: idSchema,
    userId: idSchema,
    requestId: z.uuid(),
    operation: assignmentOperationSchema,
  })
  .strict();
export type ScheduleAssignmentCommand = z.infer<
  typeof scheduleAssignmentCommandSchema
>;
export const assignmentSnapshotSchema = z
  .object({
    id: idSchema,
    revision,
    showId: idSchema.nullable(),
    serviceDate: serviceDateSchema,
    role: z.string(),
    department: z.string(),
    crewMemberId: idSchema.nullable(),
    status: z.enum(["assigned", "confirmed", "declined"]),
    callTime: z.string(),
    notes: z.string(),
    responseNote: z.string(),
  })
  .strict();
export type AssignmentSnapshot = z.infer<typeof assignmentSnapshotSchema>;
export const scheduleAssignmentResultSchema = z
  .object({
    requestId: z.uuid(),
    assignmentId: idSchema,
    outcome: z.enum(["applied", "conflict", "superseded"]),
    snapshot: assignmentSnapshotSchema.nullable(),
    invitation: scheduleReminderResultSchema.shape.items.element.nullable(),
  })
  .strict();
export type ScheduleAssignmentResult = z.infer<
  typeof scheduleAssignmentResultSchema
>;
