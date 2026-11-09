import { z } from "zod";
import { isTimecodeCueControl, type TimecodeCueControl, type TimecodeCueOperation } from "@showpilot/shared";
export type MobileCueControl = TimecodeCueControl & { orgId: string; userId: string };
export const mobileCueControlSchema = z.object({ orgId: z.string().min(1), userId: z.string().min(1) }).and(z.custom<TimecodeCueControl>(isTimecodeCueControl));
export const mobileCueControlReplySchema = z.object({ orgId: z.string().min(1), userId: z.string().min(1), requestId: z.uuid(), showId: z.string().min(1), serviceDate: z.string().min(1),
  outcome: z.enum(["applied", "conflict", "rejected"]), message: z.string().optional() });
export type MobileCueControlReply = z.infer<typeof mobileCueControlReplySchema>;
export type MobileCueControlReview = { command: MobileCueControl; label: string; detail: string };
export const cueControlLabels: Record<TimecodeCueOperation, string> = {
  enable: "Enable cue", disable: "Disable cue", remove: "Remove cue", rearm: "Re-arm cue", reset: "Re-arm all cues", fire: "Fire cue now", retry: "Retry cue", refire: "Fire cue again",
};
export const cueControlDetails: Record<TimecodeCueOperation, string> = {
  enable: "This cue can fire when the clock crosses it.", disable: "This blocks future dispatches. An output already sent cannot be recalled.",
  remove: "Remove this cue from the shared timeline. This does not undo any output it already sent.",
  rearm: "Clear this cue's execution history so it can run again when the clock crosses it. This does not fire it now.",
  reset: "Clear execution history for every cue in this show. Previously fired cues can run again. Disabled cues stay disabled. The clock must remain stopped.",
  fire: "Send this cue's output immediately, using the shared relay.",
  retry: "Check the output first: a failed acknowledgement does not prove it did not run. Retrying may repeat an external action.",
  refire: "Send this cue's output again, even though its previous delivery was confirmed.",
};
