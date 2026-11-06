import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { handleMediaRequest, mediaStorageKey } from "../media-library.server";
import {
  MAX_MEDIA_BYTES,
  MEDIA_UPLOAD_TIMEOUT_MS,
  type MediaAsset,
  type MediaPage,
} from "../media-library";

const organizations: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const org of organizations.splice(0)) {
    const objects = await env.STORAGE.list({ prefix: `orgs/${org}/` });
    if (objects.objects.length)
      await env.STORAGE.delete(objects.objects.map((object) => object.key));
  }
});

function fixture() {
  const orgId = `media-test-${crypto.randomUUID()}`;
  organizations.push(orgId);
  const id = crypto.randomUUID();
  const authorize = vi.fn(async () => true);
  const call = (
    method: string,
    assetId: string | null = id,
    init: RequestInit = {},
    bucket = env.STORAGE,
  ) =>
    handleMediaRequest(
      new Request(
        `https://media.test/api/media/${orgId}${assetId ? `/${assetId}` : ""}`,
        { method, ...init },
      ),
      { bucket, orgId, id: assetId ?? undefined, authorize },
    );
  const bytes = new TextEncoder().encode(
    "RIFF1234WAVEabcdefghijklmnopqrstuvwxyz",
  );
  const upload = (assetId: string = id) =>
    call("PUT", assetId, {
      body: bytes,
      headers: {
        "content-type": "audio/wav",
        "x-media-size": String(bytes.length),
        "x-media-name": encodeURIComponent("Opening sting.wav"),
      },
    });
  return {
    orgId,
    id,
    authorize,
    call,
    bytes,
    upload,
    key: mediaStorageKey(orgId, id),
  };
}

it("stores an immutable media object with atomic metadata and lists it only in its organization", async () => {
  const test = fixture();
  const response = await test.upload();
  expect(response.status, await response.clone().text()).toBe(201);
  const asset = await response.json<MediaAsset>();
  expect(asset).toMatchObject({
    id: test.id,
    name: "Opening sting.wav",
    mimeType: "audio/wav",
    size: test.bytes.length,
  });
  expect(test.authorize).toHaveBeenCalledTimes(2);
  const page = await (await test.call("GET", null)).json<MediaPage>();
  expect(page.assets).toEqual([asset]);
  expect(page.cursor).toBeNull();
  const other = fixture();
  expect((await other.call("GET", test.id)).status).toBe(404);
  expect(
    (await (await other.call("GET", null)).json<MediaPage>()).assets,
  ).toEqual([]);
  const duplicate = await test.upload();
  expect(duplicate.status).toBe(409);
  expect(new Uint8Array(await (await test.call("GET")).arrayBuffer())).toEqual(
    test.bytes,
  );
});

