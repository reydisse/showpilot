import { z } from "zod";
import { type TimecodeFormat } from "@showpilot/shared";
import { cueCreateReplySchema, prepareCueCreation, type TimecodeCueDraft } from "./timecode-cue-recovery";
import type { MobileTimecodeEvent } from "./timecode-contract";
export const cueEditReviewSchema = z.object({ revision: z.string().nullable(), executionId: z.string().nullable(), fired: z.boolean(), skipped: z.boolean() });
export type CueEditReview = z.infer<typeof cueEditReviewSchema>;
export const cueEditReplySchema = cueCreateReplySchema;
export type CueEditReply = z.infer<typeof cueEditReplySchema>;
export type CueEditCommand = { orgId: string; userId: string; showId: string; serviceDate: string; requestId: string;
  id: string; expected: CueEditReview; expectedFormat: TimecodeFormat;
  updates: { label: string; triggerTimecode: { hours: number; minutes: number; seconds: number; frames: number }; toleranceFrames: number; leadMs: number; payload?: Record<string, unknown> } };
export type CueEditDraft = { id: string; expected: CueEditReview; definition: TimecodeCueDraft; changeDetails: boolean };
export function reviewCueEdit(event: MobileTimecodeEvent): CueEditReview {
  return { revision: event.editRevision ?? null, executionId: event.executionId ?? null, fired: event.fired, skipped: event.skipped };
}
export function cueEditChanged(draft: CueEditDraft, event: MobileTimecodeEvent | undefined, format: TimecodeFormat | undefined): boolean {
  if (!event || !format || event.executionStatus === "dispatching") return true;
  const current = reviewCueEdit(event);
  return Object.keys(current).some(key => Reflect.get(current, key) !== Reflect.get(draft.expected, key))
    || draft.definition.format?.frameRate !== format.frameRate || draft.definition.format?.dropFrame !== format.dropFrame;
}
export function draftCueEdit(showId: string, event: MobileTimecodeEvent, format: TimecodeFormat): CueEditDraft {
  const tc = event.triggerTimecode;
  return { id: event.id, expected: reviewCueEdit(event), changeDetails: false, definition: {
    showId, label: event.label, action: event.action, format,
    timecode: [tc.hours, tc.minutes, tc.seconds].map(value => String(value).padStart(2, "0")).join(":") + (format.dropFrame === "df" ? ";" : ":") + String(tc.frames).padStart(2, "0"),
    tolerance: String(event.toleranceFrames ?? 5), lead: String(event.leadMs ?? 0),
    payload: JSON.stringify({ ...event.payload, ...(event.targetDeviceId ? { deviceId: event.targetDeviceId } : {}), ...(event.targetActionId ? { actionId: event.targetActionId } : {}) }),
  } };
}
export function prepareCueEdit(scope: Pick<CueEditCommand, "orgId" | "userId" | "showId" | "serviceDate" | "requestId">, draft: CueEditDraft): CueEditCommand {
  const command = prepareCueCreation(scope, draft.definition, draft.changeDetails);
  const { label, triggerTimecode, toleranceFrames, leadMs, payload } = command.event;
  return { ...scope, id: draft.id, expected: draft.expected, expectedFormat: command.expectedFormat,
    updates: { label, triggerTimecode, toleranceFrames, leadMs, ...(draft.changeDetails ? { payload } : {}) } };
}
