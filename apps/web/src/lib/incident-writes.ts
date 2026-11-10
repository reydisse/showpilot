import { z } from "zod";
import { isEmojiReaction, QUICK_REACTION_EMOJIS } from "@showpilot/shared";
import { idSchema, serviceDateSchema } from "./validation";
import { objectionableContentReason } from "./user-content-safety";

export const INCIDENT_CATEGORIES = ["Audio", "Video", "Lighting", "Network", "Power", "Software", "Hardware", "Other"] as const;
export const REACTION_EMOJIS = QUICK_REACTION_EMOJIS;
export const incidentCategorySchema = z.enum(INCIDENT_CATEGORIES);
export const incidentSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export const incidentWriteSchema = z.object({
  orgId: idSchema, showId: idSchema.nullable(), serviceDate: serviceDateSchema, requestId: z.uuid(),
  operation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("report"), category: incidentCategorySchema, severity: incidentSeveritySchema, description: z.string().trim().min(1).max(10_000), reportedBy: z.string().trim().max(200) }),
    z.object({ kind: z.literal("delete"), id: idSchema, snapshot: z.string().min(1).max(100_000) }),
    z.object({ kind: z.literal("comment"), incidentId: idSchema, parentId: idSchema.nullable(), body: z.string().trim().min(1).max(2000).superRefine((body, ctx) => { const message = objectionableContentReason(body); if (message) ctx.addIssue({ code: "custom", message }); }) }),
    z.object({ kind: z.literal("reaction"), commentId: idSchema, emoji: z.string().refine(isEmojiReaction, "Choose an emoji"), active: z.boolean(), expectedId: idSchema.nullable() }),
  ]),
}).refine(input => input.operation.kind !== "report" || input.showId !== null, {
  message: "Choose a show before reporting an incident.", path: ["showId"],
});
export type IncidentWrite = z.infer<typeof incidentWriteSchema>;
export type IncidentOperation = IncidentWrite["operation"];
export type IncidentWriteResult = { requestId: string; outcome: "applied" | "conflict" };
export const incidentRowSchema = z.object({ id:z.string(), category:z.string(), severity:z.string(), description:z.string(), reportedBy:z.string(), timestamp:z.string(), status:z.string(), assignedTo:z.string().nullable(), assignedName:z.string(), acknowledgedAt:z.string().nullable(), deleteSnapshot:z.string() });
export const incidentCommentSchema = z.object({ id:z.string(), incidentId:z.string(), userId:z.string(), authorName:z.string(), body:z.string(), parentId:z.string().nullable(), createdAt:z.string() });
export const incidentReactionSchema = z.object({ id:z.string(), targetId:z.string(), userId:z.string(), authorName:z.string(), emoji:z.string(), createdAt:z.string() });
export type IncidentRow = z.infer<typeof incidentRowSchema>;
export type IncidentComment = z.infer<typeof incidentCommentSchema>;
export type ContentReaction = z.infer<typeof incidentReactionSchema>;
