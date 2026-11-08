import { z } from "zod";
import { personalResponseResultSchema } from "./personal-assignment-response-contract";
export const crewScheduleTokenSchema = z
  .string()
  .min(32)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const fields = z.object({
  token: crewScheduleTokenSchema,
  assignmentId: z.string().min(1).max(128),
  reviewedVersion: z.string().min(2).max(512),
  response: z.enum(["confirmed", "declined"]),
  reason: z.string().trim().max(500).default(""),
});
export const crewResponseCommandSchema = fields
  .extend({ requestId: z.uuid(), expectedRevision: z.string().min(1).max(64) })
  .strict();
export const crewResponseSubmissionSchema = z.union([
  crewResponseCommandSchema,
  fields.strict(),
]);
export const crewResponseResultSchema = personalResponseResultSchema.pick({
  requestId: true,
  assignmentId: true,
  outcome: true,
});
export type CrewResponseCommand = z.infer<typeof crewResponseCommandSchema>;
export type CrewResponseResult = z.infer<typeof crewResponseResultSchema>;
