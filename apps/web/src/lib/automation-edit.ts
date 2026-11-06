import { z } from "zod";
import { MAX_TIMECODE_TOLERANCE_FRAMES, type AutomationEvent } from "@/types/timecode";
import { MAX_AUTOMATION_LEAD_MS } from "./automation-timing";

export const automationTimecodeSchema = z.object({
  hours: z.number().int().min(0).max(23), minutes: z.number().int().min(0).max(59),
  seconds: z.number().int().min(0).max(59), frames: z.number().int().min(0).max(29),
}).strict();

/** Definition changes never accept identity, routing type or execution history. */
export const automationEventChangesSchema = z.object({
  label: z.string().max(200).optional(),
  triggerTimecode: automationTimecodeSchema.optional(),
  toleranceFrames: z.number().int().min(0).max(MAX_TIMECODE_TOLERANCE_FRAMES).optional(),
  leadMs: z.number().int().min(0).max(MAX_AUTOMATION_LEAD_MS).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AutomationEventChanges = z.infer<typeof automationEventChangesSchema>;
export const automationEditReviewSchema = z.object({
  revision: z.string().nullable(), executionId: z.string().nullable(),
  fired: z.boolean(), skipped: z.boolean(),
}).strict();
export function automationEditReview(event: AutomationEvent): z.infer<typeof automationEditReviewSchema> {
  return { revision: event.editRevision ?? null, executionId: event.executionId ?? null,
    fired: event.fired, skipped: event.skipped === true };
}
export function automationEditReviewMatches(event: AutomationEvent, review: z.infer<typeof automationEditReviewSchema>): boolean {
  const current = automationEditReview(event);
  return current.revision === review.revision && current.executionId === review.executionId
    && current.fired === review.fired && current.skipped === review.skipped;
}
export function automationChangesMatch(event: AutomationEvent, updates: AutomationEventChanges): boolean {
  return Object.entries(updates).every(([key, value]) => JSON.stringify(Reflect.get(event, key)) === JSON.stringify(value));
}
