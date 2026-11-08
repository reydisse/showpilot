import { z } from "zod";
import { idSchema } from "./validation";
import type { ShowReportNote } from "./show-report-notes";

const noteField = z.string().trim().max(4_000).default("");
export const reportNoteWriteSchema = z.object({
  orgId: idSchema,
  showId: idSchema,
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative().nullable(),
  role: z.enum(["pm", "tm"]),
  summary: noteField,
  wins: noteField,
  issues: noteField,
  followUps: noteField,
});
export type ReportNoteWrite = z.infer<typeof reportNoteWriteSchema>;
export type ReportNoteWriteResult = {
  requestId: string;
  outcome: "applied" | "conflict";
  currentNote: ShowReportNote | null;
};
