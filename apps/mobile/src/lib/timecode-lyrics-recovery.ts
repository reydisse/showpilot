import { z } from "zod";
import type { LyricsOperation, TimecodeLyricsControl } from "@showpilot/shared";
export type MobileLyricsControl = TimecodeLyricsControl & { orgId: string; userId: string };
export const lyricsControlReplySchema = z.object({ orgId: z.string().min(1), userId: z.string().min(1), requestId: z.uuid(),
  showId: z.string().min(1), serviceDate: z.string().min(1), outcome: z.enum(["applied", "conflict", "rejected"]), message: z.string().optional() });
export type MobileLyricsReply = z.infer<typeof lyricsControlReplySchema>;
export type MobileLyricsReview = { command: MobileLyricsControl; songTitle: string; sectionLabel: string };
export const lyricsControlLabels: Record<LyricsOperation, string> = { next: "Next lyrics section", previous: "Previous lyrics section", clear: "Clear lyrics" };
