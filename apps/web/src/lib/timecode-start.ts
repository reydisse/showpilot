import { z } from "zod";
import type { TimecodeFormat, TimecodeState } from "@/types/timecode";
import {
  isValidTimecode,
  isValidTimecodeFormat,
  sameTimecodeFormat,
} from "./timecode";

/** A reviewed seek and start, checked atomically against the held relay clock. */
export const timecodeStartPositionSchema = z
  .object({
    timecode: z.object({
      hours: z.number().int().min(0).max(23),
      minutes: z.number().int().min(0).max(59),
      seconds: z.number().int().min(0).max(59),
      frames: z.number().int().min(0).max(29),
    }),
    expectedShowId: z.string().min(1).max(200),
    expectedFormat: z.custom<TimecodeFormat>(isValidTimecodeFormat),
    expectedFrame: z.number().int().min(0),
    confirmed: z.literal(true),
  })
  .strict();
export type TimecodeStartPosition = z.infer<typeof timecodeStartPositionSchema>;

export function startPositionProblem(
  position: TimecodeStartPosition,
  clock: Pick<
    TimecodeState,
    | "showId"
    | "format"
    | "totalFrames"
    | "running"
    | "signal"
    | "incomingFormat"
  >,
  sourceOwned: boolean,
): string | null {
  if (clock.running || sourceOwned || clock.signal?.status === "paused")
    return "Stop the current source before choosing a new start position.";
  if (clock.incomingFormat)
    return "Confirm the input format before choosing a start position.";
  if (
    clock.showId !== position.expectedShowId ||
    !sameTimecodeFormat(clock.format, position.expectedFormat) ||
    clock.totalFrames !== position.expectedFrame
  ) {
    return "The show, format or held position changed. Review the start position again.";
  }
  if (!isValidTimecode(position.timecode, clock.format))
    return "Enter a valid start timecode for the selected frame rate.";
  return null;
}