it("streams full media and HEAD without a public cache", async () => {
  const test = fixture();
  await test.upload();
  const head = await test.call("HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("Content-Length")).toBe(String(test.bytes.length));
  expect(head.headers.get("Content-Type")).toBe("audio/wav");
  expect(head.headers.get("Cache-Control")).toBe("private, no-store");
  expect(head.headers.get("Accept-Ranges")).toBe("bytes");
  expect(head.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(head.headers.get("Content-Disposition")).toContain(
    "Opening%20sting.wav",
  );
});

it.each([
  ["bytes=4-11", 4, 12],
  ["bytes=12-", 12, 38],
  ["bytes=-5", 33, 38],
  ["bytes=30-9999", 30, 38],
])("serves an exact seek range %s", async (range, start, end) => {
  const test = fixture();
  await test.upload();
  // Fixture length is derived below so its content can change independently.
  const last = Math.min(end, test.bytes.length);
  const first = range.startsWith("bytes=-") ? test.bytes.length - 5 : start;
  const response = await test.call("GET", test.id, {
    headers: { Range: range },
  });
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe(
    `bytes ${first}-${last - 1}/${test.bytes.length}`,
  );
  expect(response.headers.get("Content-Length")).toBe(String(last - first));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    test.bytes.slice(first, last),
  );
});

it.each([
  "bytes=9999-",
  "bytes=9-2",
  "bytes=-0",
  "bytes=0-1,4-8",
  "bytes=-",
  "garbage",
  "bytes=9999999999999999999999-",
])("rejects unsatisfiable or malformed range %s", async (range) => {
  const test = fixture();
  await test.upload();
  const response = await test.call("GET", test.id, {
    headers: { Range: range },
  });
  expect(response.status).toBe(416);
  expect(response.headers.get("Content-Range")).toBe(
    `bytes */${test.bytes.length}`,
  );
});

it("honors If-Range and checks permission before either HEAD or ranged reads", async () => {
  const test = fixture();
  await test.upload();
  const etag = (await test.call("HEAD")).headers.get("etag")!;
  expect(
    (
      await test.call("GET", test.id, {
        headers: { Range: "bytes=0-3", "If-Range": etag },
      })
    ).status,
  ).toBe(206);
  const full = await test.call("GET", test.id, {
    headers: { Range: "bytes=0-3", "If-Range": '"old-file"' },
  });
  expect(full.status).toBe(200);
  expect((await full.arrayBuffer()).byteLength).toBe(test.bytes.length);
  test.authorize.mockResolvedValue(false);
  for (const method of ["GET", "HEAD", "DELETE", "PUT"])
    expect(
      (await test.call(method, test.id, { headers: { Range: "bytes=0-3" } }))
        .status,
    ).toBe(403);
  expect(await env.STORAGE.head(test.key)).not.toBeNull();
});

it("cleans up when access is revoked or the organization is removed during upload", async () => {
  const test = fixture();
  test.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect((await test.upload()).status).toBe(403);
  expect(await env.STORAGE.head(test.key)).toBeNull();
});

it("deletes idempotently without touching another workspace or other file types", async () => {
  const first = fixture(),
    second = fixture();
  await first.upload();
  await second.upload(first.id);
  const chatKey = `orgs/${first.orgId}/chat/${first.id}/keep.txt`;
  await env.STORAGE.put(chatKey, "keep");
  expect((await first.call("DELETE")).status).toBe(204);
  expect((await first.call("DELETE")).status).toBe(204);
  expect((await first.call("GET")).status).toBe(404);
  expect(
    await env.STORAGE.head(mediaStorageKey(second.orgId, first.id)),
  ).not.toBeNull();
  expect(await env.STORAGE.head(chatKey)).not.toBeNull();
});

it.each([
  ["text/html", "37", "RIFF1234WAVEabcdefghijklmnopqrstuvwxyz", 415],
  ["video/mp4", "38", "RIFF1234WAVEabcdefghijklmnopqrstuvwxyz", 415],
  ["audio/wav", "", "RIFF1234WAVEabcdefghijklmnopqrstuvwxyz", 400],
  [
    "audio/wav",
    String(MAX_MEDIA_BYTES + 1),
    "RIFF1234WAVEabcdefghijklmnopqrstuvwxyz",
    413,
  ],
  ["audio/wav", "100", "RIFF1234WAVEabcdefghijklmnopqrstuvwxyz", 400],
  ["audio/wav", "12", "RIFF1234WAVEabcdefghijklmnopqrstuvwxyz", 400],
])("does not save invalid upload %s / %s", async (type, size, body, status) => {
  const test = fixture();
  const response = await test.call("PUT", test.id, {
    headers: { "content-type": type, "x-media-size": size },
    body,
  });
  expect(response.status, await response.text()).toBe(status);
  expect(await env.STORAGE.head(test.key)).toBeNull();
});

it("does not commit a truncated file when excess bytes arrive in a later chunk", async () => {
  const test = fixture();
  let chunk = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk++ === 0) controller.enqueue(test.bytes);
      else if (chunk === 2) controller.enqueue(new Uint8Array([1]));
      else controller.close();
    },
  });
  const response = await test.call("PUT", test.id, {
    body,
    headers: {
      "content-type": "audio/wav",
      "x-media-size": String(test.bytes.length),
    },
  });
  expect(response.status, await response.text()).toBe(400);
  expect(await env.STORAGE.head(test.key)).toBeNull();
});

it("accepts streamed container headers split across chunks and normalizes filenames", async () => {
  const test = fixture();
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= test.bytes.length) controller.close();
      else controller.enqueue(test.bytes.slice(offset, ++offset));
    },
  });
  const response = await test.call("PUT", test.id, {
    body,
    headers: {
      "content-type": "audio/wav",
      "x-media-size": String(test.bytes.length),
      "x-media-name": encodeURIComponent(" ../Choir\u0000.wav "),
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  expect((await response.json<MediaAsset>()).name).toBe("..-Choir-.wav");
  expect(new Uint8Array(await (await test.call("GET")).arrayBuffer())).toEqual(
    test.bytes,
  );
});

it("cancels a stalled producer at the upload deadline without publishing a partial object", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const test = fixture();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const pending = test.call("PUT", test.id, {
    body,
    headers: { "content-type": "audio/wav", "x-media-size": "100" },
  });
  // Let the real R2 head check finish before advancing only the deadline clock.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(MEDIA_UPLOAD_TIMEOUT_MS);
  const response = await pending;
  expect(response.status, await response.text()).toBe(408);
  expect(cancelled).toBe(true);
  expect(await env.STORAGE.head(test.key)).toBeNull();
});

