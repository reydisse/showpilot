import { z } from "zod";
import { objectionableContentReason } from "./user-content-safety";

export const crewMessagePayloadSchema = z.object({
  message: z.string().trim().min(1, "Enter a crew message.").max(4000, "Crew messages are limited to 4,000 characters."),
}).strict().superRefine((value, ctx) => {
  const problem = objectionableContentReason(value.message);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

const id = z.string().trim().min(1).max(200);
export const crewMessageDeliverySchema = z.object({
  orgId: id,
  showId: id,
  eventId: id,
  executionId: z.uuid(),
  payload: crewMessagePayloadSchema,
  deadline: z.number().int().positive(),
  authority: z.object({ orgId: id, userId: id, sessionId: id }).strict(),
}).strict();
export type CrewMessageDelivery = z.infer<typeof crewMessageDeliverySchema>;
export type CrewMessageResult = { ok: true; messageId: string; duplicate: boolean } | { ok: false; error: string };
