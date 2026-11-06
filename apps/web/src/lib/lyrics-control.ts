import { z } from "zod";
import type { LyricsDisplayState } from "@/types/timecode";

export const lyricsOperationSchema = z.enum(["next", "previous", "clear"]);
export type LyricsOperation = z.infer<typeof lyricsOperationSchema>;
export const lyricsReviewSchema = z.object({
  songId: z.string(), sectionId: z.string(), updatedAt: z.number(),
  revision: z.string().nullable(), generationKey: z.string().nullable(),
}).strict();
export const lyricsControlSchema = z.object({ operation: lyricsOperationSchema, expected: lyricsReviewSchema }).strict();

export function lyricsReviewState(lyrics: LyricsDisplayState) {
  return { songId: lyrics.songId, sectionId: lyrics.sectionId, updatedAt: lyrics.updatedAt,
    revision: lyrics.revision ?? null, generationKey: lyrics.generationKey ?? null };
}
export function lyricsReviewMatches(lyrics: LyricsDisplayState | null, expected: z.infer<typeof lyricsReviewSchema>): boolean {
  if (!lyrics) return false;
  const current = lyricsReviewState(lyrics);
  return current.songId === expected.songId && current.sectionId === expected.sectionId
    && current.updatedAt === expected.updatedAt && current.revision === expected.revision
    && current.generationKey === expected.generationKey;
}

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
