import { z } from "zod";
import { isReviewedTimecodeClockEdit, type ReviewedTimecodeClockEdit, type TimecodeClockReview } from "@showpilot/shared";
import type { MobileTimecodeState } from "./timecode-contract";

export type TimecodeClockCommand = ReviewedTimecodeClockEdit & { orgId: string; userId: string };
export const timecodeClockCommandSchema = z.object({ orgId: z.string().min(1), userId: z.string().min(1) })
  .and(z.custom<ReviewedTimecodeClockEdit>(isReviewedTimecodeClockEdit));
export const timecodeClockReplySchema = z.object({
  orgId: z.string().min(1), userId: z.string().min(1), requestId: z.uuid(), showId: z.string().min(1), serviceDate: z.string().min(1),
  outcome: z.enum(["applied", "conflict", "rejected"]), message: z.string().optional(),
});
export type TimecodeClockReply = z.infer<typeof timecodeClockReplySchema>;
export type TimecodeClockDraft = { timecode: string; review: { command: TimecodeClockCommand; from: string } | null };
export function reviewTimecodeClock(state: MobileTimecodeState): TimecodeClockReview {
  return { showId: state.showId, serviceDate: state.serviceDate, frame: state.totalFrames, format: state.format,
    incomingFormatId: state.incomingFormat?.id ?? null };
}
