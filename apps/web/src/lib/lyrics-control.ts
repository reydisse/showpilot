import { lyricsReviewState, type LyricsOperation } from "@showpilot/shared";
import { z } from "zod";
import type { LyricsDisplayState } from "@/types/timecode";

export const lyricsOperationSchema = z.enum(["next", "previous", "clear"]);
export const lyricsReviewSchema = z.object({
  songId: z.string(), sectionId: z.string(), updatedAt: z.number(),
  revision: z.string().nullable(), generationKey: z.string().nullable(),
}).strict();
export const lyricsControlSchema = z.object({ operation: lyricsOperationSchema, expected: lyricsReviewSchema,
  requestId: z.uuid().optional(), showId: z.string().min(1).optional(), serviceDate: z.string().min(1).optional(),
}).strict();

export async function requestLyricsControl(args: {
  orgId: string; showId: string; operation: LyricsOperation; lyrics: LyricsDisplayState; signal: AbortSignal;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/timecode/${encodeURIComponent(args.orgId)}/command?showId=${encodeURIComponent(args.showId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.any([args.signal, AbortSignal.timeout(10_000)]),
      body: JSON.stringify({ action: "control-lyrics", payload: { operation: args.operation, expected: lyricsReviewState(args.lyrics) } }),
    });
  } catch {
    throw new Error("Lyrics change was not confirmed. Check the display and connection before retrying.");
  }
  const result = z.object({ ok: z.boolean().optional(), error: z.string().optional() }).safeParse(await response.json().catch(() => null));
  if (!response.ok || !result.success || result.data.ok !== true) throw new Error(result.success && result.data.error
    ? result.data.error : "Lyrics change was not confirmed. Check the display before trying again.");
}