it("returns a storage error and cancels input when R2 fails before consuming it", async () => {
  const test = fixture();
  let cancelled = false;
  const bucket = new Proxy(env.STORAGE, {
    get(target, property) {
      if (property === "put")
        return () => Promise.reject(new Error("Injected storage outage"));
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(test.bytes);
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await test.call(
    "PUT",
    test.id,
    {
      body,
      headers: {
        "content-type": "audio/wav",
        "x-media-size": String(test.bytes.length),
      },
    },
    bucket,
  );
  expect(response.status, await response.text()).toBe(503);
  expect(cancelled).toBe(true);
  expect(await env.STORAGE.head(test.key)).toBeNull();
});

it("paginates the actual R2 library without leaking a second organization's files", async () => {
  const test = fixture(),
    other = fixture();
  const ids = Array.from({ length: 53 }, () => crypto.randomUUID()).sort();
  await Promise.all(
    ids.map((id) =>
      env.STORAGE.put(mediaStorageKey(test.orgId, id), test.bytes, {
        httpMetadata: { contentType: "audio/wav" },
        customMetadata: { name: `${id}.wav` },
      }),
    ),
  );
  await other.upload();
  const first = await (await test.call("GET", null)).json<MediaPage>();
  expect(first.assets).toHaveLength(50);
  expect(first.cursor).toBeTypeOf("string");
  const request = new Request(
    `https://media.test/api/media/${test.orgId}?cursor=${encodeURIComponent(first.cursor!)}`,
  );
  const second = await (
    await handleMediaRequest(request, {
      bucket: env.STORAGE,
      orgId: test.orgId,
      authorize: test.authorize,
    })
  ).json<MediaPage>();
  expect(second.assets).toHaveLength(3);
  expect(second.cursor).toBeNull();
  expect([...first.assets, ...second.assets].map((asset) => asset.id)).toEqual(
    ids,
  );
});

it("allows only one concurrent upload to claim an immutable asset ID", async () => {
  const test = fixture();
  const responses = await Promise.all([test.upload(), test.upload()]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);
  expect(new Uint8Array(await (await test.call("GET")).arrayBuffer())).toEqual(
    test.bytes,
  );
});

it("cleans up a committed upload if the final authority check cannot complete", async () => {
  const test = fixture();
  test.authorize
    .mockResolvedValueOnce(true)
    .mockRejectedValue(new Error("Database unavailable"));
  const response = await test.upload();
  expect(response.status).toBe(503);
  expect(await env.STORAGE.head(test.key)).toBeNull();
});

it("does not publish an interrupted request body", async () => {
  const test = fixture();
  let chunk = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk++ === 0) controller.enqueue(test.bytes.subarray(0, 20));
      else controller.error(new Error("Connection ended"));
    },
  });
  const response = await test.call("PUT", test.id, {
    body,
    headers: {
      "content-type": "audio/wav",
      "x-media-size": String(test.bytes.length),
    },
  });
  expect(response.status, await response.text()).toBe(400);
  expect(await env.STORAGE.head(test.key)).toBeNull();
});

it("accepts venue/LAN browser IDs but rejects path traversal before storage", async () => {
  const test = fixture();
  expect((await test.upload("1ql8s24-2abdf4g-1a4b3c6-1abcxyz")).status).toBe(
    201,
  );
  for (const id of ["..", "../chat/file", "%2Fsecret", "a".repeat(65)])
    expect((await test.call("GET", id)).status).toBe(404);
});

it("rejects a file replacement between metadata lookup and a ranged read", async () => {
  const test = fixture();
  await test.upload();
  const bucket = new Proxy(env.STORAGE, {
    get(target, property) {
      if (property === "get")
        return async (key: string, options?: R2GetOptions) => {
          await target.delete(key);
          await target.put(key, "RIFF1234WAVEnew media", {
            httpMetadata: { contentType: "audio/wav" },
            customMetadata: { name: "Replacement.wav" },
          });
          return target.get(key, options);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await test.call(
    "GET",
    test.id,
    { headers: { Range: "bytes=0-11" } },
    bucket,
  );
  expect(response.status, await response.text()).toBe(412);
});
