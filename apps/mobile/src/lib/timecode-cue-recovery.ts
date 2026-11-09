import { structuredCuePayload } from "./timecode-cue-fields";
import { z } from "zod";
import { isValidTimecode, isValidTimecodeFormat, parseTimecodeString, type TimecodeFormat } from "@showpilot/shared";

const id = z.string().min(1).max(128);
export const cueTimecodeSchema = z.object({ hours: z.number().int().min(0).max(23), minutes: z.number().int().min(0).max(59),
  seconds: z.number().int().min(0).max(59), frames: z.number().int().min(0).max(29) });
export const cueCreateCommandSchema = z.object({
  orgId: id, userId: id, showId: id, serviceDate: z.string().min(1), requestId: z.uuid(),
  expectedFormat: z.custom<TimecodeFormat>(isValidTimecodeFormat),
  event: z.object({ label: z.string().trim().min(1).max(200), action: z.string().min(1), triggerTimecode: cueTimecodeSchema,
    payload: z.record(z.string(), z.unknown()), toleranceFrames: z.number().int().min(0).max(9000), leadMs: z.number().int().min(0).max(60000).default(0) }),
}).superRefine((command, context) => {
  if (!isValidTimecode(command.event.triggerTimecode, command.expectedFormat))
    context.addIssue({ code: "custom", path: ["event", "triggerTimecode"], message: "Enter a valid cue time for the reviewed frame rate." });
});
export const cueCreateReplySchema = z.object({
  orgId: id, userId: id, showId: id, serviceDate: z.string().min(1), requestId: z.uuid(),
  outcome: z.enum(["applied", "removed", "conflict", "rejected"]), message: z.string().optional(),
});
export type CueCreateCommand = z.infer<typeof cueCreateCommandSchema>;
export type CueCreateReply = z.infer<typeof cueCreateReplySchema>;
export type TimecodeCueDraft = {
  showId: string; label: string; timecode: string; action: string; payload: string; tolerance?: string; lead?: string; format: TimecodeFormat | null;
};
export function prepareCueCreation(scope: Omit<CueCreateCommand, "event" | "expectedFormat">, draft: TimecodeCueDraft, normalizeDetails = true): CueCreateCommand {
  if (!draft.format) throw new Error("Load the show before reviewing the cue frame rate.");
  const triggerTimecode = parseTimecodeString(draft.timecode.trim(), draft.format);
  if (!triggerTimecode) throw new Error("Enter a valid cue time for the reviewed frame rate, including drop-frame labels.");
  let payload: unknown;
  try { payload = JSON.parse(draft.payload); } catch { throw new Error("Action details must be valid JSON."); }
  if (!draft.label.trim() || draft.label.trim().length > 200) throw new Error("Enter a cue label between 1 and 200 characters.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Action details must be a JSON object.");
  return cueCreateCommandSchema.parse({ ...scope, expectedFormat: draft.format,
    event: { label: draft.label, action: draft.action, triggerTimecode, payload: normalizeDetails ? structuredCuePayload(draft.action, Object.fromEntries(Object.entries(payload))) : payload, toleranceFrames: numericCueField(draft.tolerance ?? "5", 9000, "Tolerance"), leadMs: numericCueField(draft.lead ?? "0", 60000, "Cue lead") } });
}

export function numericCueField(text: string, maximum: number, label: string): number {
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text)) || Number(text) > maximum)
    throw new Error(`${label} must be a whole number between 0 and ${maximum}.`);
  return Number(text);
}
