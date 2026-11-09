import { z } from "zod";
import { DEPARTMENT_ORDER } from "./departments";
import { idSchema, labelSchema, serviceDateSchema } from "./validation";
import { normalizeChecklistLabel } from "./smart-checklist-rules";

const entry = { id: idSchema, expectedRevision: z.number().int().min(0), expectedCategory: z.string().max(100) };
export const checklistOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), label: labelSchema.trim().refine(value => !!normalizeChecklistLabel(value), "Include letters or numbers"), category: z.enum(DEPARTMENT_ORDER) }),
  z.object({ kind: z.literal("draft"), suggestionIds: z.array(z.string().min(1).max(100)).min(1).max(30) }),
  z.object({ kind: z.literal("toggle"), ...entry, checked: z.boolean() }),
  z.object({ kind: z.literal("category"), ...entry, category: z.enum(DEPARTMENT_ORDER) }),
  z.object({ kind: z.literal("delete"), ...entry }),
]);
export const checklistWriteSchema = z.object({
  orgId: idSchema, showId: idSchema, serviceDate: serviceDateSchema, requestId: z.uuid(), operation: checklistOperationSchema,
});
export type ChecklistOperation = z.infer<typeof checklistOperationSchema>;
export type ChecklistWrite = z.infer<typeof checklistWriteSchema>;
export type ChecklistWriteResult = { requestId: string; outcome: "applied" | "conflict" };
