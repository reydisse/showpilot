import {
  MAX_MEDIA_BYTES,
  MEDIA_UPLOAD_TIMEOUT_MS,
  mediaAssetSchema,
  mediaHeaderMatches,
  mediaIdSchema,
  mediaMimeSchema,
  parseMediaRange,
  safeMediaName,
  type MediaAsset,
  type MediaMime,
} from "./media-library";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const fail = (message: string, status: number) =>
  new Response(message, { status, headers: privateHeaders });

export function mediaStorageKey(orgId: string, id: string): string {
  return `orgs/${orgId}/media/${id}`;
}

function describeMedia(object: R2Object, id: string): MediaAsset {
  return mediaAssetSchema.parse({
    id,
    name: object.customMetadata?.name,
    mimeType: object.httpMetadata?.contentType,
    size: object.size,
    uploadedAt: object.uploaded.toISOString(),
    etag: object.httpEtag,
  });
}

class MediaUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Stream directly into an atomic R2 object. Never buffer a whole video in the Worker. */
async function putMedia(
  request: Request,
  bucket: R2Bucket,
  key: string,
  options: {
    size: number;
    name: string;
    mime: MediaMime;
  },
): Promise<R2Object | null> {
  if (!request.body) throw new MediaUploadError("Choose a media file.", 400);
  const reader = request.body.getReader();
  const stream = new FixedLengthStream(options.size);
  const writer = stream.writable.getWriter();
  let interrupted: MediaUploadError | null = null;
  const abort = (error: MediaUploadError) => {
    interrupted ??= error;
    void reader.cancel(error).catch(() => {});
    void stream.readable.cancel(error).catch(() => {});
    void writer.abort(error).catch(() => {});
  };
  const cancel = () =>
    abort(
      new MediaUploadError("Upload cancelled. Refresh the media library to check whether it finished.", 400),
    );
  const timer = setTimeout(
    () =>
      abort(
        new MediaUploadError(
          "Upload timed out. Try a smaller file or a faster connection.",
          408,
        ),
      ),
    MEDIA_UPLOAD_TIMEOUT_MS,
  );
  request.signal.addEventListener("abort", cancel, { once: true });
  // R2 must consume the fixed-length stream while the producer writes to it.
  const store = bucket.put(key, stream.readable, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: options.mime },
    customMetadata: { name: options.name },
  });
  const produce = (async () => {
    let total = 0;
    const header = new Uint8Array(12);
    let headerSize = 0;
    let checked = false;
    let lastByte: Uint8Array | undefined;
    try {
      if (request.signal.aborted) cancel();
      while (true) {
        const { done, value } = await reader.read().catch(() => {
          throw new MediaUploadError(
            "Upload interrupted. Refresh the media library before retrying.",
            400,
          );
        });
        if (interrupted) throw interrupted;
        if (done) break;
        total += value.byteLength;
        if (total > options.size)
          throw new MediaUploadError(
            "The upload size does not match the file. Choose the file again.",
            400,
          );
        const count = Math.min(header.length - headerSize, value.byteLength);
        header.set(value.subarray(0, count), headerSize);
        headerSize += count;
        if (!checked && headerSize === header.length) {
          if (!mediaHeaderMatches(header, options.mime))
            throw new MediaUploadError(
              "The file contents do not match a supported media format.",
              415,
            );
          checked = true;
        }
        if (value.byteLength > 0) {
          // R2 may commit once it receives the declared byte count. Hold one
          // byte until EOF so an overlong body cannot leave a truncated asset.
          if (lastByte) await writer.write(lastByte);
          if (value.byteLength > 1)
            await writer.write(value.subarray(0, value.byteLength - 1));
          lastByte = value.slice(-1);
        }
      }
      if (total !== options.size || !checked)
        throw new MediaUploadError(
          "The upload was incomplete. Choose the file again.",
          400,
        );
      if (lastByte) await writer.write(lastByte);
      await writer.close();
    } catch (error) {
      if (error instanceof MediaUploadError) interrupted ??= error;
      void reader.cancel(error).catch(() => {});
      await writer.abort(error).catch(() => {});
      throw error;
    }
  })();
  // Install both rejection handlers immediately. If R2 fails or the object
  // already exists, cancel the producer instead of leaving it backpressured.
  const guardedStore = store.then(
    (value) => {
      if (!value)
        abort(
          new MediaUploadError(
            "This upload already exists. Refresh the media library before trying again.",
            409,
          ),
        );
      return value;
    },
    (error) => {
      abort(
        new MediaUploadError(
          "Media storage is unavailable. Retry the upload.",
          503,
        ),
      );
      throw error;
    },
  );
  try {
    const [stored, produced] = await Promise.allSettled([
      guardedStore,
      produce,
    ]);
    if (interrupted) throw interrupted;
    if (produced.status === "rejected") throw produced.reason;
    if (stored.status === "rejected") throw stored.reason;
    return stored.value;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
    writer.releaseLock();
  }
}

