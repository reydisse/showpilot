import { z } from "zod";

export const cueSheetEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("note"), showId: z.string(), serviceDate: z.string(), itemId: z.string(), columnId: z.string(), text: z.string(), by: z.string(), at: z.number() }),
  z.object({ type: z.literal("columns"), at: z.number() }),
  z.object({ type: z.literal("incident"), showId: z.string().nullable(), incidentId: z.string(), action: z.enum(["created", "updated", "assigned", "acknowledged", "resolved", "deleted", "commented"]), at: z.number() }),
]);
export type CueSheetEvent = z.infer<typeof cueSheetEventSchema>;
export type CueNoteEvent = Extract<CueSheetEvent, { type: "note" }>;
export type IncidentEvent = Extract<CueSheetEvent, { type: "incident" }>;
