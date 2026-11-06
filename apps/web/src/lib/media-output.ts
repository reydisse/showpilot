import { z } from "zod";
import { mediaAssetSchema, mediaIdSchema } from "./media-library";

export const MEDIA_OUTPUT_LEASE_MS = 15_000;
export const MEDIA_OUTPUT_PING_MS = 4_000;
export const mediaOutputNameSchema = z
  .string()
  .trim()
  .min(1, "Name the media output.")
  .max(80)
  .regex(/^[^\u0000-\u001f\u007f]+$/)
  .transform((value) => value.normalize("NFC"));
export const mediaPlaySchema = z
  .object({
    output: mediaOutputNameSchema,
    mediaId: mediaIdSchema,
    etag: mediaAssetSchema.shape.etag,
    volume: z.number().min(0).max(1).default(1),
  })
  .strict();
export const mediaStopSchema = z
  .object({ output: mediaOutputNameSchema })
  .strict();
export type MediaCue =
  | { action: "media-play"; payload: z.infer<typeof mediaPlaySchema> }
  | { action: "media-stop"; payload: z.infer<typeof mediaStopSchema> };
export const mediaOutputKey = (name: string) =>
  name.normalize("NFC").trim().toLowerCase();
const correlationId = z.string().min(1).max(200);
export const mediaResultSchema = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), state: z.enum(["playing", "stopped"]) })
    .strict(),
  z
    .object({ ok: z.literal(false), error: z.string().min(1).max(500) })
    .strict(),
]);
export type MediaResult = z.infer<typeof mediaResultSchema>;
export const mediaReferenceSchema = z
  .object({ mediaId: mediaIdSchema, etag: mediaAssetSchema.shape.etag })
  .strict();
export type MediaReference = z.infer<typeof mediaReferenceSchema>;
export const mediaOutputClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("media-arm"),
      output: mediaOutputNameSchema,
      requestId: correlationId,
    })
    .strict(),
  z.object({ type: z.literal("media-disarm") }).strict(),
  z.object({ type: z.literal("media-ping"), nonce: correlationId }).strict(),
  z
    .object({
      type: z.literal("media-result"),
      executionId: correlationId,
      requestId: correlationId,
      result: mediaResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("media-unknown"),
      executionId: correlationId,
      requestId: correlationId,
    })
    .strict(),
  z
    .object({
      type: z.literal("media-ended"),
      executionId: correlationId,
      requestId: correlationId,
      error: z.string().max(500).optional(),
    })
    .strict(),
]);
export type MediaOutputClientMessage = z.infer<
  typeof mediaOutputClientMessageSchema
>;
const playbackCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("media-play"),
      asset: mediaAssetSchema,
      volume: z.number().min(0).max(1),
    })
    .strict(),
  z.object({ action: z.literal("media-stop") }).strict(),
]);
export const mediaOutputServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("media-hello"),
    serverTime: z.number(),
    showId: z.string(),
    orgId: z.string(),
  }),
  z.object({
    type: z.literal("media-armed"),
    requestId: correlationId,
    leaseId: correlationId,
    output: mediaOutputNameSchema,
    serverTime: z.number(),
  }),
  z.object({
    type: z.literal("media-rejected"),
    error: z.string(),
    requestId: correlationId.optional(),
  }),
  z.object({ type: z.literal("media-disarmed") }),
  z.object({
    type: z.literal("media-pong"),
    nonce: correlationId,
    serverTime: z.number(),
  }),
  z.object({
    type: z.literal("media-execute"),
    executionId: correlationId,
    requestId: correlationId,
    leaseId: correlationId,
    deadline: z.number(),
    command: playbackCommandSchema,
  }),
  z.object({
    type: z.literal("media-query"),
    executionId: correlationId,
    requestId: correlationId,
  }),
  z.object({
    type: z.literal("media-cancel"),
    executionId: correlationId,
    requestId: correlationId,
  }),
  z.object({
    type: z.literal("media-plan"),
    media: z.array(mediaReferenceSchema).max(2),
  }),
]);
export type MediaOutputServerMessage = z.infer<
  typeof mediaOutputServerMessageSchema
>;
export type MediaPlaybackCommand = z.infer<typeof playbackCommandSchema>;
export interface MediaOutputSnapshot {
  name: string;
  status: "ready" | "playing" | "stopped" | "ended" | "error" | "unconfirmed";
  mediaName: string | null;
  error: string | null;
}

export function mediaOutputUrl(
  orgSlug: string,
  showId: string,
  output: string,
): string {
  return `/media/${encodeURIComponent(orgSlug)}?showId=${encodeURIComponent(showId)}&output=${encodeURIComponent(output)}`;
}