/** The gateway resolves the organization and checks a fresh session/permission.
 * Rechecking after upload closes the organization-deletion race. */
export async function handleMediaRequest(
  request: Request,
  options: {
    bucket: R2Bucket;
    orgId: string;
    id?: string;
    authorize: () => Promise<boolean>;
  },
): Promise<Response> {
  const { bucket, orgId, id, authorize } = options;
  if (id !== undefined && !mediaIdSchema.safeParse(id).success)
    return fail("Media not found.", 404);
  const allowed = id ? ["GET", "HEAD", "PUT", "DELETE"] : ["GET"];
  if (!allowed.includes(request.method))
    return fail("Method not allowed.", 405);
  if (!(await authorize()))
    return fail("Sign in with timecode access to use this media library.", 403);
  try {
    if (!id) {
      const cursor =
        new URL(request.url).searchParams.get("cursor") ?? undefined;
      if (cursor && cursor.length > 2048)
        return fail("Invalid media page.", 400);
      const prefix = mediaStorageKey(orgId, "");
      const page = await bucket.list({
        prefix,
        cursor,
        limit: 50,
        include: ["httpMetadata", "customMetadata"],
      });
      return Response.json(
        {
          assets: page.objects.map((object) =>
            describeMedia(object, object.key.slice(prefix.length)),
          ),
          cursor: page.truncated ? page.cursor : null,
        },
        { headers: privateHeaders },
      );
    }
    const key = mediaStorageKey(orgId, id);
    if (request.method === "PUT") {
      const mime = mediaMimeSchema.safeParse(
        request.headers.get("content-type")?.split(";")[0].trim().toLowerCase(),
      );
      if (!mime.success)
        return fail("Choose an MP4, WebM, MP3, WAV or Ogg file.", 415);
      const declared = request.headers.get("x-media-size") ?? "";
      const size = /^\d+$/.test(declared) ? Number(declared) : NaN;
      if (!Number.isSafeInteger(size) || size < 12)
        return fail("Provide the media file size.", 400);
      if (size > MAX_MEDIA_BYTES)
        return fail("Media files must be 95 MB or smaller.", 413);
      const length = request.headers.get("content-length");
      if (length !== null && Number(length) !== size)
        return fail("The upload size does not match the file.", 400);
      let name: string;
      try {
        name = safeMediaName(
          decodeURIComponent(request.headers.get("x-media-name") ?? ""),
        );
      } catch {
        return fail("Invalid media filename.", 400);
      }
      // An existing asset is immutable. A lost response can never overwrite it.
      if (await bucket.head(key))
        return fail(
          "This upload already exists. Refresh the media library before trying again.",
          409,
        );
      const object = await putMedia(request, bucket, key, {
        size,
        name,
        mime: mime.data,
      });
      if (!object)
        return fail(
          "This upload already exists. Refresh the media library before trying again.",
          409,
        );
      let stillAuthorized: boolean;
      try {
        stillAuthorized = await authorize();
      } catch (error) {
        await bucket.delete(key);
        throw error;
      }
      if (!stillAuthorized) {
        await bucket.delete(key);
        return fail(
          "Access changed during upload. The file was not saved.",
          403,
        );
      }
      return Response.json(describeMedia(object, id), {
        status: 201,
        headers: privateHeaders,
      });
    }
    if (request.method === "DELETE") {
      await bucket.delete(key);
      return new Response(null, { status: 204, headers: privateHeaders });
    }
    const metadata = await bucket.head(key);
    if (!metadata)
      return fail("Media not found. It may have been removed.", 404);
    const asset = describeMedia(metadata, id);
    const headers = new Headers(privateHeaders);
    headers.set("Content-Type", asset.mimeType);
    headers.set(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    );
    headers.set("Accept-Ranges", "bytes");
    headers.set("ETag", metadata.httpEtag);
    headers.set("Content-Length", String(asset.size));
    if (request.method === "HEAD") return new Response(null, { headers });
    const requested = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    const range =
      requested && (!ifRange || ifRange === metadata.httpEtag)
        ? parseMediaRange(requested, asset.size)
        : undefined;
    if (range === null) {
      headers.set("Content-Range", `bytes */${asset.size}`);
      headers.delete("Content-Length");
      return new Response(null, { status: 416, headers });
    }
    const object = await bucket.get(key, {
      ...(range ? { range } : {}),
      onlyIf: { etagMatches: metadata.etag },
    });
    if (!object) return fail("Media not found. It may have been removed.", 404);
    if (!("body" in object))
      return fail(
        "Media changed during the request. Reload the media library.",
        412,
      );
    if (range) {
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size}`,
      );
      headers.set("Content-Length", String(range.length));
    }
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof MediaUploadError)
      return fail(error.message, error.status);
    console.error("media-library-request-failed", {
      orgId,
      id,
      method: request.method,
    });
    return fail("Media storage is unavailable. Try again.", 503);
  }
}
