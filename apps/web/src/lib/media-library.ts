import { z } from "zod";

// Below the 100 MB request limit, including headers. Playback still needs a
// codec supported by the output computer; container validation is not decoding.
export const MAX_MEDIA_BYTES = 95 * 1024 * 1024;
export const MEDIA_UPLOAD_TIMEOUT_MS = 180_000;
export const mediaMimeSchema = z.enum([
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
]);
// Opaque browser IDs also work on HTTP venue/LAN origins without randomUUID.
export const mediaIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const mediaAssetSchema = z.object({
  id: mediaIdSchema,
  name: z.string().min(1).max(180),
  mimeType: mediaMimeSchema,
  size: z.number().int().positive().max(MAX_MEDIA_BYTES),
  uploadedAt: z.iso.datetime(),
  etag: z.string().min(1).max(256),
});
export const mediaPageSchema = z.object({
  assets: z.array(mediaAssetSchema),
  cursor: z.string().nullable(),
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaPage = z.infer<typeof mediaPageSchema>;
export type MediaMime = z.infer<typeof mediaMimeSchema>;

export function mediaLibraryUrl(orgId: string, id?: string): string {
  return `/api/media/${encodeURIComponent(orgId)}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

export function safeMediaName(name: string): string {
  return (
    name
      .replace(/[\\/\u0000-\u001f\u007f]/g, "-")
      .trim()
      .slice(0, 180) || "Media"
  );
}

/** Reject HTML and unrelated files before they can be served inline. */
export function mediaHeaderMatches(
  bytes: Uint8Array,
  mime: MediaMime,
): boolean {
  const word = (offset: number, value: string) =>
    [...value].every(
      (char, index) => bytes[offset + index] === char.charCodeAt(0),
    );
  switch (mime) {
    case "video/mp4":
    case "audio/mp4":
      return word(4, "ftyp");
    case "video/webm":
    case "audio/webm":
      return (
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      );
    case "audio/ogg":
      return word(0, "OggS");
    case "audio/wav":
      return word(0, "RIFF") && word(8, "WAVE");
    case "audio/mpeg":
      return (
        word(0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      );
  }
}

export type MediaByteRange = { offset: number; length: number };
/** Single ranges cover browser seeking. Multi-range requests are rejected. */
export function parseMediaRange(
  value: string,
  size: number,
): MediaByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    offset >= size ||
    end < offset
  )
    return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}
