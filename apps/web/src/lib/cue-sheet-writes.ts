import { z } from "zod";
import { idSchema, serviceDateSchema } from "./validation";

export const CUE_COLUMN_COLORS = ["slate", "amber", "green", "blue", "purple", "pink", "cyan", "red"] as const;
const label = z.string().trim().min(1).max(60);
const color = z.enum(CUE_COLUMN_COLORS);
const width = z.number().int().min(80).max(640);
const ids = z.array(idSchema).min(1).max(40).refine(values => new Set(values).size === values.length, "Duplicate columns");
export const cueSheetOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), showId: idSchema, serviceDate: serviceDateSchema, itemId: z.string().min(1).max(200), columnId: idSchema, expectedText: z.string().max(2000), text: z.string().max(2000) }),
  z.object({ kind: z.literal("add-column"), label, color }),
  z.object({ kind: z.literal("rename-column"), id: idSchema, before: z.string().max(60), label }),
  z.object({ kind: z.literal("color-column"), id: idSchema, before: z.string().max(64), color }),
  z.object({ kind: z.literal("resize-column"), id: idSchema, before: z.number().int(), width }),
  z.object({ kind: z.literal("reorder-columns"), before: ids, ids }).refine(value => value.before.length === value.ids.length && value.ids.every(id => value.before.includes(id)), "Column order must contain the same columns"),
  z.object({ kind: z.literal("delete-column"), id: idSchema, label: z.string().max(60) }),
]);
export type CueSheetOperation = z.infer<typeof cueSheetOperationSchema>;
export type CueNoteOperation = Extract<CueSheetOperation, { kind: "note" }>;
export interface CueSheetWrite { orgId: string; requestId: string; operation: CueSheetOperation }
export type CueSheetWriteResult = { requestId: string; outcome: "applied" | "conflict"; currentText: string | null };

export function describeCueSheetWrite(op: CueSheetOperation): string {
  switch (op.kind) {
    case "note": return "Save cue note";
    case "add-column": return `Add department “${op.label}”`;
    case "rename-column": return `Rename department to “${op.label}”`;
    case "color-column": return `Change department color to ${op.color}`;
    case "resize-column": return `Resize department to ${op.width}px`;
    case "reorder-columns": return "Change department order";
    case "delete-column": return `Delete department “${op.label}”`;
  }
}
