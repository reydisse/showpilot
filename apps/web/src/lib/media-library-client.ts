import {
  MAX_MEDIA_BYTES,
  MEDIA_UPLOAD_TIMEOUT_MS,
  mediaAssetSchema,
  mediaLibraryUrl,
  mediaMimeSchema,
  mediaPageSchema,
  type MediaMime,
} from "./media-library";

export function mediaFileType(
  file: Pick<File, "type" | "name">,
): MediaMime | null {
  const supplied = file.type === "audio/x-wav" ? "audio/wav" : file.type;
  const extensions: Record<string, MediaMime> = {
    mp4: "video/mp4",
    m4a: "audio/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
  };
  const parsed = mediaMimeSchema.safeParse(
    supplied || extensions[file.name.split(".").pop()?.toLowerCase() ?? ""],
  );
  return parsed.success ? parsed.data : null;
}

export function mediaFileProblem(file: File): string | null {
  if (!mediaFileType(file)) return "Choose an MP4, WebM, MP3, WAV or Ogg file.";
  if (file.size < 12)
    return "This file is empty or incomplete. Choose another file.";
  if (file.size > MAX_MEDIA_BYTES)
    return "Media files must be 95 MB or smaller.";
  return null;
}

async function mediaFetch(
  url: string,
  options: RequestInit,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok)
      throw new Error(
        (await response.text()).slice(0, 500) ||
          `Media request failed (${response.status}).`,
      );
    return response;
  } catch (error) {
    if (timeout.aborted) throw new Error("Media request timed out. Try again.");
    if (signal.aborted)
      throw new Error(
        "Request cancelled. Refresh the library to check whether it finished.",
      );
    throw error;
  }
}

export async function loadMediaPage(
  orgId: string,
  cursor: string | null,
  signal: AbortSignal,
) {
  const url =
    mediaLibraryUrl(orgId) +
    (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
  return mediaPageSchema.parse(
    await (await mediaFetch(url, {}, signal)).json(),
  );
}

export async function uploadMedia(
  orgId: string,
  id: string,
  file: File,
  signal: AbortSignal,
) {
  const problem = mediaFileProblem(file);
  const mime = mediaFileType(file);
  if (problem || !mime)
    throw new Error(problem ?? "Choose a supported media file.");
  const response = await mediaFetch(
    mediaLibraryUrl(orgId, id),
    {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": mime,
        "X-Media-Size": String(file.size),
        "X-Media-Name": encodeURIComponent(file.name),
      },
    },
    signal,
    MEDIA_UPLOAD_TIMEOUT_MS,
  );
  return mediaAssetSchema.parse(await response.json());
}

export async function deleteMedia(
  orgId: string,
  id: string,
  signal: AbortSignal,
) {
  await mediaFetch(mediaLibraryUrl(orgId, id), { method: "DELETE" }, signal);
}
