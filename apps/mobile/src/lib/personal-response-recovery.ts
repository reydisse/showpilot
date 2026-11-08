import { z } from "zod";
const id = z.string().min(1).max(64);
export const personalResponseCommandSchema = z.object({
  orgId: id,
  userId: id,
  requestId: z.uuid(),
  assignmentId: id,
  expectedRevision: z.string().min(1).max(64),
  reviewedVersion: z.string().min(2).max(512),
  response: z.enum(["confirmed", "declined"]),
  reason: z.string().trim().max(500),
});
export const personalResponseResultSchema = z.object({
  orgId: id,
  userId: id,
  requestId: z.uuid(),
  assignmentId: id,
  outcome: z.enum([
    "applied",
    "superseded",
    "removed",
    "conflict",
    "closed",
    "unavailable",
    "cancelled",
  ]),
});
export type PersonalResponseCommand = z.infer<
  typeof personalResponseCommandSchema
>;
export type PersonalResponseResult = z.infer<
  typeof personalResponseResultSchema
>;
export type ResponseSelection = Pick<
  PersonalResponseCommand,
  "assignmentId" | "expectedRevision" | "reviewedVersion"
> & { label: string };
export type ResponseDraft = ResponseSelection & { reason: string };
export function personalResponseMessage(result: PersonalResponseResult) {
  switch (result.outcome) {
    case "applied":
      return "Your response was saved.";
    case "superseded":
      return "Your response was saved before a later change. Review the current assignment.";
    case "removed":
      return "Your response was saved, and this assignment was later removed.";
    case "conflict":
      return "The assignment changed or already has a response. Your original response was not applied.";
    case "closed":
      return "The show ended before this response could be accepted.";
    case "unavailable":
      return "This assignment is no longer available to your account.";
    case "cancelled":
      return "The original response was cancelled before it applied. You can review your note before responding again.";
  }
}
